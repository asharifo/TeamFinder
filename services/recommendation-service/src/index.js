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

async function upsertProfileProjection(userId, skills, about) {
  await pool.query(
    `INSERT INTO user_profiles (user_id, skills, about, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET skills = EXCLUDED.skills,
                   about = EXCLUDED.about,
                   updated_at = NOW()`,
    [userId, normalizeSkills(skills), typeof about === "string" ? about : ""],
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
    await upsertProfileProjection(payload.userId, payload.skills, payload.about);
    await recomputeForUserAndNeighbors(payload.userId);
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

async function startConsumer() {
  if (!broker) {
    app.log.warn("KAFKA_BROKER is not set; recommendation events are disabled");
    return;
  }

  const kafka = new Kafka({ clientId: "recommendation-service", brokers: [broker] });
  const consumer = kafka.consumer({ groupId: "recommendation-service-group" });

  try {
    await consumer.connect();
    for (const topic of ["profile.updated", "class.enrollment.created", "group.member.added"]) {
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
    app.log.info("recommendation consumer is running");
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
    `SELECT user_id, target_user_id, score, reasons, updated_at
     FROM recommendations
     WHERE user_id = $1
     ORDER BY score DESC, updated_at DESC
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
  await app.listen({ port, host: "0.0.0.0" });
  await startConsumer();
}

start().catch((error) => {
  app.log.error({ error }, "failed to start recommendation-service");
  process.exit(1);
});
