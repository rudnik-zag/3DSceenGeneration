#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SQL_FILE="${ROOT_DIR}/scripts/sql/analytics_views.sql"

if ! command -v psql >/dev/null 2>&1; then
  echo "[analytics-views] ERROR: psql is required but was not found in PATH."
  exit 1
fi

if [[ ! -f "${SQL_FILE}" ]]; then
  echo "[analytics-views] ERROR: SQL file not found: ${SQL_FILE}"
  exit 1
fi

resolve_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "${DATABASE_URL}"
    return 0
  fi

  local env_file="${ROOT_DIR}/.env"
  if [[ -f "${env_file}" ]]; then
    local line
    line="$(grep -E '^[[:space:]]*DATABASE_URL=' "${env_file}" | tail -n 1 || true)"
    if [[ -n "${line}" ]]; then
      line="${line#*=}"
      line="${line%\"}"
      line="${line#\"}"
      echo "${line}"
      return 0
    fi
  fi

  return 1
}

normalize_psql_url() {
  local raw_url="$1"
  local base query normalized_query part
  if [[ "${raw_url}" != *"?"* ]]; then
    echo "${raw_url}"
    return 0
  fi

  base="${raw_url%%\?*}"
  query="${raw_url#*\?}"
  normalized_query=""

  IFS='&' read -r -a parts <<<"${query}"
  for part in "${parts[@]}"; do
    [[ -z "${part}" ]] && continue
    if [[ "${part}" == schema=* ]]; then
      continue
    fi
    if [[ -n "${normalized_query}" ]]; then
      normalized_query="${normalized_query}&${part}"
    else
      normalized_query="${part}"
    fi
  done

  if [[ -n "${normalized_query}" ]]; then
    echo "${base}?${normalized_query}"
  else
    echo "${base}"
  fi
}

DB_URL="${1:-}"
if [[ -z "${DB_URL}" ]]; then
  DB_URL="$(resolve_database_url || true)"
fi
DB_URL="$(normalize_psql_url "${DB_URL}")"

if [[ -z "${DB_URL}" ]]; then
  cat <<'EOF'
[analytics-views] ERROR: DATABASE_URL is missing.

Provide one of:
1) export DATABASE_URL=postgresql://...
2) put DATABASE_URL in .env
3) run: bash scripts/apply-analytics-views.sh "postgresql://..."
EOF
  exit 1
fi

echo "[analytics-views] Applying analytics views from ${SQL_FILE}"
psql "${DB_URL}" -v ON_ERROR_STOP=1 -f "${SQL_FILE}"
echo "[analytics-views] Done. Available views:"
psql "${DB_URL}" -c "\dv analytics.*"
