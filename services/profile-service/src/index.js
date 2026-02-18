const fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Kafka } = require("kafkajs");
const { randomUUID } = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    base: { service: "profile-service" },
  },
});

const port = Number(process.env.PORT || 3002);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const bucketName = process.env.S3_BUCKET || "";
const s3Endpoint = process.env.S3_ENDPOINT || "";
const s3Region = process.env.S3_REGION || "us-east-1";
const s3AccessKey = process.env.S3_ACCESS_KEY || "";
const s3SecretKey = process.env.S3_SECRET_KEY || "";

const s3Enabled = Boolean(bucketName && s3Endpoint && s3AccessKey && s3SecretKey);
const s3Client = s3Enabled
  ? new S3Client({
      region: s3Region,
      endpoint: s3Endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: s3AccessKey,
        secretAccessKey: s3SecretKey,
      },
    })
  : null;

let producer = null;

function getRequesterUserId(request) {
  const raw = request.headers["x-user-id"];
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim();
  return normalized || null;
}

function toArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeContentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(normalized)) {
    return normalized;
  }
  return "image/jpeg";
}

function extensionFromContentType(contentType) {
  if (contentType === "image/png") {
    return "png";
  }
  if (contentType === "image/webp") {
    return "webp";
  }
  if (contentType === "image/gif") {
    return "gif";
  }
  return "jpg";
}

async function connectProducer() {
  const broker = process.env.KAFKA_BROKER;
  if (!broker) {
    app.log.warn("KAFKA_BROKER is not set; events are disabled");
    return;
  }

  try {
    const kafka = new Kafka({ clientId: "profile-service", brokers: [broker] });
    producer = kafka.producer();
    await producer.connect();
    app.log.info("connected to kafka");
  } catch (error) {
    producer = null;
    app.log.error({ error }, "failed to connect kafka producer; continuing without events");
  }
}

async function publish(topic, payload) {
  if (!producer) {
    return;
  }

  try {
    await producer.send({
      topic,
      messages: [
        {
          key: payload.userId,
          value: JSON.stringify({ ...payload, occurredAt: new Date().toISOString() }),
        },
      ],
    });
  } catch (error) {
    app.log.error({ error, topic }, "failed to publish event");
  }
}

function ensureOwner(request, reply, userId) {
  const requesterId = getRequesterUserId(request);
  if (!requesterId) {
    reply.code(401).send({ error: "missing authenticated user context" });
    return false;
  }

  if (requesterId !== userId) {
    reply.code(403).send({ error: "cannot modify another user profile" });
    return false;
  }

  return true;
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", service: "profile-service", objectStorageEnabled: s3Enabled };
});

app.get("/:userId", async (request, reply) => {
  const { userId } = request.params;

  const result = await pool.query(
    `SELECT user_id, about, classes, skills, availability, profile_picture_url, updated_at
     FROM profiles
     WHERE user_id = $1`,
    [userId],
  );

  if (result.rowCount === 0) {
    return reply.code(404).send({ error: "profile not found" });
  }

  return reply.send({ profile: result.rows[0] });
});

app.put("/:userId", async (request, reply) => {
  const { userId } = request.params;
  if (!ensureOwner(request, reply, userId)) {
    return;
  }

  const body = request.body || {};
  const about = typeof body.about === "string" ? body.about : "";
  const availability = typeof body.availability === "string" ? body.availability : "";
  const profilePictureUrl = typeof body.profilePictureUrl === "string" ? body.profilePictureUrl : "";
  const skills = toArray(body.skills);
  const classes = toArray(body.classes);

  try {
    const result = await pool.query(
      `INSERT INTO profiles (user_id, about, classes, skills, availability, profile_picture_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET about = EXCLUDED.about,
                     classes = EXCLUDED.classes,
                     skills = EXCLUDED.skills,
                     availability = EXCLUDED.availability,
                     profile_picture_url = EXCLUDED.profile_picture_url,
                     updated_at = NOW()
       RETURNING user_id, about, classes, skills, availability, profile_picture_url, updated_at`,
      [userId, about, classes, skills, availability, profilePictureUrl],
    );

    const profile = result.rows[0];

    await publish("profile.updated", {
      userId: profile.user_id,
      skills: profile.skills,
      about: profile.about,
      classes: profile.classes,
    });

    return reply.send({ profile });
  } catch (error) {
    request.log.error({ error }, "failed to upsert profile");
    return reply.code(500).send({ error: "internal error" });
  }
});

app.post("/:userId/picture/upload-url", async (request, reply) => {
  const { userId } = request.params;
  if (!ensureOwner(request, reply, userId)) {
    return;
  }

  if (!s3Enabled || !s3Client) {
    return reply.code(503).send({ error: "object storage is not configured" });
  }

  const contentType = normalizeContentType((request.body || {}).contentType);
  const extension = extensionFromContentType(contentType);
  const objectKey = `${userId}/${Date.now()}-${randomUUID()}.${extension}`;

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
    return reply.send({
      bucket: bucketName,
      objectKey,
      uploadUrl,
      expiresInSeconds: 900,
      contentType,
    });
  } catch (error) {
    request.log.error({ error }, "failed to generate signed upload url");
    return reply.code(500).send({ error: "failed to generate upload url" });
  }
});

app.post("/:userId/picture/confirm", async (request, reply) => {
  const { userId } = request.params;
  if (!ensureOwner(request, reply, userId)) {
    return;
  }

  const objectKey = String((request.body || {}).objectKey || "").trim();
  if (!objectKey) {
    return reply.code(400).send({ error: "objectKey is required" });
  }

  const profilePictureUrl = `s3://${bucketName}/${objectKey}`;

  try {
    const result = await pool.query(
      `INSERT INTO profiles (user_id, about, classes, skills, availability, profile_picture_url, updated_at)
       VALUES ($1, '', '{}', '{}', '', $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET profile_picture_url = EXCLUDED.profile_picture_url,
                     updated_at = NOW()
       RETURNING user_id, profile_picture_url, updated_at`,
      [userId, profilePictureUrl],
    );

    return reply.send({
      profilePictureUrl: result.rows[0].profile_picture_url,
      updatedAt: result.rows[0].updated_at,
    });
  } catch (error) {
    request.log.error({ error }, "failed to confirm profile picture");
    return reply.code(500).send({ error: "internal error" });
  }
});

async function start() {
  await app.register(cors, { origin: true });
  await connectProducer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start profile-service");
  process.exit(1);
});
