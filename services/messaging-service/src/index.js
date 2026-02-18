const fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Kafka } = require("kafkajs");
const Redis = require("ioredis");

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    base: { service: "messaging-service" },
  },
});

const port = Number(process.env.PORT || 3004);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  enableAutoPipelining: true,
});

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

async function connectProducer() {
  const broker = process.env.KAFKA_BROKER;
  if (!broker) {
    app.log.warn("KAFKA_BROKER is not set; events are disabled");
    return;
  }

  try {
    const kafka = new Kafka({ clientId: "messaging-service", brokers: [broker] });
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

function normalizeType(rawType) {
  const normalized = String(rawType || "").toUpperCase().trim();
  if (["DM", "CLASS", "GROUP"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function messageCacheKey(conversationId) {
  return `conversation:${conversationId}:messages`;
}

function unreadHashKey(userId) {
  return `unread:${userId}`;
}

async function getConversationMemberIds(conversationId) {
  const result = await pool.query(
    `SELECT user_id
     FROM conversation_members
     WHERE conversation_id = $1`,
    [conversationId],
  );
  return result.rows.map((row) => row.user_id);
}

async function isMember(conversationId, userId) {
  const result = await pool.query(
    `SELECT 1
     FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return result.rowCount > 0;
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  await redis.ping();
  return { status: "ok", service: "messaging-service" };
});

app.post("/conversations", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const body = request.body || {};
  const type = normalizeType(body.type);
  const classId = body.classId || null;
  const groupId = body.groupId || null;

  const members = Array.isArray(body.memberUserIds)
    ? body.memberUserIds.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const memberUserIds = [...new Set([...members, requesterId])];

  if (!type) {
    return reply.code(400).send({ error: "type must be DM, CLASS, or GROUP" });
  }

  if (memberUserIds.length === 0) {
    return reply.code(400).send({ error: "memberUserIds must include at least one user" });
  }

  if (type === "DM" && memberUserIds.length !== 2) {
    return reply.code(400).send({ error: "DM conversations must include exactly two members" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const conversationResult = await client.query(
      `INSERT INTO conversations (type, class_id, group_id)
       VALUES ($1, $2, $3)
       RETURNING id, type, class_id, group_id, created_at`,
      [type, classId, groupId],
    );

    const conversation = conversationResult.rows[0];
    for (const userId of memberUserIds) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversation.id, userId],
      );
    }

    await client.query("COMMIT");
    return reply.code(201).send({
      conversation,
      memberUserIds,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    request.log.error({ error }, "failed to create conversation");
    return reply.code(500).send({ error: "internal error" });
  } finally {
    client.release();
  }
});

app.post("/conversations/:conversationId/messages", async (request, reply) => {
  const senderUserId = requireRequesterUserId(request, reply);
  if (!senderUserId) {
    return;
  }

  const { conversationId } = request.params;
  const { body } = request.body || {};

  if (!body) {
    return reply.code(400).send({ error: "body is required" });
  }

  const member = await isMember(conversationId, senderUserId);
  if (!member) {
    return reply.code(403).send({ error: "sender is not a member of this conversation" });
  }

  const inserted = await pool.query(
    `INSERT INTO messages (conversation_id, sender_user_id, body)
     VALUES ($1, $2, $3)
     RETURNING id, conversation_id, sender_user_id, body, created_at`,
    [conversationId, senderUserId, String(body)],
  );

  const message = inserted.rows[0];

  try {
    const key = messageCacheKey(conversationId);
    await redis.lpush(key, JSON.stringify(message));
    await redis.ltrim(key, 0, 199);
    await redis.expire(key, 60 * 60 * 6);

    const members = await getConversationMemberIds(conversationId);
    for (const userId of members) {
      if (userId !== senderUserId) {
        await redis.hincrby(unreadHashKey(userId), conversationId, 1);
      }
    }
  } catch (error) {
    request.log.error({ error }, "failed to update redis cache/unread counters");
  }

  await publish("chat.message.sent", conversationId, {
    messageId: message.id,
    conversationId,
    senderUserId,
  });

  return reply.code(201).send({ message });
});

app.get("/conversations/:conversationId/messages", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { conversationId } = request.params;
  const member = await isMember(conversationId, requesterId);
  if (!member) {
    return reply.code(403).send({ error: "not a member of this conversation" });
  }

  const limitRaw = Number(request.query.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const cacheKey = messageCacheKey(conversationId);
  const cached = await redis.lrange(cacheKey, 0, limit - 1);

  if (cached.length > 0) {
    const parsed = cached
      .map((item) => {
        try {
          return JSON.parse(item);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    return { source: "redis", messages: parsed };
  }

  const result = await pool.query(
    `SELECT id, conversation_id, sender_user_id, body, created_at
     FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );

  const messages = [...result.rows].reverse();

  if (messages.length > 0) {
    for (const msg of [...messages].reverse()) {
      await redis.lpush(cacheKey, JSON.stringify(msg));
    }
    await redis.ltrim(cacheKey, 0, 199);
    await redis.expire(cacheKey, 60 * 60 * 6);
  }

  return { source: "postgres", messages };
});

app.post("/conversations/:conversationId/read", async (request, reply) => {
  const userId = requireRequesterUserId(request, reply);
  if (!userId) {
    return;
  }

  const { conversationId } = request.params;
  const member = await isMember(conversationId, userId);
  if (!member) {
    return reply.code(403).send({ error: "not a member of this conversation" });
  }

  await redis.hdel(unreadHashKey(userId), conversationId);

  return reply.send({ cleared: true, conversationId, userId });
});

app.get("/users/:userId/unread", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { userId } = request.params;
  if (userId !== requesterId) {
    return reply.code(403).send({ error: "cannot access unread counts for another user" });
  }

  const unread = await redis.hgetall(unreadHashKey(userId));

  return { userId, unread };
});

async function start() {
  await app.register(cors, { origin: true });
  await connectProducer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start messaging-service");
  process.exit(1);
});
