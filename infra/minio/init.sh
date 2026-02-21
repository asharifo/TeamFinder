#!/bin/sh
set -e

MINIO_URL="${MINIO_URL:-http://127.0.0.1:9000}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
MINIO_BUCKET="${MINIO_BUCKET:-teamfinder-profile-images}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-${ALLOWED_ORIGIN:-http://localhost:8080}}"
S3_ACCESS_KEY="${S3_ACCESS_KEY:-}"
S3_SECRET_KEY="${S3_SECRET_KEY:-}"

until /usr/bin/mc alias set local "${MINIO_URL}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1; do
  sleep 2
done

/usr/bin/mc alias set local "${MINIO_URL}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1

/usr/bin/mc mb --ignore-existing "local/${MINIO_BUCKET}"
/usr/bin/mc anonymous set private "local/${MINIO_BUCKET}"

if [ -n "$S3_ACCESS_KEY" ] && [ -n "$S3_SECRET_KEY" ] && [ "$S3_ACCESS_KEY" != "$MINIO_ROOT_USER" ]; then
  if /usr/bin/mc admin user info local "$S3_ACCESS_KEY" >/dev/null 2>&1; then
    /usr/bin/mc admin user remove local "$S3_ACCESS_KEY" >/dev/null 2>&1 || true
  fi
  /usr/bin/mc admin user add local "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null 2>&1 || true
  /usr/bin/mc admin policy attach local readwrite --user "$S3_ACCESS_KEY" >/dev/null 2>&1 || true
fi

origins_xml=""
OLD_IFS="$IFS"
IFS=','
for origin in $ALLOWED_ORIGINS; do
  trimmed="$origin"
  while [ "${trimmed# }" != "$trimmed" ]; do
    trimmed="${trimmed# }"
  done
  while [ "${trimmed% }" != "$trimmed" ]; do
    trimmed="${trimmed% }"
  done
  if [ -n "$trimmed" ]; then
    origins_xml="${origins_xml}    <AllowedOrigin>${trimmed}</AllowedOrigin>\n"
  fi
done
IFS="$OLD_IFS"

if [ -z "$origins_xml" ]; then
  origins_xml="    <AllowedOrigin>http://localhost:8080</AllowedOrigin>\n"
fi

cat > /tmp/cors.xml <<XML
<CORSConfiguration>
  <CORSRule>
$(printf "%b" "$origins_xml")
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3000</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
XML

/usr/bin/mc cors set "local/${MINIO_BUCKET}" /tmp/cors.xml >/dev/null 2>&1 || true

exit 0
