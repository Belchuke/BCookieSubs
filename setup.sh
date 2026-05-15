#!/usr/bin/env bash
# BCookieSubs — Linux / CPU-only setup.
# Runs the standard stack: app + dockerised Ollama (CPU).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$ROOT/scripts/_common.sh"

case "$(uname -s)" in
  Darwin)
    warn "You appear to be on macOS. The dockerised Ollama here will run CPU-only"
    warn "(Docker Desktop on Mac cannot pass through the Apple GPU)."
    warn "For Metal GPU acceleration use ./macos-setup.sh instead."
    read -r -p "Continue with the CPU-only docker stack anyway? [y/N] " ans
    [[ "${ans:-N}" =~ ^[Yy]$ ]] || exit 0
    ;;
esac

step "Checking prerequisites"
require_docker
ok "docker + compose v2 reachable"

step "Bootstrapping .env"
ensure_env_file "$ROOT"

step "Building and starting the stack"
docker compose -f "$ROOT/docker-compose.yml" up -d --build

print_done_banner "-f docker-compose.yml"
