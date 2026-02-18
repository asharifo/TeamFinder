# Phase 2 API Notes

## Authentication
- `POST /api/auth/signup`
- `POST /api/auth/login`

For protected endpoints send:
- `Authorization: Bearer <jwt>`

Gateway verifies JWT and forwards:
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
- `GET /api/classes/:classId/members`
- `GET /api/classes/:classId/groups`
- `POST /api/classes/:classId/groups` (auth)
- `POST /api/classes/groups/:groupId/requests` (auth)
- `GET /api/classes/groups/:groupId/requests?status=ALL|PENDING|APPROVED|REJECTED` (owner only)
- `POST /api/classes/groups/:groupId/requests/:userId/approve` (owner only)
- `POST /api/classes/groups/:groupId/requests/:userId/reject` (owner only)

## Messaging
- `POST /api/messages/conversations` (auth)
- `POST /api/messages/conversations/:conversationId/messages` (auth)
- `GET /api/messages/conversations/:conversationId/messages` (member only)
- `POST /api/messages/conversations/:conversationId/read` (member only)
- `GET /api/messages/users/:userId/unread` (self only)

## Recommendations
- `GET /api/recommendations/:userId` (self only)
- `POST /api/recommendations/recompute/:userId` (self only)
