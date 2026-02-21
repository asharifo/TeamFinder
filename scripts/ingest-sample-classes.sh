#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:8080}"
INGEST_TOKEN="${INGEST_TOKEN:?INGEST_TOKEN is required}"

curl -sS -X POST "${API_BASE}/api/classes/ingest" \
  -H "Content-Type: application/json" \
  -H "x-ingest-token: ${INGEST_TOKEN}" \
  --data-binary @data/ubc_classes_sample.json

echo
