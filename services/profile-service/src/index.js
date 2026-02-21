const fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Kafka } = require("kafkajs");
const { randomUUID } = require("crypto");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
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
const s3PublicEndpoint = process.env.S3_PUBLIC_ENDPOINT || s3Endpoint;
const s3Region = process.env.S3_REGION || "us-east-1";
const s3AccessKey = process.env.S3_ACCESS_KEY || "";
const s3SecretKey = process.env.S3_SECRET_KEY || "";

function createS3Client(endpoint) {
  return new S3Client({
    region: s3Region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
    },
  });
}

const s3Enabled = Boolean(bucketName && s3Endpoint && s3PublicEndpoint && s3AccessKey && s3SecretKey);
const s3Client = s3Enabled ? createS3Client(s3Endpoint) : null;
const s3PresignClient = s3Enabled ? createS3Client(s3PublicEndpoint) : null;
const universitySkillCatalog = Array.from(
  new Set([
    "Academic Advising",
    "Academic Integrity",
    "Academic Research",
    "Algorithm Design",
    "Analytical Reasoning",
    "Android Development",
    "Applied Calculus",
    "Applied Statistics",
    "Argumentation",
    "Arduino",
    "Artificial Intelligence",
    "Audience Analysis",
    "AutoCAD",
    "Bioinformatics",
    "Biology Lab Techniques",
    "Biostatistics",
    "Business Analysis",
    "Business Writing",
    "C Programming",
    "C++",
    "CAD Modeling",
    "Case Study Analysis",
    "Cell Culture",
    "Chemical Safety",
    "Chemistry Lab Techniques",
    "Circuit Analysis",
    "Clinical Documentation",
    "Cloud Computing",
    "Communication Skills",
    "Comparative Analysis",
    "Computational Modeling",
    "Computer Networks",
    "Conflict Resolution",
    "Content Strategy",
    "Critical Reading",
    "Critical Thinking",
    "Cross-Functional Collaboration",
    "Curriculum Design",
    "Cybersecurity",
    "Data Analysis",
    "Data Cleaning",
    "Data Ethics",
    "Data Governance",
    "Data Management",
    "Data Modeling",
    "Data Storytelling",
    "Data Structures",
    "Database Design",
    "Database Management",
    "Deep Learning",
    "Design Thinking",
    "Digital Accessibility",
    "Digital Logic",
    "Digital Marketing",
    "Discrete Mathematics",
    "Discussion Facilitation",
    "Documentation",
    "Econometrics",
    "Economic Analysis",
    "Editorial Writing",
    "Electrical Engineering Fundamentals",
    "Embedded Systems",
    "Environmental Analysis",
    "Ethical Decision-Making",
    "Experiment Design",
    "Experimental Physics",
    "Figma",
    "Field Research",
    "Financial Analysis",
    "Forecasting",
    "Frontend Development",
    "Full-Stack Development",
    "Game Development",
    "Genetics",
    "GIS",
    "Git",
    "Go",
    "Google Analytics",
    "Grant Writing",
    "Graphic Design",
    "Group Facilitation",
    "Healthcare Data Analysis",
    "Human-Computer Interaction",
    "Hypothesis Testing",
    "Information Architecture",
    "Information Literacy",
    "Innovation Management",
    "Instructional Design",
    "Instrument Calibration",
    "Interviewing",
    "iOS Development",
    "Java",
    "JavaScript",
    "Journal Article Review",
    "Journalism",
    "Jupyter",
    "Kotlin",
    "Lab Reporting",
    "Laboratory Safety",
    "Leadership",
    "Linear Algebra",
    "Literature Review",
    "Machine Learning",
    "Marketing Research",
    "Mathematical Proofs",
    "Matlab",
    "Mechanical Design",
    "Medical Terminology",
    "Mentorship",
    "Microeconomics",
    "Microsoft Excel",
    "Molecular Biology",
    "Multivariable Calculus",
    "Natural Language Processing",
    "Negotiation",
    "Network Security",
    "Neural Networks",
    "Nursing Fundamentals",
    "Object-Oriented Programming",
    "Operations Research",
    "Organic Chemistry",
    "Peer Review",
    "Policy Analysis",
    "Population Health",
    "Poster Design",
    "Presentation Skills",
    "Problem Solving",
    "Product Management",
    "Program Evaluation",
    "Project Coordination",
    "Project Management",
    "Proofreading",
    "Psychological Assessment",
    "Public Health Research",
    "Public Speaking",
    "Public Policy",
    "Python",
    "Qualitative Analysis",
    "Quantitative Analysis",
    "React",
    "Regression Analysis",
    "Research Methods",
    "Research Synthesis",
    "Risk Analysis",
    "R Programming",
    "Robotics",
    "Scientific Computing",
    "Scientific Communication",
    "Scientific Writing",
    "SDLC",
    "Seminar Leadership",
    "Signal Processing",
    "Social Media Strategy",
    "Sociological Theory",
    "Software Architecture",
    "Software Debugging",
    "Software Design",
    "Software Engineering",
    "Software Testing",
    "SolidWorks",
    "SPSS",
    "SQL",
    "Statistical Inference",
    "Strategic Planning",
    "Survey Design",
    "Sustainability Analysis",
    "System Design",
    "Tableau",
    "Team Collaboration",
    "Technical Communication",
    "Technical Writing",
    "Thermodynamics",
    "Time Management",
    "TypeScript",
    "UI Design",
    "User Interviews",
    "User Research",
    "UX Design",
    "Version Control",
    "Video Editing",
    "Web Accessibility",
    "Web Development",
    "Wireless Communications",
    "Workshop Facilitation",
  ]),
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

function getRequesterUserName(request) {
  const raw = request.headers["x-user-name"];
  if (!raw || typeof raw !== "string") {
    return "";
  }
  return raw.trim();
}

function getRequesterUserEmail(request) {
  const raw = request.headers["x-user-email"];
  if (!raw || typeof raw !== "string") {
    return "";
  }
  return raw.trim();
}

function toArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#&/\-.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampSearchLimit(raw, fallback = 20, max = 60) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function searchUniversitySkills(query, limit) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return universitySkillCatalog.slice(0, limit);
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const queryLength = normalizedQuery.length;
  const matches = [];

  for (const skill of universitySkillCatalog) {
    const normalizedSkill = normalizeSearchText(skill);
    if (tokens.some((token) => !normalizedSkill.includes(token))) {
      continue;
    }

    let score = 0;
    if (normalizedSkill === normalizedQuery) {
      score += 1000;
    }
    if (normalizedSkill.startsWith(normalizedQuery)) {
      score += 400;
    }

    const firstIndex = normalizedSkill.indexOf(normalizedQuery);
    if (firstIndex >= 0) {
      score += Math.max(0, 200 - firstIndex);
    }

    score += Math.max(0, 80 - Math.abs(normalizedSkill.length - queryLength));
    matches.push({ skill, score });
  }

  return matches
    .sort((left, right) => right.score - left.score || left.skill.localeCompare(right.skill))
    .slice(0, limit)
    .map((item) => item.skill);
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

function resolveObjectKey(profilePictureUrl) {
  const normalized = String(profilePictureUrl || "").trim();
  if (!normalized || !bucketName) {
    return "";
  }

  const prefix = `s3://${bucketName}/`;
  if (!normalized.startsWith(prefix)) {
    return "";
  }

  return normalized.slice(prefix.length).trim();
}

async function buildProfilePictureViewUrl(profilePictureUrl) {
  const normalized = String(profilePictureUrl || "").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return normalized;
  }

  const objectKey = resolveObjectKey(normalized);
  if (!objectKey || !s3Enabled || !s3PresignClient) {
    return "";
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
    });
    return await getSignedUrl(s3PresignClient, command, { expiresIn: 3600 });
  } catch (_error) {
    return "";
  }
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

async function ensureSchema() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS profiles (
      user_id TEXT PRIMARY KEY,
      about TEXT NOT NULL DEFAULT '',
      classes TEXT[] NOT NULL DEFAULT '{}',
      skills TEXT[] NOT NULL DEFAULT '{}',
      profile_picture_url TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  );

  // Legacy column from older schema versions.
  await pool.query(`ALTER TABLE profiles DROP COLUMN IF EXISTS availability`);
}

async function publishProfileEvents(profile, request) {
  const userName = getRequesterUserName(request);
  const userEmail = getRequesterUserEmail(request);
  const payload = {
    userId: profile.user_id,
    userName,
    email: userEmail,
    skills: profile.skills,
    about: profile.about,
    classes: profile.classes,
    profilePictureUrl: profile.profile_picture_url,
  };

  await publish("profile.updated", payload);
  await publish("user.profile.upserted", payload);
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

function ensureSelfAccess(request, reply, userId) {
  const requesterId = getRequesterUserId(request);
  if (!requesterId) {
    reply.code(401).send({ error: "missing authenticated user context" });
    return false;
  }

  if (requesterId !== userId) {
    reply.code(403).send({ error: "cannot access another user profile" });
    return false;
  }

  return true;
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", service: "profile-service", objectStorageEnabled: s3Enabled };
});

app.get("/skills/search", async (request, reply) => {
  const requesterId = getRequesterUserId(request);
  if (!requesterId) {
    return reply.code(401).send({ error: "missing authenticated user context" });
  }

  const q = typeof request.query.q === "string" ? request.query.q : "";
  const limit = clampSearchLimit(request.query.limit, 20, 60);
  return reply.send({ skills: searchUniversitySkills(q, limit) });
});

app.get("/:userId", async (request, reply) => {
  const { userId } = request.params;
  if (!ensureSelfAccess(request, reply, userId)) {
    return;
  }

  const result = await pool.query(
    `SELECT user_id, about, classes, skills, profile_picture_url, updated_at
     FROM profiles
     WHERE user_id = $1`,
    [userId],
  );

  if (result.rowCount === 0) {
    return reply.code(404).send({ error: "profile not found" });
  }

  const profile = result.rows[0];
  const profilePictureViewUrl = await buildProfilePictureViewUrl(profile.profile_picture_url);

  return reply.send({
    profile: {
      ...profile,
      profile_picture_view_url: profilePictureViewUrl,
    },
  });
});

app.put("/:userId", async (request, reply) => {
  const { userId } = request.params;
  if (!ensureOwner(request, reply, userId)) {
    return;
  }

  const body = request.body || {};
  const about = typeof body.about === "string" ? body.about : "";
  const profilePictureUrl = typeof body.profilePictureUrl === "string" ? body.profilePictureUrl : "";
  const skills = toArray(body.skills);
  const classes = toArray(body.classes);

  try {
    const result = await pool.query(
      `INSERT INTO profiles (user_id, about, classes, skills, profile_picture_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET about = EXCLUDED.about,
                     classes = EXCLUDED.classes,
                     skills = EXCLUDED.skills,
                     profile_picture_url = EXCLUDED.profile_picture_url,
                     updated_at = NOW()
       RETURNING user_id, about, classes, skills, profile_picture_url, updated_at`,
      [userId, about, classes, skills, profilePictureUrl],
    );

    const profile = result.rows[0];
    const profilePictureViewUrl = await buildProfilePictureViewUrl(profile.profile_picture_url);

    await publishProfileEvents(profile, request);

    return reply.send({
      profile: {
        ...profile,
        profile_picture_view_url: profilePictureViewUrl,
      },
    });
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

  if (!s3Enabled || !s3Client || !s3PresignClient) {
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

    const uploadUrl = await getSignedUrl(s3PresignClient, command, { expiresIn: 900 });
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
      `INSERT INTO profiles (user_id, about, classes, skills, profile_picture_url, updated_at)
       VALUES ($1, '', '{}', '{}', $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET profile_picture_url = EXCLUDED.profile_picture_url,
                     updated_at = NOW()
       RETURNING user_id, about, classes, skills, profile_picture_url, updated_at`,
      [userId, profilePictureUrl],
    );

    const profile = result.rows[0];
    const savedPictureUrl = profile.profile_picture_url;
    const profilePictureViewUrl = await buildProfilePictureViewUrl(savedPictureUrl);
    await publishProfileEvents(profile, request);

    return reply.send({
      profilePictureUrl: savedPictureUrl,
      profilePictureViewUrl,
      updatedAt: profile.updated_at,
    });
  } catch (error) {
    request.log.error({ error }, "failed to confirm profile picture");
    return reply.code(500).send({ error: "internal error" });
  }
});

async function start() {
  await app.register(cors, { origin: true });
  await ensureSchema();
  await connectProducer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start profile-service");
  process.exit(1);
});
