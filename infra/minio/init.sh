#!/bin/sh
set -e

MINIO_URL="${MINIO_URL:-http://127.0.0.1:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
MINIO_BUCKET="${MINIO_BUCKET:-teamfinder-profile-images}"

until /usr/bin/mc alias set local "${MINIO_URL}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1; do
  sleep 2
done

/usr/bin/mc alias set local "${MINIO_URL}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1

/usr/bin/mc mb --ignore-existing "local/${MINIO_BUCKET}"
/usr/bin/mc anonymous set private "local/${MINIO_BUCKET}"

cat > /tmp/cors.xml <<'XML'
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>http://localhost:8080</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>DELETE</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
XML

/usr/bin/mc cors set "local/${MINIO_BUCKET}" /tmp/cors.xml >/dev/null 2>&1 || true

exit 0
