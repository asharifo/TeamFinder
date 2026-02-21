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
const ingestToken = String(process.env.INGEST_TOKEN || "").trim();
const defaultSectionMaxGroupSize = Math.min(
  Math.max(Number(process.env.DEFAULT_SECTION_MAX_GROUP_SIZE || 4) || 4, 2),
  20,
);
const autoSeedCatalog = String(process.env.CLASS_AUTO_SEED || "true").toLowerCase() !== "false";
const userProjectionConsumerGroup = String(process.env.USER_PROJECTION_CONSUMER_GROUP || "class-user-projection-v1").trim() || "class-user-projection-v1";
const userProjectionTopics = ["user.identity.upserted", "user.profile.upserted", "user.authenticated", "profile.updated"];

const defaultCatalogSeed = [
  { id: "CPSC 110", title: "Computation, Programs, and Programming", term: "2026W", description: "Introductory programming and problem solving." },
  { id: "CPSC 121", title: "Models of Computation", term: "2026W", description: "Logic, proofs, and computational models." },
  { id: "CPSC 210", title: "Software Construction", term: "2026W", description: "Object-oriented software development fundamentals." },
  { id: "CPSC 221", title: "Basic Algorithms and Data Structures", term: "2026W", description: "Core data structures and algorithmic techniques." },
  { id: "CPSC 310", title: "Introduction to Software Engineering", term: "2026W", description: "Team-based software engineering process." },
  { id: "CPSC 320", title: "Intermediate Algorithm Design and Analysis", term: "2026W", description: "Advanced algorithm design and complexity analysis." },
  { id: "ELEC 221", title: "Basic Circuits and Electronics", term: "2026W", description: "Circuits, devices, and electrical systems." },
  { id: "MATH 221", title: "Matrix Algebra", term: "2026W", description: "Linear algebra, matrices, and vector spaces." },
];

let producer = null;
let userProjectionConsumerRunning = false;

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

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
}

function clampLimit(raw, fallback = 50, max = 200) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function toMaxGroupSize(raw, fallback = defaultSectionMaxGroupSize) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), 2), 20);
}

function uniqueUserIds(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const userId = normalizeText(value);
    if (!userId || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    out.push(userId);
  }
  return out;
}

function formatSection(section) {
  const maxGroupSize = Number(section.max_group_size || defaultSectionMaxGroupSize);
  const groupCount = Number(section.group_count || 0);
  return {
    id: section.id,
    classId: section.class_id,
    class_id: section.class_id,
    name: section.name,
    description: section.description || "",
    maxGroupSize,
    max_group_size: maxGroupSize,
    groupCount,
    group_count: groupCount,
    createdByUserId: section.created_by_user_id,
    created_by_user_id: section.created_by_user_id,
    createdAt: section.created_at,
    created_at: section.created_at,
  };
}

function formatGroup(group) {
  const members = Array.isArray(group.members) ? group.members : [];
  const memberCount = Number(group.member_count || members.length || 0);
  const maxGroupSize = Number(group.max_group_size || defaultSectionMaxGroupSize);
  const sectionName = group.project_section_name || group.project_section || "";

  return {
    id: group.id,
    classId: group.class_id,
    class_id: group.class_id,
    name: group.name,
    ownerUserId: group.owner_user_id,
    owner_user_id: group.owner_user_id,
    projectSectionId: group.project_section_id || null,
    project_section_id: group.project_section_id || null,
    projectSection: group.project_section || sectionName,
    project_section: group.project_section || sectionName,
    projectSectionName: sectionName,
    project_section_name: sectionName,
    projectSectionDescription: group.project_section_description || "",
    project_section_description: group.project_section_description || "",
    maxGroupSize,
    max_group_size: maxGroupSize,
    memberCount,
    member_count: memberCount,
    isFull: memberCount >= maxGroupSize,
    is_full: memberCount >= maxGroupSize,
    members,
    createdAt: group.created_at,
    created_at: group.created_at,
  };
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

async function ensureSchema() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS project_sections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      max_group_size INTEGER NOT NULL DEFAULT 4 CHECK (max_group_size >= 2 AND max_group_size <= 20),
      created_by_user_id TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (class_id, name)
    )`,
  );

  await pool.query(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS project_section_id UUID`);

  await pool.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (
         SELECT 1
         FROM pg_constraint
         WHERE conname = 'groups_project_section_id_fkey'
       ) THEN
         ALTER TABLE groups
         ADD CONSTRAINT groups_project_section_id_fkey
         FOREIGN KEY (project_section_id)
         REFERENCES project_sections(id)
         ON DELETE SET NULL;
       END IF;
     END $$`,
  );

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_groups_class_id ON groups (class_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_groups_project_section_id ON groups (project_section_id)`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS user_directory (
      user_id TEXT PRIMARY KEY,
      user_name TEXT NOT NULL DEFAULT '',
      user_email TEXT NOT NULL DEFAULT '',
      profile_picture_url TEXT NOT NULL DEFAULT '',
      about TEXT NOT NULL DEFAULT '',
      skills TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_directory_name ON user_directory (user_name)`);

  await pool.query(
    `INSERT INTO project_sections (class_id, name, description, max_group_size, created_by_user_id)
     SELECT DISTINCT g.class_id, g.project_section, '', $1::int, 'system'
     FROM groups g
     WHERE COALESCE(g.project_section, '') <> ''
     ON CONFLICT (class_id, name) DO NOTHING`,
    [defaultSectionMaxGroupSize],
  );

  await pool.query(
    `UPDATE groups g
     SET project_section_id = ps.id
     FROM project_sections ps
     WHERE g.project_section_id IS NULL
       AND g.class_id = ps.class_id
       AND g.project_section = ps.name`,
  );
}

async function ensureCatalogSeeded() {
  if (!autoSeedCatalog) {
    return;
  }

  const countResult = await pool.query(`SELECT COUNT(*)::int AS count FROM classes`);
  const classCount = Number(countResult.rows[0]?.count || 0);
  if (classCount > 0) {
    return;
  }

  for (const item of defaultCatalogSeed) {
    await pool.query(
      `INSERT INTO classes (id, title, term, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id)
       DO UPDATE SET title = EXCLUDED.title,
                     term = EXCLUDED.term,
                     description = EXCLUDED.description`,
      [normalizeClassId(item.id), normalizeText(item.title), normalizeText(item.term), normalizeText(item.description)],
    );
  }

  app.log.info({ seeded: defaultCatalogSeed.length }, "class catalog seeded");
}

async function upsertIdentityProjection(payload) {
  const userId = normalizeText(payload.userId || payload.user_id || "");
  if (!userId) {
    return;
  }

  const userName = normalizeText(payload.userName || payload.name || "");
  const userEmail = normalizeText(payload.userEmail || payload.email || "");

  await pool.query(
    `INSERT INTO user_directory (user_id, user_name, user_email, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET user_name = CASE
                                  WHEN EXCLUDED.user_name <> '' THEN EXCLUDED.user_name
                                  ELSE user_directory.user_name
                                END,
                   user_email = CASE
                                  WHEN EXCLUDED.user_email <> '' THEN EXCLUDED.user_email
                                  ELSE user_directory.user_email
                                END,
                   updated_at = NOW()`,
    [userId, userName, userEmail],
  );
}

async function upsertProfileProjection(payload) {
  const userId = normalizeText(payload.userId || payload.user_id || "");
  if (!userId) {
    return;
  }

  const userName = normalizeText(payload.userName || payload.name || "");
  const userEmail = normalizeText(payload.userEmail || payload.email || "");
  const profilePictureUrl = normalizeOptionalText(payload.profilePictureUrl || payload.profile_picture_url);
  const about = normalizeOptionalText(payload.about);
  const skills = Array.isArray(payload.skills)
    ? payload.skills.map((item) => String(item).trim()).filter(Boolean)
    : null;

  await pool.query(
    `INSERT INTO user_directory (user_id, user_name, user_email, profile_picture_url, about, skills, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, ''), COALESCE($5, ''), COALESCE($6::text[], '{}'), NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET user_name = CASE
                                  WHEN EXCLUDED.user_name <> '' THEN EXCLUDED.user_name
                                  ELSE user_directory.user_name
                                END,
                   user_email = CASE
                                  WHEN EXCLUDED.user_email <> '' THEN EXCLUDED.user_email
                                  ELSE user_directory.user_email
                                END,
                   profile_picture_url = COALESCE($4, user_directory.profile_picture_url),
                   about = COALESCE($5, user_directory.about),
                   skills = COALESCE($6::text[], user_directory.skills),
                   updated_at = NOW()`,
    [userId, userName, userEmail, profilePictureUrl, about, skills],
  );
}

async function handleUserProjectionEvent(topic, payload) {
  if (!payload) {
    return;
  }

  if (topic === "user.identity.upserted" || topic === "user.authenticated") {
    await upsertIdentityProjection(payload);
    return;
  }

  if (topic === "user.profile.upserted" || topic === "profile.updated") {
    await upsertProfileProjection(payload);
  }
}

async function ensureUserProjectionTopics(kafka) {
  const admin = kafka.admin();
  try {
    await admin.connect();
    const metadata = await admin.fetchTopicMetadata();
    const existingTopics = new Set((metadata.topics || []).map((topic) => topic.name));
    const missingTopics = userProjectionTopics.filter((topic) => !existingTopics.has(topic));

    if (missingTopics.length === 0) {
      return;
    }

    await admin.createTopics({
      waitForLeaders: true,
      topics: missingTopics.map((topic) => ({
        topic,
        numPartitions: 1,
        replicationFactor: 1,
      })),
    });
  } catch (error) {
    app.log.warn({ error }, "failed to ensure user projection topics");
  } finally {
    try {
      await admin.disconnect();
    } catch (_error) {
      // noop
    }
  }
}

async function startUserProjectionConsumer() {
  const broker = process.env.KAFKA_BROKER;
  if (!broker) {
    app.log.warn("KAFKA_BROKER is not set; user projection consumer disabled");
    return;
  }

  const kafka = new Kafka({ clientId: "class-service-user-projection", brokers: [broker] });
  const consumer = kafka.consumer({ groupId: userProjectionConsumerGroup });

  try {
    await ensureUserProjectionTopics(kafka);
    await consumer.connect();
    for (const topic of userProjectionTopics) {
      await consumer.subscribe({ topic, fromBeginning: true });
    }

    consumer
      .run({
        eachMessage: async ({ topic, message }) => {
          const text = message.value ? message.value.toString("utf8") : "";
          if (!text) {
            return;
          }

          let payload;
          try {
            payload = JSON.parse(text);
          } catch (_error) {
            app.log.warn({ topic, text }, "received invalid json projection event");
            return;
          }

          try {
            await handleUserProjectionEvent(topic, payload);
          } catch (error) {
            app.log.error({ error, topic, payload }, "failed to process user projection event");
          }
        },
      })
      .catch((error) => {
        userProjectionConsumerRunning = false;
        app.log.error({ error }, "user projection consumer crashed");
      });

    userProjectionConsumerRunning = true;
    app.log.info({ topics: userProjectionTopics, groupId: userProjectionConsumerGroup }, "user projection consumer is running");
  } catch (error) {
    app.log.error({ error }, "failed to start user projection consumer");
  }
}

async function loadClass(classId, client = pool) {
  const result = await client.query(`SELECT id, title, term FROM classes WHERE id = $1`, [classId]);
  if (result.rowCount === 0) {
    return null;
  }
  return result.rows[0];
}

async function isEnrolled(classId, userId, client = pool) {
  const result = await client.query(
    `SELECT 1
     FROM enrollments
     WHERE class_id = $1 AND user_id = $2`,
    [classId, userId],
  );
  return result.rowCount > 0;
}

async function loadGroup(groupId, client = pool) {
  if (!looksLikeUuid(groupId)) {
    return null;
  }

  const result = await client.query(
    `SELECT g.id,
            g.class_id,
            g.owner_user_id,
            g.name,
            g.project_section,
            g.project_section_id,
            g.created_at,
            COALESCE(ps.name, g.project_section) AS project_section_name,
            COALESCE(ps.description, '') AS project_section_description,
            COALESCE(ps.max_group_size, $2) AS max_group_size,
            COUNT(gm.user_id)::int AS member_count,
            COALESCE(array_agg(gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '{}') AS members
     FROM groups g
     LEFT JOIN project_sections ps ON ps.id = g.project_section_id
     LEFT JOIN group_members gm ON gm.group_id = g.id
     WHERE g.id = $1
     GROUP BY g.id, ps.id`,
    [groupId, defaultSectionMaxGroupSize],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}

async function loadGroupForUpdate(groupId, client) {
  if (!looksLikeUuid(groupId)) {
    return null;
  }

  const result = await client.query(
    `SELECT g.id,
            g.class_id,
            g.owner_user_id,
            g.name,
            g.project_section,
            g.project_section_id,
            g.created_at,
            COALESCE(
              (SELECT ps.name FROM project_sections ps WHERE ps.id = g.project_section_id),
              g.project_section
            ) AS project_section_name,
            COALESCE(
              (SELECT ps.description FROM project_sections ps WHERE ps.id = g.project_section_id),
              ''
            ) AS project_section_description,
            COALESCE(
              (SELECT ps.max_group_size FROM project_sections ps WHERE ps.id = g.project_section_id),
              $2
            ) AS max_group_size
     FROM groups g
     WHERE g.id = $1
     FOR UPDATE`,
    [groupId, defaultSectionMaxGroupSize],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}

async function countGroupMembers(groupId, client = pool) {
  if (!looksLikeUuid(groupId)) {
    return 0;
  }

  const result = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM group_members
     WHERE group_id = $1`,
    [groupId],
  );
  return Number(result.rows[0]?.count || 0);
}

async function isGroupMember(groupId, userId, client = pool) {
  if (!looksLikeUuid(groupId)) {
    return false;
  }

  const result = await client.query(
    `SELECT 1
     FROM group_members
     WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId],
  );
  return result.rowCount > 0;
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", service: "class-service", userProjectionConsumerRunning };
});

app.get("/", async (request) => {
  const qText = typeof request.query.q === "string" ? request.query.q.trim() : "";
  const termText = typeof request.query.term === "string" ? request.query.term.trim() : "";
  const limit = clampLimit(request.query.limit, 50, 200);

  const q = `%${qText}%`;
  const normalizedQText = qText.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedQ = `%${normalizedQText}%`;
  const tokens = qText
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]+/g, ""))
    .filter(Boolean);
  const term = `%${termText}%`;

  const result = await pool.query(
    `SELECT id, title, term, description
     FROM classes
     WHERE (
            $1 = ''
            OR id ILIKE $2
            OR title ILIKE $2
            OR description ILIKE $2
            OR regexp_replace(lower(id), '[^a-z0-9]+', '', 'g') LIKE $3
            OR regexp_replace(lower(title), '[^a-z0-9]+', '', 'g') LIKE $3
            OR regexp_replace(lower(description), '[^a-z0-9]+', '', 'g') LIKE $3
            OR (
              cardinality($4::text[]) > 0
              AND NOT EXISTS (
                SELECT 1
                FROM unnest($4::text[]) AS token
                WHERE lower(concat_ws(' ', id, title, description)) NOT LIKE '%' || token || '%'
              )
            )
          )
       AND ($5 = '' OR term ILIKE $6)
     ORDER BY
       CASE
         WHEN lower(id) = lower($1) THEN 0
         WHEN regexp_replace(lower(id), '[^a-z0-9]+', '', 'g') = $7 THEN 1
         WHEN id ILIKE $2 THEN 2
         WHEN title ILIKE $2 THEN 3
         ELSE 4
       END,
       id
     LIMIT $8`,
    [qText, q, normalizedQ, tokens, termText, term, normalizedQText, limit],
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
      const title = normalizeText(item.title);
      const term = normalizeText(item.term) || "TBD";
      const description = normalizeText(item.description);

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

app.delete("/enrollments/:classId", async (request, reply) => {
  const userId = requireRequesterUserId(request, reply);
  if (!userId) {
    return;
  }

  const classId = normalizeClassId(request.params.classId);
  if (!classId) {
    return reply.code(400).send({ error: "classId is required" });
  }

  const client = await pool.connect();
  const disbandedGroupIds = [];
  let classRecord = null;

  try {
    await client.query("BEGIN");

    classRecord = await loadClass(classId, client);
    if (!classRecord) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "class not found" });
    }

    const enrollmentResult = await client.query(
      `SELECT 1
       FROM enrollments
       WHERE user_id = $1 AND class_id = $2`,
      [userId, classId],
    );
    if (enrollmentResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "you are not enrolled in this class" });
    }

    const ownedGroupsResult = await client.query(
      `SELECT id
       FROM groups
       WHERE class_id = $1 AND owner_user_id = $2
       ORDER BY created_at
       FOR UPDATE`,
      [classId, userId],
    );

    for (const row of ownedGroupsResult.rows) {
      const memberCount = await countGroupMembers(row.id, client);
      if (memberCount > 1) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "group owner must transfer ownership or disband groups before un-enrolling",
          groupId: row.id,
        });
      }
    }

    for (const row of ownedGroupsResult.rows) {
      await client.query(`DELETE FROM groups WHERE id = $1`, [row.id]);
      disbandedGroupIds.push(row.id);
    }

    await client.query(
      `DELETE FROM group_members gm
       USING groups g
       WHERE gm.group_id = g.id
         AND g.class_id = $1
         AND gm.user_id = $2`,
      [classId, userId],
    );

    await client.query(
      `DELETE FROM group_requests gr
       USING groups g
       WHERE gr.group_id = g.id
         AND g.class_id = $1
         AND gr.user_id = $2`,
      [classId, userId],
    );

    await client.query(
      `DELETE FROM enrollments
       WHERE user_id = $1 AND class_id = $2`,
      [userId, classId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to delete enrollment");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }

  for (const groupId of disbandedGroupIds) {
    await publish("group.disbanded", groupId, {
      groupId,
      classId,
      disbandedByUserId: userId,
      reason: "class unenrollment",
    });
  }

  await publish("class.enrollment.deleted", classId, {
    userId,
    classId,
    className: classRecord ? classRecord.title : "",
    disbandedGroupIds,
  });

  return reply.send({
    enrolled: false,
    userId,
    classId,
    disbandedGroupIds,
  });
});

app.get("/enrollments/me", async (request, reply) => {
  const userId = requireRequesterUserId(request, reply);
  if (!userId) {
    return;
  }

  const result = await pool.query(
    `SELECT e.class_id, e.created_at, c.title, c.term, c.description
     FROM enrollments e
     JOIN classes c ON c.id = e.class_id
     WHERE e.user_id = $1
     ORDER BY e.created_at DESC`,
    [userId],
  );

  return {
    userId,
    enrollments: result.rows.map((row) => ({
      classId: row.class_id,
      title: row.title,
      term: row.term,
      description: row.description,
      enrolledAt: row.created_at,
    })),
  };
});

app.post("/users/lookup", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const rawUserIds = Array.isArray((request.body || {}).userIds) ? (request.body || {}).userIds : [];
  const userIds = uniqueUserIds(rawUserIds).slice(0, 500);
  if (userIds.length === 0) {
    return { users: [] };
  }

  const result = await pool.query(
    `SELECT user_id, user_name, user_email, profile_picture_url, about, skills, updated_at
     FROM user_directory
     WHERE user_id = ANY($1::text[])`,
    [userIds],
  );

  const userById = new Map(result.rows.map((row) => [row.user_id, row]));

  return {
    users: userIds.map((userId) => {
      const row = userById.get(userId);
      if (!row) {
        return {
          user_id: userId,
          user_name: "",
          user_email: "",
          profile_picture_url: "",
          about: "",
          skills: [],
          updated_at: null,
        };
      }
      return row;
    }),
  };
});

app.get("/groups/me", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const classFilter = normalizeClassId(request.query.classId || "");
  const params = [requesterId, defaultSectionMaxGroupSize];
  let whereClause = "";

  if (classFilter) {
    params.push(classFilter);
    whereClause = " AND g.class_id = $3";
  }

  const result = await pool.query(
    `SELECT g.id,
            g.class_id,
            g.owner_user_id,
            g.name,
            g.project_section,
            g.project_section_id,
            g.created_at,
            COALESCE(ps.name, g.project_section) AS project_section_name,
            COALESCE(ps.description, '') AS project_section_description,
            COALESCE(ps.max_group_size, $2) AS max_group_size,
            COUNT(gm_all.user_id)::int AS member_count,
            COALESCE(array_agg(gm_all.user_id) FILTER (WHERE gm_all.user_id IS NOT NULL), '{}') AS members
     FROM groups g
     JOIN group_members gm_self
       ON gm_self.group_id = g.id
      AND gm_self.user_id = $1
     LEFT JOIN project_sections ps ON ps.id = g.project_section_id
     LEFT JOIN group_members gm_all ON gm_all.group_id = g.id
     WHERE 1 = 1 ${whereClause}
     GROUP BY g.id, ps.id
     ORDER BY g.created_at DESC`,
    params,
  );

  return {
    userId: requesterId,
    groups: result.rows.map(formatGroup),
  };
});

app.get("/:classId/project-sections", async (request, reply) => {
  const classId = normalizeClassId(request.params.classId);
  const classResult = await loadClass(classId);
  if (!classResult) {
    return reply.code(404).send({ error: "class not found" });
  }

  return {
    class: classResult,
    sections: [],
  };
});

app.post("/:classId/project-sections", async (request, reply) => {
  return reply.code(410).send({ error: "project sections are no longer supported" });
});

app.get("/:classId/members", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const classId = normalizeClassId(request.params.classId);

  const classResult = await pool.query("SELECT id, title, term FROM classes WHERE id = $1", [classId]);
  if (classResult.rowCount === 0) {
    return reply.code(404).send({ error: "class not found" });
  }

  const enrolled = await isEnrolled(classId, requesterId);
  if (!enrolled) {
    return reply.code(403).send({ error: "you must be enrolled in the class to view members" });
  }

  const members = await pool.query(
    `SELECT e.user_id,
            e.created_at,
            ud.user_name,
            ud.user_email,
            ud.profile_picture_url,
            ud.about,
            ud.skills
     FROM enrollments e
     LEFT JOIN user_directory ud ON ud.user_id = e.user_id
     WHERE e.class_id = $1
     ORDER BY e.created_at ASC`,
    [classId],
  );

  return {
    class: classResult.rows[0],
    members: members.rows,
  };
});

app.get("/:classId/groups", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const classId = normalizeClassId(request.params.classId);

  const classResult = await pool.query("SELECT id, title, term FROM classes WHERE id = $1", [classId]);
  if (classResult.rowCount === 0) {
    return reply.code(404).send({ error: "class not found" });
  }

  const enrolled = await isEnrolled(classId, requesterId);
  if (!enrolled) {
    return reply.code(403).send({ error: "you must be enrolled in the class to view groups" });
  }

  const groups = await pool.query(
    `SELECT g.id,
            g.class_id,
            g.name,
            g.project_section,
            g.project_section_id,
            g.owner_user_id,
            g.created_at,
            COALESCE(ps.name, g.project_section) AS project_section_name,
            COALESCE(ps.description, '') AS project_section_description,
            COALESCE(ps.max_group_size, $2) AS max_group_size,
            COUNT(gm.user_id)::int AS member_count,
            COALESCE(array_agg(gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '{}') AS members
     FROM groups g
     LEFT JOIN project_sections ps ON ps.id = g.project_section_id
     LEFT JOIN group_members gm ON gm.group_id = g.id
     WHERE g.class_id = $1
     GROUP BY g.id, ps.id
     ORDER BY g.created_at DESC`,
    [classId, defaultSectionMaxGroupSize],
  );

  return { groups: groups.rows.map(formatGroup) };
});

app.get("/groups/:groupId", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId } = request.params;
  const group = await loadGroup(groupId);
  if (!group) {
    return reply.code(404).send({ error: "group not found" });
  }

  const isMemberValue = await isGroupMember(groupId, requesterId);
  return {
    group: {
      ...formatGroup(group),
      viewerIsMember: isMemberValue,
      viewer_is_member: isMemberValue,
      viewerIsOwner: group.owner_user_id === requesterId,
      viewer_is_owner: group.owner_user_id === requesterId,
    },
  };
});

app.post("/:classId/groups", async (request, reply) => {
  const ownerUserId = requireRequesterUserId(request, reply);
  if (!ownerUserId) {
    return;
  }

  const classId = normalizeClassId(request.params.classId);
  const name = normalizeText((request.body || {}).name);
  const defaultGroupSectionName = "General";

  if (!name) {
    return reply.code(400).send({ error: "name is required" });
  }

  const client = await pool.connect();

  let createdGroup = null;
  let classRecord = null;

  try {
    await client.query("BEGIN");

    classRecord = await loadClass(classId, client);
    if (!classRecord) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "class not found" });
    }

    const enrolled = await isEnrolled(classId, ownerUserId, client);
    if (!enrolled) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "you must be enrolled in the class to create a group" });
    }

    const ownedGroupsResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM groups
       WHERE class_id = $1 AND owner_user_id = $2`,
      [classId, ownerUserId],
    );
    const ownedGroupsCount = Number(ownedGroupsResult.rows[0]?.count || 0);
    if (ownedGroupsCount >= 5) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "you can create up to 5 groups per class" });
    }

    const groupResult = await client.query(
      `INSERT INTO groups (class_id, name, project_section, project_section_id, owner_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, class_id, name, project_section, project_section_id, owner_user_id, created_at`,
      [classId, name, defaultGroupSectionName, null, ownerUserId],
    );

    createdGroup = groupResult.rows[0];

    await client.query(
      `INSERT INTO group_members (group_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [createdGroup.id, ownerUserId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to create group");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }

  const group = await loadGroup(createdGroup.id);

  await publish("group.created", createdGroup.id, {
    groupId: createdGroup.id,
    classId,
    className: classRecord ? classRecord.title : "",
    groupName: createdGroup.name,
    ownerUserId,
    projectSectionId: null,
    projectSection: defaultGroupSectionName,
  });

  return reply.code(201).send({ group: formatGroup(group) });
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

  const enrolled = await isEnrolled(group.class_id, userId);
  if (!enrolled) {
    return reply.code(403).send({ error: "you must be enrolled in the class before requesting to join" });
  }

  const alreadyMember = await isGroupMember(groupId, userId);
  if (alreadyMember) {
    return reply.code(409).send({ error: "you are already a member of this group" });
  }

  const memberCount = await countGroupMembers(groupId);
  const maxGroupSize = Number(group.max_group_size || defaultSectionMaxGroupSize);
  if (memberCount >= maxGroupSize) {
    return reply.code(409).send({ error: "group is full" });
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
      ? `SELECT gr.group_id,
                gr.user_id,
                gr.status,
                gr.created_at,
                ud.user_name,
                ud.profile_picture_url
         FROM group_requests gr
         LEFT JOIN user_directory ud ON ud.user_id = gr.user_id
         WHERE gr.group_id = $1
         ORDER BY gr.created_at DESC`
      : `SELECT gr.group_id,
                gr.user_id,
                gr.status,
                gr.created_at,
                ud.user_name,
                ud.profile_picture_url
         FROM group_requests gr
         LEFT JOIN user_directory ud ON ud.user_id = gr.user_id
         WHERE gr.group_id = $1 AND gr.status = $2
         ORDER BY gr.created_at DESC`;

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
  let group = null;

  try {
    await client.query("BEGIN");

    group = await loadGroupForUpdate(groupId, client);
    if (!group) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "group not found" });
    }

    if (group.owner_user_id !== requesterId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "only group owner can approve requests" });
    }

    const targetEnrolled = await isEnrolled(group.class_id, userId, client);
    if (!targetEnrolled) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "user is not enrolled in the class" });
    }

    const memberCount = await countGroupMembers(groupId, client);
    const maxGroupSize = Number(group.max_group_size || defaultSectionMaxGroupSize);

    if (memberCount >= maxGroupSize) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "group is already full" });
    }

    const reqResult = await client.query(
      `UPDATE group_requests
       SET status = 'APPROVED'
       WHERE group_id = $1 AND user_id = $2 AND status = 'PENDING'
       RETURNING group_id, user_id, status`,
      [groupId, userId],
    );

    if (reqResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "pending join request not found" });
    }

    await client.query(
      `INSERT INTO group_members (group_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, userId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to approve group request");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }

  await publish("group.member.added", groupId, {
    groupId,
    classId: group.class_id,
    className: (await loadClass(group.class_id))?.title || "",
    groupName: group.name,
    userId,
  });

  return reply.send({ approved: true, groupId, userId });
});

app.post("/groups/:groupId/requests/:userId/reject", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId, userId } = request.params;

  const client = await pool.connect();
  let group = null;

  try {
    await client.query("BEGIN");

    group = await loadGroupForUpdate(groupId, client);
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
       WHERE group_id = $1 AND user_id = $2 AND status = 'PENDING'
       RETURNING group_id, user_id, status`,
      [groupId, userId],
    );

    if (reqResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "pending join request not found" });
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to reject group request");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }

  await publish("group.request.rejected", groupId, {
    groupId,
    classId: group.class_id,
    userId,
  });

  return reply.send({ rejected: true, groupId, userId });
});

app.post("/groups/:groupId/leave", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId } = request.params;

  const client = await pool.connect();
  let group = null;
  let disbanded = false;

  try {
    await client.query("BEGIN");

    group = await loadGroupForUpdate(groupId, client);
    if (!group) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "group not found" });
    }

    const isMemberValue = await isGroupMember(groupId, requesterId, client);
    if (!isMemberValue) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "you are not a member of this group" });
    }

    const memberCount = await countGroupMembers(groupId, client);

    if (group.owner_user_id === requesterId && memberCount > 1) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "group owner must transfer ownership or disband before leaving" });
    }

    if (memberCount <= 1) {
      await client.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
      disbanded = true;
    } else {
      await client.query(
        `DELETE FROM group_members
         WHERE group_id = $1 AND user_id = $2`,
        [groupId, requesterId],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to leave group");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }

  if (disbanded) {
    await publish("group.disbanded", groupId, {
      groupId,
      classId: group.class_id,
      disbandedByUserId: requesterId,
    });
  } else {
    await publish("group.member.left", groupId, {
      groupId,
      classId: group.class_id,
      userId: requesterId,
    });
  }

  return reply.send({ left: true, groupId, disbanded, userId: requesterId });
});

app.post("/groups/:groupId/transfer-owner", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId } = request.params;
  const newOwnerUserId = normalizeText((request.body || {}).newOwnerUserId);

  if (!newOwnerUserId) {
    return reply.code(400).send({ error: "newOwnerUserId is required" });
  }

  if (newOwnerUserId === requesterId) {
    return reply.code(400).send({ error: "new owner is already current owner" });
  }

  const client = await pool.connect();
  let group = null;

  try {
    await client.query("BEGIN");

    group = await loadGroupForUpdate(groupId, client);
    if (!group) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "group not found" });
    }

    if (group.owner_user_id !== requesterId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "only group owner can transfer ownership" });
    }

    const targetIsMember = await isGroupMember(groupId, newOwnerUserId, client);
    if (!targetIsMember) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "new owner must already be a group member" });
    }

    await client.query(
      `UPDATE groups
       SET owner_user_id = $2
       WHERE id = $1`,
      [groupId, newOwnerUserId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to transfer group ownership");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }

  await publish("group.owner.transferred", groupId, {
    groupId,
    classId: group.class_id,
    previousOwnerUserId: requesterId,
    newOwnerUserId,
  });

  return reply.send({ transferred: true, groupId, previousOwnerUserId: requesterId, newOwnerUserId });
});

app.delete("/groups/:groupId", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { groupId } = request.params;

  const client = await pool.connect();
  let group = null;

  try {
    await client.query("BEGIN");

    group = await loadGroupForUpdate(groupId, client);
    if (!group) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "group not found" });
    }

    if (group.owner_user_id !== requesterId) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "only group owner can disband group" });
    }

    await client.query(`DELETE FROM groups WHERE id = $1`, [groupId]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to disband group");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }

  await publish("group.disbanded", groupId, {
    groupId,
    classId: group.class_id,
    disbandedByUserId: requesterId,
  });

  return reply.send({ disbanded: true, groupId, userId: requesterId });
});

async function start() {
  if (!ingestToken) {
    throw new Error("INGEST_TOKEN must be set");
  }

  await app.register(cors, { origin: true });
  await ensureSchema();
  await ensureCatalogSeeded();
  await connectProducer();
  await startUserProjectionConsumer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start class-service");
  process.exit(1);
});
