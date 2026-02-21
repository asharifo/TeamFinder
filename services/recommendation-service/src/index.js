const fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Kafka } = require("kafkajs");

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    base: { service: "recommendation-service" },
  },
});

const port = Number(process.env.PORT || 3005);
const broker = process.env.KAFKA_BROKER;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const projectionTopics = [
  "profile.updated",
  "user.profile.upserted",
  "user.identity.upserted",
  "user.authenticated",
  "class.enrollment.created",
  "group.member.added",
];

let consumerRunning = false;

function getRequesterUserId(request) {
  const raw = request.headers["x-user-id"];
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim();
  return normalized || null;
}

function ensureSelfAccess(request, reply, userId) {
  const requesterId = getRequesterUserId(request);
  if (!requesterId) {
    reply.code(401).send({ error: "missing authenticated user context" });
    return false;
  }

  if (requesterId !== userId) {
    reply.code(403).send({ error: "cannot access recommendations for another user" });
    return false;
  }

  return true;
}

function normalizeSkills(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

async function ensureSchema() {
  await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS user_name TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS user_email TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS profile_picture_url TEXT NOT NULL DEFAULT ''`);
}

async function upsertIdentityProjection(userId, userName, userEmail) {
  await pool.query(
    `INSERT INTO user_profiles (user_id, user_name, user_email, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET user_name = CASE
                                  WHEN EXCLUDED.user_name <> '' THEN EXCLUDED.user_name
                                  ELSE user_profiles.user_name
                                END,
                   user_email = CASE
                                   WHEN EXCLUDED.user_email <> '' THEN EXCLUDED.user_email
                                   ELSE user_profiles.user_email
                                 END,
                   updated_at = NOW()`,
    [userId, typeof userName === "string" ? userName : "", typeof userEmail === "string" ? userEmail : ""],
  );
}

async function upsertProfileProjection(userId, skills, about, profilePictureUrl, userName = "", userEmail = "") {
  await pool.query(
    `INSERT INTO user_profiles (user_id, skills, about, profile_picture_url, user_name, user_email, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, ''), $5, $6, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET skills = EXCLUDED.skills,
                   about = EXCLUDED.about,
                   profile_picture_url = COALESCE($4, user_profiles.profile_picture_url),
                   user_name = CASE
                                 WHEN EXCLUDED.user_name <> '' THEN EXCLUDED.user_name
                                 ELSE user_profiles.user_name
                               END,
                   user_email = CASE
                                  WHEN EXCLUDED.user_email <> '' THEN EXCLUDED.user_email
                                  ELSE user_profiles.user_email
                                END,
                   updated_at = NOW()`,
    [
      userId,
      normalizeSkills(skills),
      typeof about === "string" ? about : "",
      normalizeOptionalText(profilePictureUrl),
      typeof userName === "string" ? userName : "",
      typeof userEmail === "string" ? userEmail : "",
    ],
  );
}

async function upsertClassMembership(userId, classId) {
  await pool.query(
    `INSERT INTO class_memberships (class_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (class_id, user_id) DO NOTHING`,
    [classId, userId],
  );
}

async function getNeighbors(userId) {
  const result = await pool.query(
    `SELECT DISTINCT cm2.user_id AS user_id
     FROM class_memberships cm1
     JOIN class_memberships cm2 ON cm1.class_id = cm2.class_id
     WHERE cm1.user_id = $1
       AND cm2.user_id <> $1`,
    [userId],
  );

  return result.rows.map((row) => row.user_id);
}

function score(sharedClasses, skillOverlap, aboutBonus) {
  return sharedClasses * 30 + skillOverlap * 15 + aboutBonus;
}

async function recomputeForUser(userId) {
  const sharedCountsResult = await pool.query(
    `SELECT cm2.user_id AS candidate_id, COUNT(*)::int AS shared_classes
     FROM class_memberships cm1
     JOIN class_memberships cm2 ON cm1.class_id = cm2.class_id
     WHERE cm1.user_id = $1
       AND cm2.user_id <> $1
     GROUP BY cm2.user_id`,
    [userId],
  );

  const candidates = sharedCountsResult.rows;

  if (candidates.length === 0) {
    await pool.query("DELETE FROM recommendations WHERE user_id = $1", [userId]);
    return;
  }

  const candidateIds = candidates.map((row) => row.candidate_id);

  const profileResult = await pool.query(
    `SELECT user_id, skills, about
     FROM user_profiles
     WHERE user_id = $1 OR user_id = ANY($2::text[])`,
    [userId, candidateIds],
  );

  const profileByUserId = new Map(profileResult.rows.map((row) => [row.user_id, row]));
  const userProfile = profileByUserId.get(userId) || { skills: [], about: "" };
  const userSkills = normalizeSkills(userProfile.skills);

  for (const row of candidates) {
    const candidateId = row.candidate_id;
    const sharedClasses = Number(row.shared_classes || 0);

    const candidateProfile = profileByUserId.get(candidateId) || { skills: [], about: "" };
    const candidateSkills = normalizeSkills(candidateProfile.skills);

    const overlap = candidateSkills.filter((skill) => userSkills.includes(skill)).length;
    const aboutBonus = candidateProfile.about && userProfile.about ? 5 : 0;
    const totalScore = score(sharedClasses, overlap, aboutBonus);

    const reasons = [`${sharedClasses} shared class(es)`];
    if (overlap > 0) {
      reasons.push(`${overlap} shared skill(s)`);
    }
    if (aboutBonus > 0) {
      reasons.push("both users have profile details");
    }

    await pool.query(
      `INSERT INTO recommendations (user_id, target_user_id, score, reasons, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, target_user_id)
       DO UPDATE SET score = EXCLUDED.score,
                     reasons = EXCLUDED.reasons,
                     updated_at = NOW()`,
      [userId, candidateId, totalScore, reasons],
    );
  }

  await pool.query(
    `DELETE FROM recommendations
     WHERE user_id = $1
       AND target_user_id <> ALL($2::text[])`,
    [userId, candidateIds],
  );
}

async function recomputeForUserAndNeighbors(userId) {
  await recomputeForUser(userId);
  const neighbors = await getNeighbors(userId);
  for (const neighborId of neighbors) {
    await recomputeForUser(neighborId);
  }
}

async function handleEvent(topic, payload) {
  if (!payload) {
    return;
  }

  if (topic === "profile.updated") {
    if (!payload.userId) {
      return;
    }
    await upsertProfileProjection(
      payload.userId,
      payload.skills,
      payload.about,
      payload.profilePictureUrl || payload.profile_picture_url,
      payload.userName || payload.name || "",
      payload.userEmail || payload.email || "",
    );
    await recomputeForUserAndNeighbors(payload.userId);
    return;
  }

  if (topic === "user.profile.upserted") {
    if (!payload.userId) {
      return;
    }
    await upsertProfileProjection(
      payload.userId,
      payload.skills,
      payload.about,
      payload.profilePictureUrl || payload.profile_picture_url,
      payload.userName || payload.name || "",
      payload.userEmail || payload.email || "",
    );
    await recomputeForUserAndNeighbors(payload.userId);
    return;
  }

  if (topic === "user.identity.upserted" || topic === "user.authenticated") {
    if (!payload.userId) {
      return;
    }
    await upsertIdentityProjection(payload.userId, payload.userName || payload.name || "", payload.userEmail || payload.email || "");
    return;
  }

  if (topic === "class.enrollment.created") {
    if (!payload.userId || !payload.classId) {
      return;
    }
    await upsertClassMembership(payload.userId, payload.classId);
    await recomputeForUserAndNeighbors(payload.userId);
    return;
  }

  if (topic === "group.member.added") {
    if (payload.userId) {
      await recomputeForUserAndNeighbors(payload.userId);
    }
  }
}

async function ensureProjectionTopics(kafka) {
  const admin = kafka.admin();
  try {
    await admin.connect();
    const metadata = await admin.fetchTopicMetadata();
    const existingTopics = new Set((metadata.topics || []).map((topic) => topic.name));
    const missingTopics = projectionTopics.filter((topic) => !existingTopics.has(topic));

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
    app.log.warn({ error }, "failed to ensure projection topics");
  } finally {
    try {
      await admin.disconnect();
    } catch (_error) {
      // noop
    }
  }
}

async function startConsumer() {
  if (!broker) {
    app.log.warn("KAFKA_BROKER is not set; recommendation events are disabled");
    return;
  }

  const kafka = new Kafka({ clientId: "recommendation-service", brokers: [broker] });
  const consumer = kafka.consumer({ groupId: "recommendation-service-group" });

  try {
    await ensureProjectionTopics(kafka);
    await consumer.connect();
    for (const topic of projectionTopics) {
      await consumer.subscribe({ topic });
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
        } catch (error) {
          app.log.warn({ topic, text }, "received invalid json event");
          return;
        }

        try {
          await handleEvent(topic, payload);
        } catch (error) {
          app.log.error({ error, topic, payload }, "failed handling event");
        }
      },
      })
      .catch((error) => {
        consumerRunning = false;
        app.log.error({ error }, "kafka consumer crashed");
      });
    consumerRunning = true;
    app.log.info({ topics: projectionTopics }, "recommendation consumer is running");
  } catch (error) {
    app.log.error({ error }, "failed to start kafka consumer");
  }
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", service: "recommendation-service", consumerRunning };
});

app.get("/:userId", async (request, reply) => {
  const { userId } = request.params;
  if (!ensureSelfAccess(request, reply, userId)) {
    return;
  }

  const limitRaw = Number(request.query.limit || 20);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  const result = await pool.query(
    `SELECT r.user_id,
            r.target_user_id,
            r.score,
            r.reasons,
            r.updated_at,
            up.user_name AS target_user_name,
            up.profile_picture_url AS target_profile_picture_url
     FROM recommendations r
     LEFT JOIN user_profiles up ON up.user_id = r.target_user_id
     WHERE r.user_id = $1
     ORDER BY r.score DESC, r.updated_at DESC
     LIMIT $2`,
    [userId, limit],
  );

  return {
    userId,
    recommendations: result.rows,
  };
});

app.post("/recompute/:userId", async (request, reply) => {
  const { userId } = request.params;
  if (!ensureSelfAccess(request, reply, userId)) {
    return;
  }

  await recomputeForUserAndNeighbors(userId);
  return reply.send({ recomputed: true, userId });
});

async function start() {
  await app.register(cors, { origin: true });
  await ensureSchema();
  await app.listen({ port, host: "0.0.0.0" });
  await startConsumer();
}

start().catch((error) => {
  app.log.error({ error }, "failed to start recommendation-service");
  process.exit(1);
});
