#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

COMFYUI_CONDA_COMMAND="${COMFYUI_CONDA_COMMAND:-conda}"
COMFYUI_CONDA_ENV="${COMFYUI_CONDA_ENV:-comfyui}"
COMFYUI_APP_DIR="${COMFYUI_APP_DIR:-${ROOT_DIR}/../ComfyUI}"
COMFYUI_HOST="${COMFYUI_HOST:-127.0.0.1}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"
COMFYUI_EXTRA_ARGS="${COMFYUI_EXTRA_ARGS:-}"

if ! command -v "${COMFYUI_CONDA_COMMAND}" >/dev/null 2>&1; then
  echo "[comfyui-start] ERROR: '${COMFYUI_CONDA_COMMAND}' is not in PATH."
  exit 1
fi

if [[ ! -d "${COMFYUI_APP_DIR}" ]]; then
  echo "[comfyui-start] ERROR: COMFYUI_APP_DIR does not exist: ${COMFYUI_APP_DIR}"
  echo "[comfyui-start] Set COMFYUI_APP_DIR=/absolute/path/to/ComfyUI"
  exit 1
fi

if [[ ! -f "${COMFYUI_APP_DIR}/main.py" ]]; then
  echo "[comfyui-start] ERROR: main.py not found in ${COMFYUI_APP_DIR}"
  exit 1
fi

echo "[comfyui-start] Starting ComfyUI from ${COMFYUI_APP_DIR}"
echo "[comfyui-start] Conda env: ${COMFYUI_CONDA_ENV}"
echo "[comfyui-start] Bind: ${COMFYUI_HOST}:${COMFYUI_PORT}"

cd "${COMFYUI_APP_DIR}"

if [[ -n "${COMFYUI_EXTRA_ARGS}" ]]; then
  # shellcheck disable=SC2086
  exec "${COMFYUI_CONDA_COMMAND}" run -n "${COMFYUI_CONDA_ENV}" \
    python main.py --listen "${COMFYUI_HOST}" --port "${COMFYUI_PORT}" ${COMFYUI_EXTRA_ARGS}
else
  exec "${COMFYUI_CONDA_COMMAND}" run -n "${COMFYUI_CONDA_ENV}" \
    python main.py --listen "${COMFYUI_HOST}" --port "${COMFYUI_PORT}"
fi
