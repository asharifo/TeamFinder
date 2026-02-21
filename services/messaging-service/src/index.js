const fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Kafka } = require("kafkajs");
const Redis = require("ioredis");
const { createRemoteJWKSet, jwtVerify } = require("jose");
const { Server } = require("socket.io");

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
const kafkaBroker = String(process.env.KAFKA_BROKER || "").trim();
const groupEventsConsumerGroup = String(process.env.GROUP_EVENTS_CONSUMER_GROUP || "messaging-group-sync-v1").trim() || "messaging-group-sync-v1";
const groupLifecycleTopics = ["group.created", "group.member.added", "group.member.left", "group.disbanded"];

const auth0IssuerBaseUrl = String(process.env.AUTH0_ISSUER_BASE_URL || "").trim();
const auth0Audience = String(process.env.AUTH0_AUDIENCE || "").trim();
const auth0Configured = Boolean(auth0IssuerBaseUrl && auth0Audience);
const issuer = auth0IssuerBaseUrl.endsWith("/") ? auth0IssuerBaseUrl : `${auth0IssuerBaseUrl}/`;
const jwks = auth0Configured ? createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`)) : null;

let producer = null;
let io = null;
let groupEventsConsumerRunning = false;

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

function normalizeUserId(value) {
  return String(value || "").trim();
}

function normalizeOptionalClassId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "").trim(),
  );
}

function uniqueUserIds(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const userId = normalizeUserId(value);
    if (!userId || seen.has(userId)) {
      continue;
    }
    seen.add(userId);
    out.push(userId);
  }
  return out;
}

function getSocketBearerToken(socket) {
  const authToken = socket.handshake.auth && socket.handshake.auth.token;
  if (authToken && typeof authToken === "string") {
    return authToken.replace(/^Bearer\s+/i, "").trim();
  }

  const header = socket.handshake.headers.authorization;
  if (!header || typeof header !== "string") {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token.trim();
}

function messageCacheKey(conversationId) {
  return `conversation:${conversationId}:messages`;
}

function unreadHashKey(userId) {
  return `unread:${userId}`;
}

function onlineUsersKey() {
  return "presence:online-users";
}

function userSocketCountKey(userId) {
  return `presence:user-socket-count:${userId}`;
}

function conversationPresenceSetKey(conversationId) {
  return `presence:conversation:${conversationId}:users`;
}

function conversationPresenceCountKey(conversationId) {
  return `presence:conversation:${conversationId}:counts`;
}

function conversationRoom(conversationId) {
  return `conversation:${conversationId}`;
}

async function connectProducer() {
  if (!kafkaBroker) {
    app.log.warn("KAFKA_BROKER is not set; events are disabled");
    return;
  }

  try {
    const kafka = new Kafka({ clientId: "messaging-service", brokers: [kafkaBroker] });
    producer = kafka.producer();
    await producer.connect();
    app.log.info("connected to kafka");
  } catch (error) {
    producer = null;
    app.log.error({ error }, "failed to connect kafka producer; continuing without events");
  }
}

async function ensureSchema() {
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_group_unique
     ON conversations (group_id)
     WHERE type = 'GROUP' AND group_id IS NOT NULL`,
  );

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_conversation_members_user
     ON conversation_members (user_id)`,
  );
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

async function loadGroupConversationForUpdate(groupId, client = pool) {
  const result = await client.query(
    `SELECT id, type, class_id, group_id, created_at
     FROM conversations
     WHERE type = 'GROUP'
       AND group_id = $1
     FOR UPDATE`,
    [groupId],
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

async function ensureGroupConversation({ groupId, classId, client = pool }) {
  const normalizedClassId = normalizeOptionalClassId(classId);
  const existing = await loadGroupConversationForUpdate(groupId, client);
  if (!existing) {
    const inserted = await client.query(
      `INSERT INTO conversations (type, class_id, group_id)
       VALUES ('GROUP', $1, $2)
       RETURNING id, type, class_id, group_id, created_at`,
      [normalizedClassId, groupId],
    );
    return inserted.rows[0];
  }

  if (!normalizedClassId || existing.class_id === normalizedClassId) {
    return existing;
  }

  const updated = await client.query(
    `UPDATE conversations
     SET class_id = $2
     WHERE id = $1
     RETURNING id, type, class_id, group_id, created_at`,
    [existing.id, normalizedClassId],
  );
  return updated.rows[0];
}

async function clearMemberConversationState(conversationId, userId) {
  try {
    const pipeline = redis.pipeline();
    pipeline.hdel(unreadHashKey(userId), conversationId);
    pipeline.hdel(conversationPresenceCountKey(conversationId), userId);
    pipeline.srem(conversationPresenceSetKey(conversationId), userId);
    await pipeline.exec();
  } catch (error) {
    app.log.warn({ error, conversationId, userId }, "failed to clear member conversation state");
  }
}

async function clearConversationState(conversationId, memberUserIds) {
  try {
    const users = uniqueUserIds(memberUserIds);
    const pipeline = redis.pipeline();
    pipeline.del(messageCacheKey(conversationId));
    pipeline.del(conversationPresenceSetKey(conversationId));
    pipeline.del(conversationPresenceCountKey(conversationId));
    for (const userId of users) {
      pipeline.hdel(unreadHashKey(userId), conversationId);
    }
    await pipeline.exec();
  } catch (error) {
    app.log.warn({ error, conversationId }, "failed to clear deleted conversation state");
  }
}

async function applyGroupCreatedEvent(payload) {
  const groupId = String((payload || {}).groupId || "").trim();
  const classId = normalizeOptionalClassId((payload || {}).classId);
  const ownerUserId = normalizeUserId((payload || {}).ownerUserId);

  if (!looksLikeUuid(groupId)) {
    app.log.warn({ payload }, "skipping group.created with invalid groupId");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const conversation = await ensureGroupConversation({ groupId, classId, client });
    if (ownerUserId) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversation.id, ownerUserId],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyGroupMemberAddedEvent(payload) {
  const groupId = String((payload || {}).groupId || "").trim();
  const classId = normalizeOptionalClassId((payload || {}).classId);
  const userId = normalizeUserId((payload || {}).userId);

  if (!looksLikeUuid(groupId) || !userId) {
    app.log.warn({ payload }, "skipping group.member.added with invalid payload");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await ensureGroupConversation({ groupId, classId, client });
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversation.id, userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyGroupMemberLeftEvent(payload) {
  const groupId = String((payload || {}).groupId || "").trim();
  const userId = normalizeUserId((payload || {}).userId);

  if (!looksLikeUuid(groupId) || !userId) {
    app.log.warn({ payload }, "skipping group.member.left with invalid payload");
    return;
  }

  let conversationId = null;
  let removed = false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await loadGroupConversationForUpdate(groupId, client);
    if (!conversation) {
      await client.query("COMMIT");
      return;
    }

    const removedResult = await client.query(
      `DELETE FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversation.id, userId],
    );

    conversationId = conversation.id;
    removed = removedResult.rowCount > 0;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (removed && conversationId) {
    await clearMemberConversationState(conversationId, userId);
  }
}

async function applyGroupDisbandedEvent(payload) {
  const groupId = String((payload || {}).groupId || "").trim();
  if (!looksLikeUuid(groupId)) {
    app.log.warn({ payload }, "skipping group.disbanded with invalid groupId");
    return;
  }

  let deletedConversationId = null;
  let memberUserIds = [];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const conversation = await loadGroupConversationForUpdate(groupId, client);
    if (!conversation) {
      await client.query("COMMIT");
      return;
    }

    const membersResult = await client.query(
      `SELECT user_id
       FROM conversation_members
       WHERE conversation_id = $1`,
      [conversation.id],
    );
    memberUserIds = membersResult.rows.map((row) => row.user_id);

    await client.query(`DELETE FROM conversations WHERE id = $1`, [conversation.id]);
    await client.query("COMMIT");
    deletedConversationId = conversation.id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (!deletedConversationId) {
    return;
  }

  await clearConversationState(deletedConversationId, memberUserIds);
  if (io) {
    io.to(conversationRoom(deletedConversationId)).emit("conversation:deleted", {
      conversationId: deletedConversationId,
      reason: "group_disbanded",
    });
  }
}

async function handleGroupLifecycleEvent(topic, payload) {
  if (topic === "group.created") {
    await applyGroupCreatedEvent(payload);
    return;
  }

  if (topic === "group.member.added") {
    await applyGroupMemberAddedEvent(payload);
    return;
  }

  if (topic === "group.member.left") {
    await applyGroupMemberLeftEvent(payload);
    return;
  }

  if (topic === "group.disbanded") {
    await applyGroupDisbandedEvent(payload);
  }
}

async function ensureGroupLifecycleTopics(kafka) {
  const admin = kafka.admin();
  try {
    await admin.connect();
    const metadata = await admin.fetchTopicMetadata();
    const existingTopics = new Set((metadata.topics || []).map((topic) => topic.name));
    const missingTopics = groupLifecycleTopics.filter((topic) => !existingTopics.has(topic));

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
    app.log.warn({ error }, "failed to ensure group lifecycle topics");
  } finally {
    try {
      await admin.disconnect();
    } catch (_error) {
      // noop
    }
  }
}

async function startGroupLifecycleConsumer() {
  if (!kafkaBroker) {
    app.log.warn("KAFKA_BROKER is not set; group lifecycle consumer disabled");
    return;
  }

  const kafka = new Kafka({ clientId: "messaging-service-group-lifecycle", brokers: [kafkaBroker] });
  const consumer = kafka.consumer({ groupId: groupEventsConsumerGroup });

  try {
    await ensureGroupLifecycleTopics(kafka);
    await consumer.connect();
    for (const topic of groupLifecycleTopics) {
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
            app.log.warn({ topic, text }, "received invalid json group lifecycle event");
            return;
          }

          try {
            await handleGroupLifecycleEvent(topic, payload);
          } catch (error) {
            app.log.error({ error, topic, payload }, "failed to process group lifecycle event");
          }
        },
      })
      .catch((error) => {
        groupEventsConsumerRunning = false;
        app.log.error({ error }, "group lifecycle consumer crashed");
      });

    groupEventsConsumerRunning = true;
    app.log.info({ topics: groupLifecycleTopics, groupId: groupEventsConsumerGroup }, "group lifecycle consumer is running");
  } catch (error) {
    app.log.error({ error }, "failed to start group lifecycle consumer");
  }
}

function normalizeType(rawType) {
  const normalized = String(rawType || "").toUpperCase().trim();
  if (["DM", "CLASS", "GROUP"].includes(normalized)) {
    return normalized;
  }
  return null;
}

function formatConversationRow(row) {
  return {
    id: row.id,
    type: row.type,
    classId: row.class_id,
    class_id: row.class_id,
    groupId: row.group_id,
    group_id: row.group_id,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
}

async function getConversationMemberIds(conversationId, client = pool) {
  const result = await client.query(
    `SELECT user_id
     FROM conversation_members
     WHERE conversation_id = $1
     ORDER BY user_id ASC`,
    [conversationId],
  );
  return result.rows.map((row) => row.user_id);
}

async function isMember(conversationId, userId, client = pool) {
  const result = await client.query(
    `SELECT 1
     FROM conversation_members
     WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
  return result.rowCount > 0;
}

async function getGroupConversationForUser(groupId, userId) {
  const result = await pool.query(
    `SELECT c.id, c.type, c.class_id, c.group_id, c.created_at
     FROM conversations c
     JOIN conversation_members cm
       ON cm.conversation_id = c.id
      AND cm.user_id = $2
     WHERE c.type = 'GROUP'
       AND c.group_id = $1
     LIMIT 1`,
    [groupId, userId],
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

async function findExistingDmConversation(userA, userB, client = pool) {
  const result = await client.query(
    `SELECT c.id, c.type, c.class_id, c.group_id, c.created_at
     FROM conversations c
     JOIN conversation_members cm_a
       ON cm_a.conversation_id = c.id
      AND cm_a.user_id = $1
     JOIN conversation_members cm_b
       ON cm_b.conversation_id = c.id
      AND cm_b.user_id = $2
     WHERE c.type = 'DM'
       AND NOT EXISTS (
         SELECT 1
         FROM conversation_members cm_x
         WHERE cm_x.conversation_id = c.id
           AND cm_x.user_id NOT IN ($1, $2)
       )
     LIMIT 1`,
    [userA, userB],
  );

  return result.rowCount > 0 ? result.rows[0] : null;
}

async function persistAndFanoutMessage(conversationId, senderUserId, body) {
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
    app.log.warn(
      { error, conversationId, senderUserId, messageId: message.id },
      "message persisted but cache/unread updates failed",
    );
  }

  await publish("chat.message.sent", conversationId, {
    messageId: message.id,
    conversationId,
    senderUserId,
  });

  if (io) {
    try {
      io.to(conversationRoom(conversationId)).emit("message:new", {
        conversationId,
        message,
      });
    } catch (error) {
      app.log.warn({ error, conversationId, messageId: message.id }, "failed to broadcast realtime message");
    }
  }

  return message;
}

async function createOrGetDmConversation(requesterId, otherUserId) {
  const existing = await findExistingDmConversation(requesterId, otherUserId);
  if (existing) {
    const members = await getConversationMemberIds(existing.id);
    return {
      conversation: {
        ...formatConversationRow(existing),
        members,
      },
      created: false,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const recheck = await findExistingDmConversation(requesterId, otherUserId, client);
    let conversation = recheck;

    if (!conversation) {
      const inserted = await client.query(
        `INSERT INTO conversations (type, class_id, group_id)
         VALUES ('DM', NULL, NULL)
         RETURNING id, type, class_id, group_id, created_at`,
      );

      conversation = inserted.rows[0];

      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversation.id, requesterId, otherUserId],
      );
    }

    await client.query("COMMIT");

    const members = await getConversationMemberIds(conversation.id);

    return {
      conversation: {
        ...formatConversationRow(conversation),
        members,
      },
      created: !recheck,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function joinConversationPresence(conversationId, userId) {
  const countKey = conversationPresenceCountKey(conversationId);
  const setKey = conversationPresenceSetKey(conversationId);
  const count = await redis.hincrby(countKey, userId, 1);
  if (count === 1) {
    await redis.sadd(setKey, userId);
    if (io) {
      io.to(conversationRoom(conversationId)).emit("presence:update", {
        conversationId,
        userId,
        isOnline: true,
      });
    }
  }
}

async function leaveConversationPresence(conversationId, userId) {
  const countKey = conversationPresenceCountKey(conversationId);
  const setKey = conversationPresenceSetKey(conversationId);
  const count = await redis.hincrby(countKey, userId, -1);
  if (count <= 0) {
    await redis.hdel(countKey, userId);
    await redis.srem(setKey, userId);
    if (io) {
      io.to(conversationRoom(conversationId)).emit("presence:update", {
        conversationId,
        userId,
        isOnline: false,
      });
    }
  }
}

async function getConversationPresence(conversationId) {
  return redis.smembers(conversationPresenceSetKey(conversationId));
}

async function markUserOnline(userId) {
  const count = await redis.incr(userSocketCountKey(userId));
  if (count === 1) {
    await redis.sadd(onlineUsersKey(), userId);
    if (io) {
      io.emit("user:presence", { userId, isOnline: true });
    }
  }
}

async function markUserOffline(userId) {
  const count = await redis.decr(userSocketCountKey(userId));
  if (count <= 0) {
    await redis.del(userSocketCountKey(userId));
    await redis.srem(onlineUsersKey(), userId);
    if (io) {
      io.emit("user:presence", { userId, isOnline: false });
    }
  }
}

async function verifySocketToken(token) {
  if (!token) {
    throw new Error("missing token");
  }

  if (!auth0Configured || !jwks) {
    throw new Error("auth0 not configured");
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: auth0Audience,
  });

  if (!payload.sub) {
    throw new Error("token missing sub claim");
  }

  return payload;
}

function ack(callback, payload) {
  if (typeof callback === "function") {
    callback(payload);
  }
}

function initSocketServer() {
  io = new Server(app.server, {
    path: "/ws/socket.io",
    cors: {
      origin: true,
      methods: ["GET", "POST"],
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = getSocketBearerToken(socket);
      const claims = await verifySocketToken(token);
      socket.data.userId = String(claims.sub);
      socket.data.joinedConversations = new Set();
      next();
    } catch (error) {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId;
    await markUserOnline(userId);

    socket.emit("session:ready", {
      userId,
      socketId: socket.id,
    });

    socket.on("conversation:join", async (payload, callback) => {
      const conversationId = String((payload || {}).conversationId || "").trim();
      if (!conversationId) {
        ack(callback, { ok: false, error: "conversationId is required" });
        return;
      }

      try {
        const member = await isMember(conversationId, userId);
        if (!member) {
          ack(callback, { ok: false, error: "not a member of this conversation" });
          return;
        }

        socket.join(conversationRoom(conversationId));
        socket.data.joinedConversations.add(conversationId);
        await joinConversationPresence(conversationId, userId);

        const onlineUserIds = await getConversationPresence(conversationId);

        ack(callback, {
          ok: true,
          conversationId,
          onlineUserIds,
        });
      } catch (error) {
        app.log.error({ error, conversationId, userId }, "conversation join failed");
        ack(callback, { ok: false, error: "failed to join conversation" });
      }
    });

    socket.on("conversation:leave", async (payload, callback) => {
      const conversationId = String((payload || {}).conversationId || "").trim();
      if (!conversationId) {
        ack(callback, { ok: false, error: "conversationId is required" });
        return;
      }

      try {
        socket.leave(conversationRoom(conversationId));
        socket.data.joinedConversations.delete(conversationId);
        await leaveConversationPresence(conversationId, userId);
        ack(callback, { ok: true, conversationId });
      } catch (error) {
        app.log.error({ error, conversationId, userId }, "conversation leave failed");
        ack(callback, { ok: false, error: "failed to leave conversation" });
      }
    });

    socket.on("typing:start", async (payload, callback) => {
      const conversationId = String((payload || {}).conversationId || "").trim();
      if (!conversationId) {
        ack(callback, { ok: false, error: "conversationId is required" });
        return;
      }

      if (!socket.data.joinedConversations.has(conversationId)) {
        ack(callback, { ok: false, error: "join conversation before typing" });
        return;
      }

      socket.to(conversationRoom(conversationId)).emit("typing:update", {
        conversationId,
        userId,
        isTyping: true,
      });

      ack(callback, { ok: true, conversationId });
    });

    socket.on("typing:stop", async (payload, callback) => {
      const conversationId = String((payload || {}).conversationId || "").trim();
      if (!conversationId) {
        ack(callback, { ok: false, error: "conversationId is required" });
        return;
      }

      if (!socket.data.joinedConversations.has(conversationId)) {
        ack(callback, { ok: false, error: "join conversation before typing" });
        return;
      }

      socket.to(conversationRoom(conversationId)).emit("typing:update", {
        conversationId,
        userId,
        isTyping: false,
      });

      ack(callback, { ok: true, conversationId });
    });

    socket.on("message:send", async (payload, callback) => {
      const conversationId = String((payload || {}).conversationId || "").trim();
      const body = String((payload || {}).body || "").trim();

      if (!conversationId || !body) {
        ack(callback, { ok: false, error: "conversationId and body are required" });
        return;
      }

      try {
        const member = await isMember(conversationId, userId);
        if (!member) {
          ack(callback, { ok: false, error: "not a member of this conversation" });
          return;
        }

        const message = await persistAndFanoutMessage(conversationId, userId, body);
        ack(callback, { ok: true, message });
      } catch (error) {
        app.log.error({ error, conversationId, userId }, "socket message send failed");
        ack(callback, { ok: false, error: "failed to send message" });
      }
    });

    socket.on("disconnect", async () => {
      const joinedConversations = Array.from(socket.data.joinedConversations || []);
      for (const conversationId of joinedConversations) {
        try {
          await leaveConversationPresence(conversationId, userId);
        } catch (error) {
          app.log.warn({ error, conversationId, userId }, "failed to clear conversation presence on disconnect");
        }
      }

      await markUserOffline(userId);
    });
  });
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  await redis.ping();
  return {
    status: "ok",
    service: "messaging-service",
    auth0Configured,
    groupEventsConsumerRunning,
  };
});

app.get("/conversations", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const limitRaw = Number(request.query.limit || 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;

  const result = await pool.query(
    `SELECT c.id,
            c.type,
            c.class_id,
            c.group_id,
            c.created_at,
            COALESCE(array_agg(cm_all.user_id ORDER BY cm_all.user_id), '{}') AS members,
            lm.id AS last_message_id,
            lm.sender_user_id AS last_message_sender_user_id,
            lm.body AS last_message_body,
            lm.created_at AS last_message_created_at
     FROM conversations c
     JOIN conversation_members cm_self
       ON cm_self.conversation_id = c.id
      AND cm_self.user_id = $1
     LEFT JOIN conversation_members cm_all
       ON cm_all.conversation_id = c.id
     LEFT JOIN LATERAL (
       SELECT m.id, m.sender_user_id, m.body, m.created_at
       FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON true
     GROUP BY c.id, lm.id, lm.sender_user_id, lm.body, lm.created_at
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC
     LIMIT $2`,
    [requesterId, limit],
  );

  const unreadRaw = await redis.hgetall(unreadHashKey(requesterId));

  return {
    userId: requesterId,
    conversations: result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      classId: row.class_id,
      groupId: row.group_id,
      createdAt: row.created_at,
      members: row.members || [],
      unreadCount: Math.max(0, Number(unreadRaw[row.id] || 0)),
      lastMessage: row.last_message_id
        ? {
            id: row.last_message_id,
            senderUserId: row.last_message_sender_user_id,
            body: row.last_message_body,
            createdAt: row.last_message_created_at,
          }
        : null,
    })),
  };
});

app.get("/conversations/group/:groupId", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const groupId = String(request.params.groupId || "").trim();
  if (!groupId) {
    return reply.code(400).send({ error: "groupId is required" });
  }

  if (!looksLikeUuid(groupId)) {
    return reply.code(400).send({ error: "groupId must be a valid UUID" });
  }

  const conversation = await getGroupConversationForUser(groupId, requesterId);
  if (!conversation) {
    return reply.code(404).send({ error: "group conversation not found for user" });
  }

  const members = await getConversationMemberIds(conversation.id);

  return {
    conversation: {
      ...formatConversationRow(conversation),
      members,
    },
  };
});

app.post("/conversations/dm", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const otherUserId = normalizeUserId((request.body || {}).otherUserId);

  if (!otherUserId) {
    return reply.code(400).send({ error: "otherUserId is required" });
  }

  if (otherUserId === requesterId) {
    return reply.code(400).send({ error: "cannot create DM with yourself" });
  }

  try {
    const payload = await createOrGetDmConversation(requesterId, otherUserId);
    if (payload.created) {
      return reply.code(201).send(payload);
    }
    return reply.send(payload);
  } catch (error) {
    request.log.error({ error, requesterId, otherUserId }, "failed to create DM conversation");
    return reply.code(500).send({ error: "internal error" });
  }
});

app.post("/conversations", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const body = request.body || {};
  const type = normalizeType(body.type);

  const memberUserIds = uniqueUserIds(Array.isArray(body.memberUserIds) ? body.memberUserIds : []);

  if (!type) {
    return reply.code(400).send({ error: "type must be DM, CLASS, or GROUP" });
  }

  if (type !== "DM") {
    return reply.code(403).send({ error: "only DM conversations can be created from this endpoint" });
  }

  if (memberUserIds.length !== 2) {
    return reply.code(400).send({ error: "DM conversations must include exactly two members" });
  }

  if (!memberUserIds.includes(requesterId)) {
    return reply.code(403).send({ error: "memberUserIds must include the authenticated user" });
  }

  const otherUserId = memberUserIds.find((userId) => userId !== requesterId) || "";
  if (!otherUserId) {
    return reply.code(400).send({ error: "cannot create DM with yourself" });
  }

  try {
    const payload = await createOrGetDmConversation(requesterId, otherUserId);
    if (payload.created) {
      return reply.code(201).send(payload);
    }
    return reply.send(payload);
  } catch (error) {
    request.log.error({ error }, "failed to create conversation");
    return reply.code(500).send({ error: "internal error" });
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

  try {
    const message = await persistAndFanoutMessage(conversationId, senderUserId, body);
    return reply.code(201).send({ message });
  } catch (error) {
    request.log.error({ error }, "failed to persist message");
    return reply.code(500).send({ error: "internal error" });
  }
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

app.get("/conversations/:conversationId/presence", async (request, reply) => {
  const requesterId = requireRequesterUserId(request, reply);
  if (!requesterId) {
    return;
  }

  const { conversationId } = request.params;
  const member = await isMember(conversationId, requesterId);
  if (!member) {
    return reply.code(403).send({ error: "not a member of this conversation" });
  }

  const onlineUserIds = await getConversationPresence(conversationId);
  return { conversationId, onlineUserIds };
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
  await ensureSchema();
  await connectProducer();
  await startGroupLifecycleConsumer();
  initSocketServer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start messaging-service");
  process.exit(1);
});
