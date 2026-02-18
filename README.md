# TeamFinder

TeamFinder is a microservices-based web app for UBC students to find teammates and study groups by class.

This repository currently contains **Phase 1** of the implementation:
- Dockerized services
- Event-driven backbone using Apache Kafka (KRaft mode)
- Redis for chat caching/unread counters/presence primitives
- Separate PostgreSQL database per bounded context (no shared application DB)
- API gateway + edge proxy
- Structured logging and centralized log aggregation (Vector -> Loki -> Grafana)

## Services
- `gateway`: API gateway for all backend traffic
- `auth-service`: signup/login
- `profile-service`: profile management
- `class-service`: classes, enrollments, groups, group requests
- `messaging-service`: conversations and messages
- `recommendation-service`: consumes events and computes compatibility recommendations

## Infra
- `edge-proxy` (Nginx): routes frontend and API traffic
- `kafka`: Apache Kafka broker in KRaft mode
- `redis`: cache + unread counters + ephemeral chat hot data
- `*-db`: isolated PostgreSQL instances per domain
- `vector`, `loki`, `grafana`: centralized logging pipeline

## Quick Start
1. Build and run:
   ```bash
   docker compose up --build
   ```
2. Open:
- App: `http://localhost:8080`
- Grafana: `http://localhost:3000` (default `admin/admin`)
- MinIO API: `http://localhost:9000`
- MinIO Console: `http://localhost:9001` (`minioadmin/minioadmin`)

3. Optional class ingestion after boot:
   ```bash
   ./scripts/ingest-sample-classes.sh
   ```

## Notes
- This is an MVP foundation, not full HA.
- Kafka is intentionally included for event-driven evolution.
- Kubernetes can be introduced in a later phase when scale/ops needs justify it.

## Documentation
- Phase plan: `docs/phases.md`
- Architecture: `docs/architecture.md`
- UI design system: `docs/design-system.md`
- API notes: `docs/api-phase2.md`
