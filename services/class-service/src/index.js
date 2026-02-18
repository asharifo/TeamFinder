const fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Kafka } = require("kafkajs");

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    base: { service: "class-service" },
  },
});

const port = Number(process.env.PORT || 3003);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ingestToken = process.env.INGEST_TOKEN || "dev-ingest-token";

let producer = null;

function getRequesterUserId(request) {
  const raw = request.headers["x-user-id"];
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim();
  return normalized || null;
}

function requireRequesterUserId(request, reply) {
  const userId = getRequesterUserId(request);
  if (!userId) {
    reply.code(401).send({ error: "missing authenticated user context" });
    return null;
  }
  return userId;
}

function normalizeClassId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function clampLimit(raw, fallback = 50, max = 200) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

async function connectProducer() {
  const broker = process.env.KAFKA_BROKER;
  if (!broker) {
    app.log.warn("KAFKA_BROKER is not set; events are disabled");
    return;
  }

  try {
    const kafka = new Kafka({ clientId: "class-service", brokers: [broker] });
    producer = kafka.producer();
    await producer.connect();
    app.log.info("connected to kafka");
  } catch (error) {
    producer = null;
    app.log.error({ error }, "failed to connect kafka producer; continuing without events");
  }
}

async function publish(topic, key, payload) {
  if (!producer) {
    return;
  }

  try {
    await producer.send({
      topic,
      messages: [
        {
          key,
          value: JSON.stringify({ ...payload, occurredAt: new Date().toISOString() }),
        },
      ],
    });
  } catch (error) {
    app.log.error({ error, topic }, "failed to publish event");
  }
}

async function loadGroup(groupId, client = pool) {
  const result = await client.query(
    `SELECT id, class_id, owner_user_id, name, project_section, created_at
     FROM groups
     WHERE id = $1`,
    [groupId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", service: "class-service" };
});

app.get("/", async (request) => {
  const qText = typeof request.query.q === "string" ? request.query.q.trim() : "";
  const termText = typeof request.query.term === "string" ? request.query.term.trim() : "";
  const limit = clampLimit(request.query.limit, 50, 200);

  const q = `%${qText}%`;
  const term = `%${termText}%`;

  const result = await pool.query(
    `SELECT id, title, term, description
     FROM classes
     WHERE ($1 = '' OR id ILIKE $2 OR title ILIKE $2 OR description ILIKE $2)
       AND ($3 = '' OR term ILIKE $4)
     ORDER BY id
     LIMIT $5`,
    [qText, q, termText, term, limit],
  );

  return { classes: result.rows };
});

app.post("/ingest", async (request, reply) => {
  const providedToken = request.headers["x-ingest-token"];
  if (!providedToken || providedToken !== ingestToken) {
    return reply.code(403).send({ error: "invalid ingest token" });
  }

  const body = request.body || {};
  const incoming = Array.isArray(body.classes) ? body.classes : [];

  if (incoming.length === 0) {
    return reply.code(400).send({ error: "classes array is required" });
  }

  const client = await pool.connect();
  let upserted = 0;
  try {
    await client.query("BEGIN");

    for (const item of incoming) {
      const id = normalizeClassId(item.id);
      const title = String(item.title || "").trim();
      const term = String(item.term || "").trim() || "TBD";
      const description = String(item.description || "").trim();

      if (!id || !title) {
        continue;
      }

      await client.query(
        `INSERT INTO classes (id, title, term, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id)
         DO UPDATE SET title = EXCLUDED.title,
                       term = EXCLUDED.term,
                       description = EXCLUDED.description`,
        [id, title, term, description],
      );
      upserted += 1;
    }

    await client.query("COMMIT");
    return reply.send({ received: incoming.length, upserted });
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to ingest class catalog");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/enrollments", async (request, reply) => {
  const userId = requireRequesterUserId(request, reply);
  if (!userId) {
    return;
  }

  const classId = normalizeClassId((request.body || {}).classId);
  if (!classId) {
    return reply.code(400).send({ error: "classId is required" });
  }

  const classResult = await pool.query("SELECT id FROM classes WHERE id = $1", [classId]);
  if (classResult.rowCount === 0) {
    return reply.code(404).send({ error: "class not found" });
  }

  await pool.query(
    `INSERT INTO enrollments (user_id, class_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, class_id) DO NOTHING`,
    [userId, classId],
  );

  await publish("class.enrollment.created", classId, {
    userId,
    classId,
  });

  return reply.code(201).send({ enrolled: true, userId, classId });
});

app.get("/:classId/members", async (request, reply) => {
  const classId = normalizeClassId(request.params.classId);

  const classResult = await pool.query("SELECT id, title, term FROM classes WHERE id = $1", [classId]);
  if (classResult.rowCount === 0) {
    return reply.code(404).send({ error: "class not found" });
  }

  const members = await pool.query(
    `SELECT user_id, created_at
     FROM enrollments
     WHERE class_id = $1
     ORDER BY created_at ASC`,
    [classId],
  );

  return {
    class: classResult.rows[0],
    members: members.rows,
  };
});

app.get("/:classId/groups", async (request, reply) => {
  const classId = normalizeClassId(request.params.classId);

  const classResult = await pool.query("SELECT id, title, term FROM classes WHERE id = $1", [classId]);
  if (classResult.rowCount === 0) {
    return reply.code(404).send({ error: "class not found" });
  }

  const groups = await pool.query(
    `SELECT g.id, g.class_id, g.name, g.project_section, g.owner_user_id, g.created_at,
            COALESCE(array_agg(gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '{}') AS members
     FROM groups g
     LEFT JOIN group_members gm ON gm.group_id = g.id
     WHERE g.class_id = $1
     GROUP BY g.id
     ORDER BY g.created_at DESC`,
    [classId],
  );

  return { groups: groups.rows };
});

app.post("/:classId/groups", async (request, reply) => {
  const ownerUserId = requireRequesterUserId(request, reply);
  if (!ownerUserId) {
    return;
  }

  const classId = normalizeClassId(request.params.classId);
  const { name, projectSection } = request.body || {};

  if (!name || !projectSection) {
    return reply.code(400).send({ error: "name and projectSection are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const classResult = await client.query("SELECT id FROM classes WHERE id = $1", [classId]);
    if (classResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "class not found" });
    }

    const groupResult = await client.query(
      `INSERT INTO groups (class_id, name, project_section, owner_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, class_id, name, project_section, owner_user_id, created_at`,
      [classId, String(name).trim(), String(projectSection).trim(), ownerUserId],
    );

    const group = groupResult.rows[0];

    await client.query(
      `INSERT INTO group_members (group_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [group.id, ownerUserId],
    );

    await client.query("COMMIT");

    await publish("group.created", classId, {
      groupId: group.id,
      classId,
      ownerUserId,
      projectSection: group.project_section,
    });

    return reply.code(201).send({ group });
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to create group");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/groups/:groupId/requests", async (request, reply) => {
  const userId = requireRequesterUserId(request, reply);
  if (!userId) {
    return;
  }

  const { groupId } = request.params;

  const group = await loadGroup(groupId);
  if (!group) {
    return reply.code(404).send({ error: "group not found" });
  }

  await pool.query(
    `INSERT INTO group_requests (group_id, user_id, status)
     VALUES ($1, $2, 'PENDING')
     ON CONFLICT (group_id, user_id)
     DO UPDATE SET status = 'PENDING', created_at = NOW()`,
    [groupId, userId],
  );

  await publish("group.join.requested", groupId, {
    groupId,
    classId: group.class_id,
    userId,
  });

  return reply.code(201).send({ requested: true, groupId, userId });
});

app.get("/groups/:groupId/requests", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId } = request.params;
  const group = await loadGroup(groupId);
  if (!group) {
    return reply.code(404).send({ error: "group not found" });
  }

  if (group.owner_user_id !== requesterId) {
    return reply.code(403).send({ error: "only group owner can view requests" });
  }

  const status = String(request.query.status || "PENDING").toUpperCase();
  const statusFilter = ["PENDING", "APPROVED", "REJECTED", "ALL"].includes(status) ? status : "PENDING";

  const sql =
    statusFilter === "ALL"
      ? `SELECT group_id, user_id, status, created_at FROM group_requests WHERE group_id = $1 ORDER BY created_at DESC`
      : `SELECT group_id, user_id, status, created_at FROM group_requests WHERE group_id = $1 AND status = $2 ORDER BY created_at DESC`;

  const params = statusFilter === "ALL" ? [groupId] : [groupId, statusFilter];
  const result = await pool.query(sql, params);

  return { groupId, status: statusFilter, requests: result.rows };
});

app.post("/groups/:groupId/requests/:userId/approve", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId, userId } = request.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const group = await loadGroup(groupId, client);
    if (!group) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "group not found" });
    }

    if (group.owner_user_id !== requesterId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "only group owner can approve requests" });
    }

    const reqResult = await client.query(
      `UPDATE group_requests
       SET status = 'APPROVED'
       WHERE group_id = $1 AND user_id = $2
       RETURNING group_id, user_id, status`,
      [groupId, userId],
    );

    if (reqResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "join request not found" });
    }

    await client.query(
      `INSERT INTO group_members (group_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, userId],
    );

    await client.query("COMMIT");

    await publish("group.member.added", groupId, {
      groupId,
      classId: group.class_id,
      userId,
    });

    return reply.send({ approved: true, groupId, userId });
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to approve group request");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/groups/:groupId/requests/:userId/reject", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId, userId } = request.params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const group = await loadGroup(groupId, client);
    if (!group) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "group not found" });
    }

    if (group.owner_user_id !== requesterId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "only group owner can reject requests" });
    }

    const reqResult = await client.query(
      `UPDATE group_requests
       SET status = 'REJECTED'
       WHERE group_id = $1 AND user_id = $2
       RETURNING group_id, user_id, status`,
      [groupId, userId],
    );

    if (reqResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "join request not found" });
    }

    await client.query("COMMIT");

    await publish("group.request.rejected", groupId, {
      groupId,
      classId: group.class_id,
      userId,
    });

    return reply.send({ rejected: true, groupId, userId });
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to reject group request");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }
});

async function start() {
  await app.register(cors, { origin: true });
  await connectProducer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start class-service");
  process.exit(1);
});
