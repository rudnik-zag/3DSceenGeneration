#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUN_DIR="${ROOT_DIR}/.run"
LOG_DIR="${RUN_DIR}/logs"
PID_DIR="${RUN_DIR}/pids"

CONDA_ENV_NAME="${CONDA_ENV_NAME:-general_env}"
USE_DOCKER_INFRA="${USE_DOCKER_INFRA:-1}"
COREPACK_HOME_DIR="${COREPACK_HOME_DIR:-/tmp/corepack}"
STOP_DOCKER_INFRA="${STOP_DOCKER_INFRA:-1}"
MINIO_STANDALONE_WHEN_NO_DOCKER="${MINIO_STANDALONE_WHEN_NO_DOCKER:-1}"
STOP_STANDALONE_MINIO="${STOP_STANDALONE_MINIO:-1}"
MINIO_BIN="${MINIO_BIN:-minio}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-$HOME/minio-data}"
MINIO_ADDRESS="${MINIO_ADDRESS:-:9100}"
MINIO_CONSOLE_ADDRESS="${MINIO_CONSOLE_ADDRESS:-:9101}"
CONDA_SH_PATH=""
DOCKER_INFRA_ACTIVE=0

mkdir -p "${LOG_DIR}" "${PID_DIR}"

print_usage() {
  cat <<EOF
Usage: $(basename "$0") <start|stop|restart|down|status|logs>

Environment variables:
  CONDA_ENV_NAME     Conda env to activate (default: general_env)
  USE_DOCKER_INFRA   1=start postgres/redis/minio via docker compose, 0=skip
  STOP_DOCKER_INFRA  1=stop postgres/redis/minio on stop/down, 0=skip
  MINIO_STANDALONE_WHEN_NO_DOCKER 1=auto-start local minio if docker infra is off/unavailable
  STOP_STANDALONE_MINIO 1=stop standalone minio on stop/down, 0=skip
  MINIO_BIN          MinIO binary name/path (default: minio)
  MINIO_DATA_DIR     MinIO data dir for standalone mode (default: ~/minio-data)
  MINIO_ADDRESS      MinIO API address for standalone mode (default: :9100)
  MINIO_CONSOLE_ADDRESS MinIO console address for standalone mode (default: :9101)
  COREPACK_HOME_DIR  Corepack home for pnpm fallback (default: /tmp/corepack)
EOF
}

ensure_conda() {
  local conda_sh=""

  if command -v conda >/dev/null 2>&1; then
    local conda_base=""
    conda_base="$(conda info --base 2>/dev/null || true)"
    if [[ -n "${conda_base}" ]]; then
      conda_sh="${conda_base}/etc/profile.d/conda.sh"
    fi
  fi

  if [[ -z "${conda_sh}" || ! -f "${conda_sh}" ]]; then
    if [[ -f "${HOME}/miniconda3/etc/profile.d/conda.sh" ]]; then
      conda_sh="${HOME}/miniconda3/etc/profile.d/conda.sh"
    elif [[ -f "${HOME}/anaconda3/etc/profile.d/conda.sh" ]]; then
      conda_sh="${HOME}/anaconda3/etc/profile.d/conda.sh"
    fi
  fi

  if [[ -z "${conda_sh}" || ! -f "${conda_sh}" ]]; then
    echo "[dev-stack] ERROR: conda.sh not found. Install/initialize Conda first."
    exit 1
  fi

  CONDA_SH_PATH="${conda_sh}"

  # Some conda activate scripts reference unset vars (e.g. QT_XCB_GL_INTEGRATION).
  # Temporarily disable nounset to avoid crashing the launcher.
  set +u
  # shellcheck disable=SC1090
  source "${conda_sh}"
  conda activate "${CONDA_ENV_NAME}"
  set -u
}

resolve_pnpm_cmd() {
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_CMD=(pnpm)
  else
    PNPM_CMD=(corepack pnpm)
    export COREPACK_HOME="${COREPACK_HOME_DIR}"
    if ! command -v corepack >/dev/null 2>&1; then
      echo "[dev-stack] ERROR: pnpm/corepack not found. Install Node.js with corepack."
      exit 1
    fi
  fi
}

is_running_pid() {
  local pid_file="$1"
  if [[ ! -f "${pid_file}" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "${pid_file}")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1
}

start_infra() {
  if [[ "${USE_DOCKER_INFRA}" != "1" ]]; then
    echo "[dev-stack] Skipping docker infra (USE_DOCKER_INFRA=${USE_DOCKER_INFRA})"
    DOCKER_INFRA_ACTIVE=0
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "[dev-stack] WARNING: docker not found; skipping infra startup."
    DOCKER_INFRA_ACTIVE=0
    return 0
  fi

  echo "[dev-stack] Starting docker infra: postgres redis minio"
  (cd "${ROOT_DIR}" && docker compose up -d postgres redis minio)
  DOCKER_INFRA_ACTIVE=1
}

stop_infra() {
  if [[ "${USE_DOCKER_INFRA}" != "1" ]]; then
    return 0
  fi

  if [[ "${STOP_DOCKER_INFRA}" != "1" ]]; then
    echo "[dev-stack] Skipping docker infra stop (STOP_DOCKER_INFRA=${STOP_DOCKER_INFRA})"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "[dev-stack] WARNING: docker not found; skipping infra stop."
    return 0
  fi

  echo "[dev-stack] Stopping docker infra: postgres redis minio"
  (cd "${ROOT_DIR}" && docker compose stop postgres redis minio >/dev/null 2>&1 || true)
}

address_port() {
  local value="$1"
  echo "${value##*:}"
}

is_port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -Eq ":${port}(\\s|$)"
    return $?
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -Eq ":${port}(\\s|$)"
    return $?
  fi
  return 1
}

start_standalone_minio_if_needed() {
  if [[ "${MINIO_STANDALONE_WHEN_NO_DOCKER}" != "1" ]]; then
    return 0
  fi

  if [[ "${USE_DOCKER_INFRA}" == "1" && "${DOCKER_INFRA_ACTIVE}" == "1" ]]; then
    return 0
  fi

  local minio_port console_port
  minio_port="$(address_port "${MINIO_ADDRESS}")"
  console_port="$(address_port "${MINIO_CONSOLE_ADDRESS}")"

  if is_port_listening "${minio_port}" && is_port_listening "${console_port}"; then
    echo "[dev-stack] Standalone MinIO already reachable on :${minio_port}/:${console_port}"
    return 0
  fi

  if ! command -v "${MINIO_BIN}" >/dev/null 2>&1; then
    echo "[dev-stack] WARNING: ${MINIO_BIN} not found; cannot auto-start standalone MinIO."
    return 0
  fi

  mkdir -p "${MINIO_DATA_DIR}"
  start_service "minio-standalone" "'${MINIO_BIN}' server '${MINIO_DATA_DIR}' --address '${MINIO_ADDRESS}' --console-address '${MINIO_CONSOLE_ADDRESS}'"
}

stop_standalone_minio() {
  if [[ "${STOP_STANDALONE_MINIO}" != "1" ]]; then
    echo "[dev-stack] Skipping standalone MinIO stop (STOP_STANDALONE_MINIO=${STOP_STANDALONE_MINIO})"
    return 0
  fi
  stop_service "minio-standalone"
}

start_service() {
  local name="$1"
  local cmd="$2"
  local pid_file="${PID_DIR}/${name}.pid"
  local log_file="${LOG_DIR}/${name}.log"

  if is_running_pid "${pid_file}"; then
    echo "[dev-stack] ${name} already running (pid=$(cat "${pid_file}"))"
    return 0
  fi

  echo "[dev-stack] Starting ${name}"
  (
    cd "${ROOT_DIR}"
    nohup bash -lc "${cmd}" >>"${log_file}" 2>&1 &
    echo $! >"${pid_file}"
  )
  sleep 0.3
  if is_running_pid "${pid_file}"; then
    echo "[dev-stack] ${name} started (pid=$(cat "${pid_file}"))"
  else
    echo "[dev-stack] ERROR: ${name} failed to start. Check ${log_file}"
    rm -f "${pid_file}"
    exit 1
  fi
}

stop_service() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  if ! is_running_pid "${pid_file}"; then
    rm -f "${pid_file}"
    echo "[dev-stack] ${name} is not running"
    return 0
  fi

  local pid
  pid="$(cat "${pid_file}")"
  echo "[dev-stack] Stopping ${name} (pid=${pid})"
  kill "${pid}" >/dev/null 2>&1 || true
  sleep 0.5
  if kill -0 "${pid}" >/dev/null 2>&1; then
    kill -9 "${pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${pid_file}"
}

status_service() {
  local name="$1"
  local pid_file="${PID_DIR}/${name}.pid"
  if is_running_pid "${pid_file}"; then
    echo "${name}: running (pid=$(cat "${pid_file}"))"
  else
    echo "${name}: stopped"
  fi
}

detect_app_url() {
  local log_file="${LOG_DIR}/next-dev.log"
  if [[ ! -f "${log_file}" ]]; then
    return 1
  fi
  local url
  url="$(grep -Eo "http://localhost:[0-9]+" "${log_file}" | tail -n 1 || true)"
  if [[ -n "${url}" ]]; then
    echo "${url}"
    return 0
  fi
  return 1
}

start_all() {
  ensure_conda
  resolve_pnpm_cmd
  start_infra
  start_standalone_minio_if_needed
  start_service "next-dev" "set +u && source '${CONDA_SH_PATH}' && conda activate '${CONDA_ENV_NAME}' && set -u && cd '${ROOT_DIR}' && ${PNPM_CMD[*]} dev"
  start_service "worker" "set +u && source '${CONDA_SH_PATH}' && conda activate '${CONDA_ENV_NAME}' && set -u && cd '${ROOT_DIR}' && ${PNPM_CMD[*]} worker"
}

stop_all() {
  stop_service "worker"
  stop_service "next-dev"
  stop_standalone_minio
  stop_infra
}

show_logs() {
  echo "== next-dev log =="
  tail -n 40 "${LOG_DIR}/next-dev.log" 2>/dev/null || echo "(no log yet)"
  echo
  echo "== worker log =="
  tail -n 60 "${LOG_DIR}/worker.log" 2>/dev/null || echo "(no log yet)"
}

cmd="${1:-}"
case "${cmd}" in
  start)
    start_all
    ;;
  stop)
    stop_all
    ;;
  down)
    stop_all
    ;;
  restart)
    stop_all
    start_all
    ;;
  status)
    status_service "next-dev"
    status_service "worker"
    if [[ -f "${PID_DIR}/minio-standalone.pid" ]]; then
      status_service "minio-standalone"
    fi
    if is_running_pid "${PID_DIR}/next-dev.pid" && app_url="$(detect_app_url)"; then
      echo "app-url: ${app_url}"
    fi
    ;;
  logs)
    show_logs
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
