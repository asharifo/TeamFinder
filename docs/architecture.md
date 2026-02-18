# Architecture (Phase 1)

## Runtime Topology
- Edge: `edge-proxy` (Nginx)
- API entrypoint: `gateway`
- Domain services: `auth-service`, `profile-service`, `class-service`, `messaging-service`, `recommendation-service`
- Event bus: Apache Kafka (KRaft, single broker for MVP)
- Cache/state acceleration: Redis
- Data stores: one PostgreSQL instance per service domain (no shared app DB)
- Object storage: MinIO (S3-compatible profile image uploads via signed URLs)
- Logging: service JSON logs -> Vector -> Loki -> Grafana
- Identity provider: Auth0 (OIDC/OAuth2, PKCE, rotating refresh tokens)

## Event Topics
- `user.authenticated`
- `user.logged_out`
- `profile.updated`
- `class.enrollment.created`
- `group.created`
- `group.join.requested`
- `group.member.added`
- `group.request.rejected`
- `chat.message.sent`

## Data Ownership
- Auth DB owns users and credentials.
- Profile DB owns user profile attributes.
- Class DB owns class catalog, enrollments, groups, requests, group members.
- Messaging DB owns conversations and persisted messages (including auto-managed group chats).
- Recommendation DB owns projections and recommendation scores.

## Why This Shape
- Keeps bounded contexts decoupled via DB isolation.
- Preserves event-driven evolution with Kafka.
- Uses Redis only for hot data (message cache, unread counters), not source-of-truth persistence.
- Enforces identity at gateway and authorization within services for defense-in-depth.
- Uses Auth0 for identity lifecycle while persisting refresh sessions server-side.
- Adds Socket.IO for Phase 3 realtime collaboration with Redis presence state.
- Avoids Kubernetes complexity in Phase 1 while keeping migration path open.
