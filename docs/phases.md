# Delivery Phases

## Phase 1 (Implemented)
Goal: establish a production-style foundation with minimal operational complexity.

Scope:
- Dockerized microservices + API gateway + edge proxy
- Event bus with Apache Kafka (KRaft)
- Redis for cache and ephemeral counters
- Separate PostgreSQL database per service domain
- Baseline web UI to exercise core APIs
- Structured logs and centralized logging stack

Definition of done:
- Services are containerized and wired through Docker Compose
- Core CRUD/event endpoints are reachable via gateway
- Events are published and consumed by recommendation service
- Logs are visible in Grafana via Loki datasource

## Phase 2 (Completed)
Goal: ship core product workflows.

Scope:
- JWT auth middleware and authorization checks
- UBC class catalog ingestion + search improvements
- Profile picture upload flow to object storage
- Group request lifecycle and moderation states
- Basic UI polish and validation

Implemented:
- Gateway JWT verification + protected-route enforcement
- Service-level ownership checks using trusted `x-user-id` identity headers
- Class catalog ingestion endpoint and enhanced search filters (`q`, `term`, `limit`)
- Group moderation endpoints (`list`, `approve`, `reject`) with owner-only authorization
- Profile image upload URL flow backed by S3-compatible object storage (MinIO)
- UI updates for secure calls, moderation actions, and image upload flow
- Auth re-platform to Auth0 with authorization-code + PKCE flow
- Refresh token persistence in `auth_db.oauth_refresh_sessions`

## Phase 3 (In Progress)
Goal: real-time collaboration features.

Scope:
- WebSocket chat gateway for DMs and group chat
- Presence/typing indicators backed by Redis
- Notification service (email + in-app)
- Better recommendation scoring with explainable reasons

Implemented in this iteration:
- Realtime WebSocket chat over Socket.IO (`/ws/socket.io`)
- Redis-backed online presence and per-conversation presence tracking
- Typing indicators broadcast to conversation members
- Realtime message send path with DB persistence + cache update + Kafka event publish
- React SPA shell with persisted Auth0 session flow (login/register gate + protected app routes)
- Class-centered UX: enrolled classes homepage, class detail views, group request actions, and profile/chats navigation
- Project sections as first-class class entities (with configurable max group size)
- Group lifecycle APIs: leave, transfer owner, disband, and \"my groups\" listing
- Auto-synced GROUP chat conversations when group membership changes
- Fast DM workflow and deep-link support from class roster/group cards into chat

## Phase 4
Goal: reliability and security hardening.

Scope:
- Automated DB migrations and seed pipelines
- Integration tests and contract tests
- Rate limits, abuse controls, audit logs
- Backup/restore drills and SLO instrumentation

## Phase 5
Goal: scale-out readiness.

Scope:
- Move from Compose to Kubernetes (k3s/EKS alternative)
- Kafka replication and partition strategy
- Service autoscaling and canary deployments
- Multi-environment CI/CD with GitHub Actions + GitOps
