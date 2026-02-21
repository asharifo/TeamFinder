# TeamFinder

TeamFinder is a microservices-based web app for UBC students to find teammates and study groups by class.

This repository now includes **Phase 1 + Phase 2 + Phase 3 core workflows**:
- Dockerized microservices
- Event-driven backbone using Apache Kafka (KRaft mode)
- Redis for chat cache, unread counters, and realtime presence
- Separate PostgreSQL database per bounded context (no shared application DB)
- API gateway + edge proxy
- Auth0-based authentication (authorization code + PKCE + refresh token persistence)
- Realtime chat via Socket.IO (`/ws/socket.io`)
- Structured logging pipeline (Vector -> Loki -> Grafana)
- React frontend (Vite) with Auth0 login/register flow and persisted sessions
- Project-section based group formation, moderation, and auto-synced group chats

## Services
- `web`: React SPA frontend (homepage, chats, profile, class detail flows)
- `gateway`: API gateway and Auth0 access-token verification
- `auth-service`: Auth0 code exchange, refresh, logout, persisted refresh sessions
- `profile-service`: profile management and signed profile-picture uploads
- `class-service`: classes, enrollments, groups, moderation lifecycle
- `messaging-service`: conversations, DM helper APIs, realtime websocket chat/presence
- `recommendation-service`: consumes Kafka events and computes compatibility recommendations

## Infra
- `edge-proxy` (Nginx): routes frontend, API, and websocket traffic
- `kafka`: Apache Kafka broker in KRaft mode
- `redis`: cache + unread + presence
- `minio`: S3-compatible object storage for profile images
- `*-db`: isolated PostgreSQL instances per domain
- `vector`, `loki`, `grafana`: centralized logging pipeline

## Quick Start
1. Copy env template and fill Auth0 settings:
   ```bash
   cp .env.example .env
   ```
   Required secure values in `.env`:
   - `POSTGRES_PASSWORD`
   - `INTERNAL_SERVICE_TOKEN`
   - `INGEST_TOKEN`
   - `MINIO_ROOT_USER`
   - `MINIO_ROOT_PASSWORD`
   - `S3_ACCESS_KEY`
   - `S3_SECRET_KEY`
   - `GRAFANA_ADMIN_USER`
   - `GRAFANA_ADMIN_PASSWORD`
2. Build and run:
   ```bash
   docker compose up --build
   ```
3. Open:
- App: `http://localhost:8080`
- Grafana: `http://localhost:3000` (use `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` from your `.env`)
- MinIO API: `http://localhost:9000`
- MinIO Console: `http://localhost:9001` (use `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` from your `.env`)

Notes for profile image uploads and local dev:
- Set `S3_PUBLIC_ENDPOINT` to a browser-reachable URL (default: `http://localhost:9000`).
- Use `ALLOWED_ORIGINS` for MinIO CORS (for example `http://localhost:8080,http://localhost:5173`).
- If you change upload/CORS env values, recreate `profile-service` and rerun `minio-init`.

4. Optional class ingestion after boot:
   ```bash
   ./scripts/ingest-sample-classes.sh
   ```

## Auth0 Setup Notes
- Create a Regular Web Application in Auth0.
- Create an Auth0 API (Dashboard -> Applications -> APIs) and set its **Identifier** to the same value used in `AUTH0_AUDIENCE` (for example `https://teamfinder-api`).
- Authorize your Regular Web Application to access that API (App -> APIs tab / API access settings), and grant the scopes your app requests.
- If your API's user access policy is **Allow via client-grant**, define at least one API permission and include it in `AUTH0_SCOPES` (for example `openid profile email offline_access read:messages`). If you do not need API permission checks yet, set user access policy to **Allow**.
- Enable Authorization Code Flow with PKCE.
- Add callback URL: `http://localhost:8080/`
- Add logout URL: `http://localhost:8080/`
- Configure API audience used in `AUTH0_AUDIENCE`.
- Include `offline_access` scope and enable refresh tokens.

## Documentation
- Phase plan: `docs/phases.md`
- Architecture: `docs/architecture.md`
- UI design system: `docs/design-system.md`
- API notes: `docs/api-phase2.md`
