# API Notes (Phase 2 + Phase 3 in progress)

## Authentication (Auth0-backed)
- `GET /api/auth/public-config`
- `POST /api/auth/exchange-code` body: `{ code, codeVerifier, redirectUri }`
- `POST /api/auth/refresh` body: `{ sessionId }`
- `POST /api/auth/logout` body: `{ sessionId }`

Gateway verifies Auth0 access tokens and forwards trusted headers:
- `x-user-id`
- `x-user-email`
- `x-user-name`

## Profiles
- `GET /api/profiles/:userId`
- `PUT /api/profiles/:userId` (self only)
- `POST /api/profiles/:userId/picture/upload-url` (self only)
- `POST /api/profiles/:userId/picture/confirm` (self only)

## Classes and Groups
- `GET /api/classes?q=<text>&term=<text>&limit=<n>`
- `POST /api/classes/ingest` (requires `x-ingest-token`)
- `POST /api/classes/enrollments` (auth, body: `{ "classId": "CPSC210" }`)
- `GET /api/classes/enrollments/me` (auth)
- `GET /api/classes/groups/me?classId=<id>` (auth)
- `GET /api/classes/:classId/members`
- `GET /api/classes/:classId/project-sections`
- `POST /api/classes/:classId/project-sections` (auth, enrolled users)
- `GET /api/classes/:classId/groups`
- `POST /api/classes/:classId/groups` (auth)
- `GET /api/classes/groups/:groupId` (auth)
- `POST /api/classes/groups/:groupId/requests` (auth)
- `GET /api/classes/groups/:groupId/requests?status=ALL|PENDING|APPROVED|REJECTED` (owner only)
- `POST /api/classes/groups/:groupId/requests/:userId/approve` (owner only)
- `POST /api/classes/groups/:groupId/requests/:userId/reject` (owner only)
- `POST /api/classes/groups/:groupId/leave` (auth member only)
- `POST /api/classes/groups/:groupId/transfer-owner` (owner only)
- `DELETE /api/classes/groups/:groupId` (owner only)

## Messaging HTTP
- `GET /api/messages/conversations?limit=<n>` (auth, member-only list)
- `GET /api/messages/conversations/group/:groupId` (auth, group-member only)
- `POST /api/messages/conversations/dm` (auth, body: `{ "otherUserId": "auth0|..." }`)
- `POST /api/messages/conversations` (auth)
- `POST /api/messages/conversations/:conversationId/messages` (auth)
- `GET /api/messages/conversations/:conversationId/messages` (member only)
- `GET /api/messages/conversations/:conversationId/presence` (member only)
- `POST /api/messages/conversations/:conversationId/read` (member only)
- `GET /api/messages/users/:userId/unread` (self only)

## Internal Service-to-Service
- `POST /internal/group-conversations/sync` on messaging-service (requires `x-internal-token`)
  - Used by class-service to create/update/delete GROUP conversations as group membership changes.

## Realtime (Socket.IO)
- URL: `/ws/socket.io`
- Auth: `Bearer <Auth0 access token>` via `socket.auth.token`
- Events:
  - `conversation:join`
  - `conversation:leave`
  - `typing:start`
  - `typing:stop`
  - `message:send`
  - `message:new` (server push)
  - `presence:update` (server push)
  - `user:presence` (server push)

## Recommendations
- `GET /api/recommendations/:userId` (self only)
- `POST /api/recommendations/recompute/:userId` (self only)
