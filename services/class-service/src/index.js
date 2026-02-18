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
const messagingServiceUrl = String(process.env.MESSAGING_SERVICE_URL || "http://messaging-service:3004").replace(/\/$/, "");
const internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN || "dev-service-token";
const defaultSectionMaxGroupSize = Math.min(
  Math.max(Number(process.env.DEFAULT_SECTION_MAX_GROUP_SIZE || 4) || 4, 2),
  20,
);

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

function normalizeText(value) {
  return String(value || "").trim();
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

async function loadProjectSectionById(sectionId, classId, client = pool) {
  if (!looksLikeUuid(sectionId)) {
    return null;
  }

  const result = await client.query(
    `SELECT id, class_id, name, description, max_group_size, created_by_user_id, created_at
     FROM project_sections
     WHERE id = $1 AND class_id = $2`,
    [sectionId, classId],
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

async function loadOrCreateProjectSectionByName(classId, name, createdByUserId, client = pool) {
  const existing = await client.query(
    `SELECT id, class_id, name, description, max_group_size, created_by_user_id, created_at
     FROM project_sections
     WHERE class_id = $1 AND name = $2`,
    [classId, name],
  );

  if (existing.rowCount > 0) {
    return existing.rows[0];
  }

  const inserted = await client.query(
    `INSERT INTO project_sections (class_id, name, description, max_group_size, created_by_user_id)
     VALUES ($1, $2, '', $3, $4)
     ON CONFLICT (class_id, name)
     DO UPDATE SET name = EXCLUDED.name
     RETURNING id, class_id, name, description, max_group_size, created_by_user_id, created_at`,
    [classId, name, defaultSectionMaxGroupSize, createdByUserId],
  );

  return inserted.rows[0];
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

async function loadGroupMembers(groupId, client = pool) {
  if (!looksLikeUuid(groupId)) {
    return [];
  }

  const result = await client.query(
    `SELECT user_id
     FROM group_members
     WHERE group_id = $1
     ORDER BY joined_at ASC`,
    [groupId],
  );
  return result.rows.map((row) => row.user_id);
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

async function userHasGroupInSection(classId, userId, projectSectionId, projectSectionName, client = pool, excludedGroupId = null) {
  const result = await client.query(
    `SELECT g.id
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE g.class_id = $1
       AND gm.user_id = $2
       AND (
         ($3::uuid IS NOT NULL AND g.project_section_id = $3::uuid)
         OR ($3::uuid IS NULL AND g.project_section = $4)
       )
       AND ($5::uuid IS NULL OR g.id <> $5::uuid)
     LIMIT 1`,
    [classId, userId, projectSectionId || null, projectSectionName || null, excludedGroupId || null],
  );

  return result.rowCount > 0;
}

async function syncGroupConversation({ groupId, classId, memberUserIds }) {
  if (!messagingServiceUrl) {
    return;
  }

  try {
    const response = await fetch(`${messagingServiceUrl}/internal/group-conversations/sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-token": internalServiceToken,
      },
      body: JSON.stringify({
        groupId,
        classId,
        memberUserIds: Array.isArray(memberUserIds) ? memberUserIds : [],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      app.log.warn(
        {
          groupId,
          classId,
          statusCode: response.status,
          responseBody: text,
        },
        "failed to sync group conversation",
      );
    }
  } catch (error) {
    app.log.warn({ error, groupId, classId }, "failed to call messaging-service for group sync");
  }
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

  const sections = await pool.query(
    `SELECT ps.id,
            ps.class_id,
            ps.name,
            ps.description,
            ps.max_group_size,
            ps.created_by_user_id,
            ps.created_at,
            COUNT(g.id)::int AS group_count
     FROM project_sections ps
     LEFT JOIN groups g ON g.project_section_id = ps.id
     WHERE ps.class_id = $1
     GROUP BY ps.id
     ORDER BY ps.created_at ASC`,
    [classId],
  );

  return {
    class: classResult,
    sections: sections.rows.map(formatSection),
  };
});

app.post("/:classId/project-sections", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const classId = normalizeClassId(request.params.classId);
  const name = normalizeText((request.body || {}).name);
  const description = normalizeText((request.body || {}).description);
  const maxGroupSize = toMaxGroupSize((request.body || {}).maxGroupSize, defaultSectionMaxGroupSize);

  if (!name) {
    return reply.code(400).send({ error: "name is required" });
  }

  const classResult = await loadClass(classId);
  if (!classResult) {
    return reply.code(404).send({ error: "class not found" });
  }

  const enrolled = await isEnrolled(classId, requesterId);
  if (!enrolled) {
    return reply.code(403).send({ error: "you must be enrolled in the class to manage project sections" });
  }

  const section = await pool.query(
    `INSERT INTO project_sections (class_id, name, description, max_group_size, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (class_id, name)
     DO UPDATE SET description = EXCLUDED.description,
                   max_group_size = EXCLUDED.max_group_size
     RETURNING id,
               class_id,
               name,
               description,
               max_group_size,
               created_by_user_id,
               created_at`,
    [classId, name, description, maxGroupSize, requesterId],
  );

  return reply.code(201).send({ section: formatSection(section.rows[0]) });
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
  const rawProjectSection = normalizeText((request.body || {}).projectSection);
  const rawProjectSectionId = normalizeText((request.body || {}).projectSectionId);

  if (!name) {
    return reply.code(400).send({ error: "name is required" });
  }

  if (!rawProjectSection && !rawProjectSectionId) {
    return reply.code(400).send({ error: "projectSectionId or projectSection is required" });
  }

  if (rawProjectSectionId && !looksLikeUuid(rawProjectSectionId)) {
    return reply.code(400).send({ error: "projectSectionId must be a valid UUID" });
  }

  const client = await pool.connect();

  let createdGroup = null;
  let section = null;

  try {
    await client.query("BEGIN");

    const classResult = await loadClass(classId, client);
    if (!classResult) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ error: "class not found" });
    }

    const enrolled = await isEnrolled(classId, ownerUserId, client);
    if (!enrolled) {
      await client.query("ROLLBACK");
      return reply.code(403).send({ error: "you must be enrolled in the class to create a group" });
    }

    if (rawProjectSectionId) {
      section = await loadProjectSectionById(rawProjectSectionId, classId, client);
      if (!section) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "project section not found for class" });
      }
    } else {
      section = await loadOrCreateProjectSectionByName(classId, rawProjectSection, ownerUserId, client);
    }

    const alreadyInSectionGroup = await userHasGroupInSection(
      classId,
      ownerUserId,
      section.id,
      section.name,
      client,
      null,
    );

    if (alreadyInSectionGroup) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "you are already in a group for this project section" });
    }

    const groupResult = await client.query(
      `INSERT INTO groups (class_id, name, project_section, project_section_id, owner_user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, class_id, name, project_section, project_section_id, owner_user_id, created_at`,
      [classId, name, section.name, section.id, ownerUserId],
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
  const memberUserIds = await loadGroupMembers(createdGroup.id);

  await syncGroupConversation({
    groupId: createdGroup.id,
    classId,
    memberUserIds,
  });

  await publish("group.created", classId, {
    groupId: createdGroup.id,
    classId,
    ownerUserId,
    projectSectionId: section.id,
    projectSection: section.name,
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

  const alreadyInSectionGroup = await userHasGroupInSection(
    group.class_id,
    userId,
    group.project_section_id,
    group.project_section_name,
  );

  if (alreadyInSectionGroup) {
    return reply.code(409).send({ error: "you are already in a group for this project section" });
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

    const targetAlreadyInSection = await userHasGroupInSection(
      group.class_id,
      userId,
      group.project_section_id,
      group.project_section_name,
      client,
      group.id,
    );

    if (targetAlreadyInSection) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "user already belongs to a group in this project section" });
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

  const memberUserIds = await loadGroupMembers(groupId);
  await syncGroupConversation({
    groupId,
    classId: group.class_id,
    memberUserIds,
  });

  await publish("group.member.added", groupId, {
    groupId,
    classId: group.class_id,
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
    await syncGroupConversation({
      groupId,
      classId: group.class_id,
      memberUserIds: [],
    });

    await publish("group.disbanded", groupId, {
      groupId,
      classId: group.class_id,
      disbandedByUserId: requesterId,
    });
  } else {
    const memberUserIds = await loadGroupMembers(groupId);
    await syncGroupConversation({
      groupId,
      classId: group.class_id,
      memberUserIds,
    });

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

  await syncGroupConversation({
    groupId,
    classId: group.class_id,
    memberUserIds: [],
  });

  await publish("group.disbanded", groupId, {
    groupId,
    classId: group.class_id,
    disbandedByUserId: requesterId,
  });

  return reply.send({ disbanded: true, groupId, userId: requesterId });
});

async function start() {
  await app.register(cors, { origin: true });
  await ensureSchema();
  await connectProducer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start class-service");
  process.exit(1);
});
