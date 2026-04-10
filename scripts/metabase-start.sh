#!/usr/bin/env bash
set -euo pipefail

MB_CONTAINER_NAME="${MB_CONTAINER_NAME:-tribalai_metabase}"
MB_PORT="${MB_PORT:-3001}"
MB_VOLUME_NAME="${MB_VOLUME_NAME:-tribalai_metabase_data}"
MB_IMAGE="${MB_IMAGE:-metabase/metabase:latest}"

if ! command -v docker >/dev/null 2>&1; then
  cat <<'EOF'
[metabase] Docker is not installed or not in PATH.

Option A (recommended): install Docker and run:
  bash scripts/metabase-start.sh

Option B (without Docker): run Metabase JAR directly:
  mkdir -p .run/metabase
  cd .run/metabase
  curl -L -o metabase.jar https://downloads.metabase.com/latest/metabase.jar
  java -jar metabase.jar
EOF
  exit 1
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "${MB_CONTAINER_NAME}"; then
  if docker ps --format '{{.Names}}' | grep -Fxq "${MB_CONTAINER_NAME}"; then
    echo "[metabase] Container '${MB_CONTAINER_NAME}' is already running."
  else
    echo "[metabase] Starting existing container '${MB_CONTAINER_NAME}'..."
    docker start "${MB_CONTAINER_NAME}" >/dev/null
  fi
else
  echo "[metabase] Creating container '${MB_CONTAINER_NAME}' on port ${MB_PORT}..."
  docker volume create "${MB_VOLUME_NAME}" >/dev/null
  docker run -d \
    --name "${MB_CONTAINER_NAME}" \
    --add-host=host.docker.internal:host-gateway \
    -p "${MB_PORT}:3000" \
    -v "${MB_VOLUME_NAME}:/metabase-data" \
    -e MB_DB_FILE=/metabase-data/metabase.db \
    "${MB_IMAGE}" >/dev/null
fi

cat <<EOF
[metabase] Ready: http://localhost:${MB_PORT}

When connecting PostgreSQL from Metabase (container):
  Host: host.docker.internal
  Port: 5432
  DB: tribalai3d
  User: postgres
  Password: postgres
EOF
