#!/usr/bin/env bash
# BCookieSubs — dev setup (live source reload, no image rebuild per edit).
#
# Layers docker-compose.dev.yml on top of the platform-appropriate base compose
# file (docker-compose.macos.yml on Mac, docker-compose.yml on Linux) and builds
# the `dev` Dockerfile target.
#
#   views/*.ejs, public/*   -> refresh the browser; no restart
#   src/*.ts                -> tsc --watch recompiles, node --watch restarts (~1-2s)
#   new npm dependency      -> re-run this script with --build (see below)
#
# The database stays on the app-data named volume — it is never bind-mounted,
# so it persists across rebuilds and lives inside the container.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$ROOT/scripts/_common.sh"

step "Checking prerequisites"
require_docker
ok "docker + compose v2 reachable"

COMPOSE_FILES=()
case "$(uname -s)" in
  Darwin)
    COMPOSE_FILES=(-f "$ROOT/docker-compose.macos.yml")
    # The macos base expects a native Ollama on the host (Metal GPU). Best-effort
    # reachability check — don't hard-fail, the app still starts without it.
    if curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
      ok "Native Ollama reachable on http://localhost:11434"
    else
      warn "Ollama on http://localhost:11434 is not responding."
      warn "Start it (open the Ollama Mac app, or 'ollama serve' / 'brew services start ollama'),"
      warn "or run ./macos-setup.sh once to install it, then re-run this script."
    fi
    ;;
  *)
    COMPOSE_FILES=(-f "$ROOT/docker-compose.yml")
    ;;
esac
COMPOSE_FILES+=(-f "$ROOT/docker-compose.dev.yml")

step "Bootstrapping .env"
ensure_env_file "$ROOT"

step "Building and starting the dev stack"
# `up` builds the dev image the first time (it doesn't exist yet) and reuses the
# cached image on later runs — so re-running this script after a source edit does
# NOT rebuild. Pass --build only when you change package.json / the Dockerfile:
#
#   docker compose ${COMPOSE_FILES[*]} up -d --build
docker compose "${COMPOSE_FILES[@]}" up -d --build

print_done_banner "${COMPOSE_FILES[*]}"
echo "    Dev reload:"
echo "      views/*.ejs, public/*  -> refresh browser (no restart)"
echo "      src/*.ts               -> auto recompile + restart (~1-2s)"
echo "      new npm dep            -> re-run this script with --build"
echo "    Tail logs: docker compose ${COMPOSE_FILES[*]} logs -f app"