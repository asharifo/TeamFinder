const fastify = require("fastify");
const cors = require("@fastify/cors");
const { Pool } = require("pg");
const { Kafka } = require("kafkajs");
const { decodeJwt } = require("jose");

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    base: { service: "auth-service" },
  },
});

const port = Number(process.env.PORT || 3001);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const auth0DomainRaw = String(process.env.AUTH0_DOMAIN || "").trim();
const auth0Domain = auth0DomainRaw.replace(/^https?:\/\//, "").replace(/\/$/, "");
const auth0IssuerBaseUrl = String(process.env.AUTH0_ISSUER_BASE_URL || `https://${auth0Domain}/`).trim();
const auth0ClientId = String(process.env.AUTH0_CLIENT_ID || "").trim();
const auth0ClientSecret = String(process.env.AUTH0_CLIENT_SECRET || "").trim();
const auth0Audience = String(process.env.AUTH0_AUDIENCE || "").trim();
const auth0DefaultRedirectUri = String(process.env.AUTH0_REDIRECT_URI || "http://localhost:8080/").trim();
const auth0Scopes = String(process.env.AUTH0_SCOPES || "openid profile email offline_access")
  .trim()
  .replace(/\s+/g, " ");
const auth0RequestTimeoutMs = Math.min(Math.max(Number(process.env.AUTH0_REQUEST_TIMEOUT_MS || 10000) || 10000, 1000), 60000);

const auth0TokenUrl = `${auth0IssuerBaseUrl.replace(/\/$/, "")}/oauth/token`;
const auth0RevokeUrl = `${auth0IssuerBaseUrl.replace(/\/$/, "")}/oauth/revoke`;

const auth0Configured = Boolean(auth0Domain && auth0ClientId && auth0ClientSecret && auth0Audience);

let producer = null;

async function fetchWithTimeout(url, init, timeoutMs = auth0RequestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error("request to Auth0 timed out");
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectProducer() {
  const broker = process.env.KAFKA_BROKER;
  if (!broker) {
    app.log.warn("KAFKA_BROKER is not set; events are disabled");
    return;
  }

  try {
    const kafka = new Kafka({ clientId: "auth-service", brokers: [broker] });
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
          key: payload.userId || payload.email || payload.sessionId,
          value: JSON.stringify({ ...payload, occurredAt: new Date().toISOString() }),
        },
      ],
    });
  } catch (error) {
    app.log.error({ error, topic }, "failed to publish event");
  }
}

function ensureAuth0Configured(reply) {
  if (!auth0Configured) {
    reply.code(503).send({ error: "Auth0 is not configured" });
    return false;
  }
  return true;
}

async function requestAuth0Token(body) {
  const response = await fetchWithTimeout(auth0TokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...body,
      client_id: auth0ClientId,
      client_secret: auth0ClientSecret,
    }),
  });

  let payload = null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    payload = { error: await response.text() };
  }

  if (!response.ok) {
    const message = payload.error_description || payload.error || "Auth0 token request failed";
    const error = new Error(message);
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

function parseIdentityFromIdToken(idToken) {
  try {
    const claims = decodeJwt(idToken);
    return {
      sub: String(claims.sub || "").trim(),
      email: claims.email ? String(claims.email) : "",
      name: claims.name ? String(claims.name) : "",
    };
  } catch (_error) {
    return {
      sub: "",
      email: "",
      name: "",
    };
  }
}

async function persistSession(identity, refreshToken, scope) {
  const result = await pool.query(
    `INSERT INTO oauth_refresh_sessions (auth0_sub, refresh_token, user_email, user_name, scope, created_at, updated_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
     RETURNING id, auth0_sub, user_email, user_name, scope, created_at, updated_at, last_used_at, revoked_at`,
    [identity.sub, refreshToken, identity.email, identity.name, scope || ""],
  );

  return result.rows[0];
}

async function updateSessionRefreshToken(sessionId, refreshToken, idToken) {
  const identity = idToken ? parseIdentityFromIdToken(idToken) : null;
  const result = await pool.query(
    `UPDATE oauth_refresh_sessions
     SET refresh_token = $2,
         user_email = COALESCE(NULLIF($3, ''), user_email),
         user_name = COALESCE(NULLIF($4, ''), user_name),
         updated_at = NOW(),
         last_used_at = NOW()
     WHERE id = $1
       AND revoked_at IS NULL
     RETURNING id, auth0_sub, user_email, user_name, scope, created_at, updated_at, last_used_at, revoked_at`,
    [sessionId, refreshToken, identity ? identity.email : "", identity ? identity.name : ""],
  );

  return result.rows[0] || null;
}

async function touchSession(sessionId) {
  await pool.query(
    `UPDATE oauth_refresh_sessions
     SET updated_at = NOW(),
         last_used_at = NOW()
     WHERE id = $1
       AND revoked_at IS NULL`,
    [sessionId],
  );
}

async function revokeSession(sessionId) {
  const result = await pool.query(
    `UPDATE oauth_refresh_sessions
     SET revoked_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND revoked_at IS NULL
     RETURNING id, auth0_sub, refresh_token`,
    [sessionId],
  );

  return result.rows[0] || null;
}

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return {
    status: "ok",
    service: "auth-service",
    auth0Configured,
  };
});

app.get("/public-config", async () => ({
  auth0Configured,
  domain: auth0Domain,
  clientId: auth0ClientId,
  audience: auth0Audience,
  issuerBaseUrl: auth0IssuerBaseUrl,
  redirectUri: auth0DefaultRedirectUri,
  scopes: auth0Scopes,
}));

app.post("/exchange-code", async (request, reply) => {
  if (!ensureAuth0Configured(reply)) {
    return;
  }

  const { code, codeVerifier, redirectUri } = request.body || {};
  if (!code || !codeVerifier) {
    return reply.code(400).send({ error: "code and codeVerifier are required" });
  }

  try {
    const tokens = await requestAuth0Token({
      grant_type: "authorization_code",
      code: String(code),
      code_verifier: String(codeVerifier),
      redirect_uri: redirectUri ? String(redirectUri) : auth0DefaultRedirectUri,
      audience: auth0Audience,
    });

    if (!tokens.refresh_token) {
      return reply.code(400).send({
        error: "refresh_token was not returned by Auth0. Ensure offline_access scope is enabled and API settings allow refresh tokens.",
      });
    }

    const identity = parseIdentityFromIdToken(tokens.id_token || "");
    if (!identity.sub) {
      return reply.code(400).send({ error: "failed to parse user identity from id_token" });
    }

    const session = await persistSession(identity, tokens.refresh_token, tokens.scope || "");

    await publish("user.authenticated", {
      userId: identity.sub,
      email: identity.email,
      name: identity.name,
      sessionId: session.id,
    });

    return reply.send({
      session: {
        id: session.id,
        user: {
          id: identity.sub,
          email: identity.email,
          name: identity.name,
        },
      },
      tokens: {
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        tokenType: tokens.token_type || "Bearer",
        expiresIn: tokens.expires_in || 0,
        scope: tokens.scope || "",
      },
    });
  } catch (error) {
    request.log.error({ error }, "Auth0 code exchange failed");
    const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return reply.code(statusCode).send({ error: error.message || "code exchange failed" });
  }
});

app.post("/refresh", async (request, reply) => {
  if (!ensureAuth0Configured(reply)) {
    return;
  }

  const { sessionId } = request.body || {};
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId is required" });
  }

  const sessionResult = await pool.query(
    `SELECT id, auth0_sub, refresh_token
     FROM oauth_refresh_sessions
     WHERE id = $1
       AND revoked_at IS NULL`,
    [sessionId],
  );

  if (sessionResult.rowCount === 0) {
    return reply.code(404).send({ error: "session not found" });
  }

  const session = sessionResult.rows[0];

  try {
    const tokens = await requestAuth0Token({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
      audience: auth0Audience,
    });

    const rotatedRefreshToken = tokens.refresh_token || session.refresh_token;
    const updatedSession = await updateSessionRefreshToken(session.id, rotatedRefreshToken, tokens.id_token || "");
    if (!updatedSession) {
      return reply.code(404).send({ error: "session not found" });
    }

    if (!tokens.refresh_token) {
      await touchSession(session.id);
    }

    return reply.send({
      session: {
        id: updatedSession.id,
      },
      tokens: {
        accessToken: tokens.access_token,
        idToken: tokens.id_token,
        tokenType: tokens.token_type || "Bearer",
        expiresIn: tokens.expires_in || 0,
        scope: tokens.scope || "",
      },
    });
  } catch (error) {
    if (String(error.message || "").toLowerCase().includes("invalid_grant")) {
      await revokeSession(session.id);
    }

    request.log.error({ error }, "Auth0 refresh failed");
    const statusCode = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    return reply.code(statusCode).send({ error: error.message || "refresh failed" });
  }
});

app.post("/logout", async (request, reply) => {
  if (!ensureAuth0Configured(reply)) {
    return;
  }

  const { sessionId } = request.body || {};
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId is required" });
  }

  const session = await revokeSession(sessionId);
  if (!session) {
    return reply.code(404).send({ error: "session not found" });
  }

  try {
    await fetchWithTimeout(auth0RevokeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: auth0ClientId,
        client_secret: auth0ClientSecret,
        token: session.refresh_token,
      }),
    });
  } catch (error) {
    request.log.warn({ error }, "failed to revoke refresh token at Auth0");
  }

  await publish("user.logged_out", {
    userId: session.auth0_sub,
    sessionId,
  });

  return reply.send({ loggedOut: true, sessionId });
});

async function start() {
  await app.register(cors, { origin: true });
  await connectProducer();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start auth-service");
  process.exit(1);
});
