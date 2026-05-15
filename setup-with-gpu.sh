#!/usr/bin/env bash
# BCookieSubs — Linux setup with NVIDIA GPU passthrough for Ollama.
# Layers docker-compose.gpu.yml on top of the base compose file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$ROOT/scripts/_common.sh"

case "$(uname -s)" in
  Darwin)
    fail "NVIDIA passthrough does not work on macOS — Docker Desktop has no GPU passthrough. Use ./macos-setup.sh instead."
    ;;
esac

step "Checking prerequisites"
require_docker

# Best-effort sanity check for the nvidia container runtime. We don't want to
# hard-fail if `nvidia-smi` is missing (some setups install only the toolkit),
# but flag the most common misconfigurations early.
if ! command -v nvidia-smi >/dev/null 2>&1; then
  warn "nvidia-smi not found on the host. The NVIDIA driver may be missing."
  warn "If 'docker run --gpus all nvidia/cuda nvidia-smi' works, you can ignore this."
fi
if ! docker info 2>/dev/null | grep -qi "Runtimes:.*nvidia"; then
  warn "Docker does not report an 'nvidia' runtime. Install nvidia-container-toolkit:"
  warn "  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/"
fi
ok "docker + compose v2 reachable"

step "Bootstrapping .env"
ensure_env_file "$ROOT"

step "Building and starting the stack (with GPU passthrough)"
docker compose \
  -f "$ROOT/docker-compose.yml" \
  -f "$ROOT/docker-compose.gpu.yml" \
  up -d --build

print_done_banner "-f docker-compose.yml -f docker-compose.gpu.yml"
echo "    Verify GPU: docker exec bcookiesubs-ollama nvidia-smi"
