const fastify = require("fastify");
const cors = require("@fastify/cors");
const { createRemoteJWKSet, jwtVerify } = require("jose");

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    base: { service: "gateway" },
  },
});

const port = Number(process.env.PORT || 3000);
const upstreamTimeoutMs = Math.min(Math.max(Number(process.env.UPSTREAM_TIMEOUT_MS || 10000) || 10000, 1000), 60000);

const corsAllowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "http://localhost:8080")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const auth0IssuerBaseUrl = String(process.env.AUTH0_ISSUER_BASE_URL || "").trim();
const auth0Audience = String(process.env.AUTH0_AUDIENCE || "").trim();
const auth0Configured = Boolean(auth0IssuerBaseUrl && auth0Audience);

const issuer = auth0IssuerBaseUrl.endsWith("/") ? auth0IssuerBaseUrl : `${auth0IssuerBaseUrl}/`;
const jwksUri = auth0Configured ? new URL(`${issuer}.well-known/jwks.json`) : null;
const jwks = jwksUri ? createRemoteJWKSet(jwksUri) : null;

const serviceMap = {
  "/api/auth": process.env.AUTH_SERVICE_URL || "http://auth-service:3001",
  "/api/profiles": process.env.PROFILE_SERVICE_URL || "http://profile-service:3002",
  "/api/classes": process.env.CLASS_SERVICE_URL || "http://class-service:3003",
  "/api/messages": process.env.MESSAGING_SERVICE_URL || "http://messaging-service:3004",
  "/api/recommendations": process.env.RECOMMENDATION_SERVICE_URL || "http://recommendation-service:3005",
};

function normalizeHeaders(headers) {
  const out = { ...headers };
  delete out.host;
  delete out["content-length"];
  delete out.connection;
  delete out.Connection;
  delete out.upgrade;
  delete out.Upgrade;
  delete out["proxy-connection"];
  delete out["transfer-encoding"];
  delete out.te;
  delete out.trailer;
  delete out["keep-alive"];
  delete out.authorization;
  delete out.Authorization;
  return out;
}

function getBearerToken(request) {
  const header = request.headers.authorization || request.headers.Authorization;
  if (!header || typeof header !== "string") {
    return null;
  }

  const [scheme, token] = header.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token.trim();
}

function requiresAuth(prefix, method, path) {
  if (prefix === "/api/auth") {
    return false;
  }

  if (prefix === "/api/classes" && method === "POST" && (path === "/ingest" || path === "/ingest/")) {
    return false;
  }

  return true;
}

function resolveCorsOrigins() {
  if (corsAllowedOrigins.length === 0 || corsAllowedOrigins.includes("*")) {
    return true;
  }
  if (corsAllowedOrigins.length === 1) {
    return corsAllowedOrigins[0];
  }
  return corsAllowedOrigins;
}

async function fetchWithTimeout(url, init, timeoutMs = upstreamTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function decodeUser(request) {
  const token = getBearerToken(request);
  if (!token) {
    return { user: null, error: null };
  }

  if (!auth0Configured || !jwks) {
    return { user: null, error: "auth0 not configured" };
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: auth0Audience,
    });
    return { user: payload, error: null };
  } catch (_error) {
    return { user: null, error: "invalid token" };
  }
}

async function proxy(prefix, targetBase, request, reply) {
  try {
    const wildcard = (request.params && request.params["*"]) || "";
    const query = request.raw.url.includes("?") ? `?${request.raw.url.split("?")[1]}` : "";
    const path = wildcard ? `/${wildcard}` : "/";
    const targetUrl = `${targetBase}${path}${query}`;
    const method = request.method.toUpperCase();

    const shouldDecodeUser = prefix !== "/api/auth";
    const { user, error } = shouldDecodeUser ? await decodeUser(request) : { user: null, error: null };
    if (error && error !== null) {
      return reply.code(401).send({ error: "invalid or expired token" });
    }

    if (requiresAuth(prefix, method, path) && !user) {
      return reply.code(401).send({ error: "authentication required" });
    }

    const headers = normalizeHeaders(request.headers);
    headers["x-request-id"] = request.id;

    if (user && typeof user === "object") {
      if (user.sub) {
        headers["x-user-id"] = String(user.sub);
      }
      if (user.email) {
        headers["x-user-email"] = String(user.email);
      }
      if (user.name) {
        headers["x-user-name"] = String(user.name);
      }
    }

    const init = { method, headers };
    if (!["GET", "HEAD"].includes(method) && request.body !== undefined) {
      init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      if (!headers["content-type"]) {
        headers["content-type"] = "application/json";
      }
    }

    const upstream = await fetchWithTimeout(targetUrl, init);
    const contentType = upstream.headers.get("content-type") || "application/json";
    const body = contentType.includes("application/json") ? await upstream.json() : await upstream.text();

    reply.code(upstream.status).header("content-type", contentType).send(body);
  } catch (error) {
    if (error && error.name === "AbortError") {
      return reply.code(504).send({ error: "upstream request timed out" });
    }

    request.log.error(
      {
        err: {
          message: error?.message,
          stack: error?.stack,
          cause: error?.cause ? String(error.cause) : undefined,
        },
        prefix,
        targetBase,
      },
      "proxy request failed",
    );
    reply.code(502).send({ error: "upstream service unavailable" });
  }
}

async function registerProxy(prefix, targetBase) {
  app.all(prefix, (request, reply) => proxy(prefix, targetBase, request, reply));
  app.all(`${prefix}/*`, (request, reply) => proxy(prefix, targetBase, request, reply));
}

async function start() {
  await app.register(cors, { origin: resolveCorsOrigins() });

  for (const [prefix, target] of Object.entries(serviceMap)) {
    await registerProxy(prefix, target);
    app.log.info({ prefix, target }, "proxy route registered");
  }

  app.get("/health", async () => ({ status: "ok", service: "gateway", auth0Configured }));

  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((error) => {
  app.log.error({ error }, "failed to start gateway");
  process.exit(1);
});
