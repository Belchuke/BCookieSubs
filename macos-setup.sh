#!/usr/bin/env bash
# BCookieSubs — macOS setup.
# Runs the app in Docker but uses a NATIVE Ollama on the Mac host so it can use
# Metal GPU acceleration (Docker Desktop on Mac has no GPU passthrough).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$ROOT/scripts/_common.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "This script is intended for macOS. On Linux use ./setup.sh or ./setup-with-gpu.sh."
  read -r -p "Continue anyway? [y/N] " ans
  [[ "${ans:-N}" =~ ^[Yy]$ ]] || exit 0
fi

step "Checking prerequisites"
require_docker
ok "docker + compose v2 reachable"

# ─── Ensure native Ollama is installed and running ──────────────────────────
ensure_native_ollama() {
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama CLI found: $(ollama --version 2>/dev/null | head -1)"
  else
    if ! command -v brew >/dev/null 2>&1; then
      warn "Neither 'ollama' nor 'brew' is installed."
      warn "Install Ollama from https://ollama.com (the .dmg auto-starts as a menu-bar app),"
      warn "or install Homebrew first: https://brew.sh"
      fail "Cannot proceed without Ollama."
    fi
    step "Installing Ollama via Homebrew"
    brew install ollama
  fi

  # Is the Ollama server already responding on :11434?
  if curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama is already running on http://localhost:11434"
    return
  fi

  # Try to start it as a brew service if we have brew.
  if command -v brew >/dev/null 2>&1; then
    step "Starting Ollama as a background service (brew services start ollama)"
    brew services start ollama >/dev/null

    # Wait up to ~10s for it to be reachable.
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS --max-time 1 http://localhost:11434/api/tags >/dev/null 2>&1; then
        ok "Ollama is up (after ${i}s)"
        return
      fi
      sleep 1
    done
    warn "Started Ollama via brew but it isn't responding yet — proceeding anyway."
    warn "If the app shows 'Ollama not running', wait a few seconds and retry."
  else
    warn "Ollama is installed but not running and Homebrew isn't available to start it as a service."
    warn "Start it manually (open the Ollama Mac app, or run 'ollama serve' in a terminal)"
    warn "and re-run this script."
    fail "Ollama not reachable on http://localhost:11434"
  fi
}

ensure_native_ollama

step "Bootstrapping .env"
ensure_env_file "$ROOT"

step "Building and starting the stack (using host Ollama)"
docker compose -f "$ROOT/docker-compose.macos.yml" up -d --build

print_done_banner "-f docker-compose.macos.yml"
echo "    Pull a model: ollama pull qwen2.5:14b"
