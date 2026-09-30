set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== BCookieSubs remote worker setup ==="
echo ""
read -r -p "BCookieSubs server URL (e.g. http://your-server:5100): " SERVER_URL
while [ -z "${SERVER_URL}" ]; do read -r -p "BCookieSubs server URL: " SERVER_URL; done

read -r -p "Enrollment token (from Add Worker in the UI): " ENROLLMENT_TOKEN
while [ -z "${ENROLLMENT_TOKEN}" ]; do read -r -p "Enrollment token: " ENROLLMENT_TOKEN; done

read -r -p "Worker name [remote-worker]: " WORKER_NAME
WORKER_NAME="${WORKER_NAME:-remote-worker}"

read -r -p "Capabilities (whisper,ocr,vision) [whisper,ocr]: " CAPABILITIES
CAPABILITIES="${CAPABILITIES:-whisper,ocr}"

read -r -p "Max concurrency [1]: " MAX_CONCURRENCY
MAX_CONCURRENCY="${MAX_CONCURRENCY:-1}"

ENV_FILE="${REPO_ROOT}/worker.env"
cat > "${ENV_FILE}" <<EOF
BCOKIESUBS_SERVER_URL=${SERVER_URL}
WORKER_NAME=${WORKER_NAME}
WORKER_CAPABILITIES=${CAPABILITIES}
WORKER_MAX_CONCURRENCY=${MAX_CONCURRENCY}
WORKER_ENROLLMENT_TOKEN=${ENROLLMENT_TOKEN}
WORKER_INSECURE=1
WORKER_DATA_DIR=/data
EOF
chmod 600 "${ENV_FILE}"

echo ""
echo "Detected hardware:"
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader || true
else
  echo "  GPU: none detected (CPU-only)"
fi

if command -v docker >/dev/null 2>&1; then
  echo ""
  echo "Docker detected; building the worker image and starting the container..."
  docker build -t bcookiesubs/python-worker "${REPO_ROOT}/workers/python"
  docker rm -f bcookiesubs-remote-worker 2>/dev/null || true
  docker run -d \
    --name bcookiesubs-worker \
    --restart unless-stopped \
    --env-file "${ENV_FILE}" \
    -v bcookiesubs-worker-data:/data \
    bcookiesubs/python-worker
  echo "Worker container started (name: bcookiesubs-worker)."
  echo "After enrollment succeeds the token is consumed; credentials are stored in the 'bcookiesubs-worker-data' volume."
else
  echo ""
  echo "Docker not found. Setting up a Python virtual environment instead..."
  PYTHON_BIN="${PYTHON:-python3}"
  "${PYTHON_BIN}" -m venv "${REPO_ROOT}/.venv-worker"
  "${REPO_ROOT}/.venv-worker/bin/pip" install --quiet grpcio protobuf
  echo "To run the worker:"
  echo "  cd ${REPO_ROOT}"
  echo "  set -a; . ./worker.env; set +a"
  echo "  WORKER_DATA_DIR=./data ./.venv-worker/bin/python -m bcookiesubs_worker"
  echo "(run from ${REPO_ROOT}/workers/python for module resolution)"
fi

echo ""
echo "The worker should appear in BCookieSubs → Workers within a few seconds."