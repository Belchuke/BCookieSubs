#!/usr/bin/env bash
# BCookieSubs — update Ollama and keep a tracking file of pulled models.
#
#   1. Snapshot the models currently pulled on this machine into
#      ./ollama-models.txt (one model per line). After an Ollama upgrade or a
#      clean reinstall you can re-pull the same set from that file.
#      (The app also keeps this file current whenever you pull/add/edit/remove
#      a model through the UI — this snapshot is a pre-upgrade backup.)
#   2. Update the Ollama runtime:
#        - native install : brew upgrade (macOS) or the official install script
#                          (Linux).
#        - dockerised     : docker compose pull + restart the ollama service.
#   3. Optionally re-pull every tracked model so each is at its latest tag.
#
# Run with --repull to skip the re-pull prompt and refresh all models.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$ROOT/scripts/_common.sh"

# Same file the app writes via syncOllamaModelsFile(). Default to the repo
# root; override with OLLAMA_MODELS_FILE so a containerised app and this host
# script can share one host-mounted file.
MODELS_FILE="${OLLAMA_MODELS_FILE:-$ROOT/ollama-models.txt}"
OS="$(uname -s)"
REPULL_ALL=0
[[ "${1:-}" == "--repull" ]] && REPULL_ALL=1

# ─── helpers ───────────────────────────────────────────────────────────────
ask_yesno() {
  local prompt="$1" default="$2" hint
  if [[ "$default" =~ ^[Yy]$ ]]; then hint="Y/n"; else hint="y/N"; fi
  read -r -p "$prompt [${hint}] " REPLY || REPLY="$default"
  REPLY="${REPLY:-$default}"
  [[ "$REPLY" =~ ^[Yy]$ ]]
}

# Where the dockerised Ollama lives (base compose file). The macos compose uses
# a host Ollama, so only the plain docker-compose.yml defines an ollama service.
docker_ollama_compose_files() {
  local -a files=()
  [[ -f "$ROOT/docker-compose.yml" ]] && files+=(-f "$ROOT/docker-compose.yml")
  # The GPU overlay only exists when setup.sh detected a GPU (NVIDIA or AMD).
  # Include it as-is — AMD doesn't set WHISPER_GPU_AVAILABLE, so don't gate on
  # that flag (it would wrongly exclude AMD).
  [[ -f "$ROOT/docker-compose.gpu.yml" ]] && files+=(-f "$ROOT/docker-compose.gpu.yml")
  printf '%s\0' "${files[@]}"
}

# ─── snapshot pulled models ─────────────────────────────────────────────────
snapshot_models() {
  if ! command -v ollama >/dev/null 2>&1; then
    warn "ollama CLI not found on PATH — skipping model snapshot."
    warn "If Ollama runs in Docker, the snapshot needs the host CLI OR run this on the host."
    return 0
  fi

  if ! curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
    warn "Ollama server is not reachable on http://localhost:11434 — skipping model snapshot."
    warn "Start it (open the Ollama app, or 'ollama serve' / 'brew services start ollama')."
    return 0
  fi

  step "Snapshotting pulled models to $MODELS_FILE"
  # `ollama list` prints a header row then one line per model: NAME ID SIZE MODIFIED.
  local tmp
  tmp="$(mktemp)"
  ollama list 2>/dev/null | awk 'NR>1 && $1 != "" {print $1}' | sort -u > "$tmp"

  if [[ ! -s "$tmp" ]]; then
    warn "No pulled models reported by 'ollama list'."
    rm -f "$tmp"
    return 0
  fi

  mv "$tmp" "$MODELS_FILE"
  ok "Saved $(wc -l < "$MODELS_FILE" | tr -d ' ') model(s) to $MODELS_FILE"
}

# ─── update the Ollama runtime ───────────────────────────────────────────────
update_native_ollama() {
  if ! command -v ollama >/dev/null 2>&1; then
    warn "Native ollama CLI not found — nothing to upgrade on the host."
    return 0
  fi
  step "Updating native Ollama"
  if [[ "$OS" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      brew upgrade ollama 2>/dev/null && ok "Ollama upgraded via Homebrew" \
        || warn "brew upgrade ollama failed — update from https://ollama.com"
    else
      warn "Homebrew not found. Download the latest Ollama from https://ollama.com to update."
    fi
  else
    # Linux: the official install script is idempotent and upgrades in place.
    if ask_yesno "    Re-run the official Ollama install script to upgrade?" "Y"; then
      curl -fsSL https://ollama.com/install.sh | sh && ok "Ollama install/upgrade complete" \
        || warn "Install script failed — see https://ollama.com for manual steps."
    fi
  fi
}

update_docker_ollama() {
  step "Updating dockerised Ollama"
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found — skipping the dockerised Ollama update."
    return 0
  fi
  local -a files
  while IFS= read -r -d '' f; do files+=("$f"); done < <(docker_ollama_compose_files)
  if [[ ${#files[@]} -eq 0 ]]; then
    warn "No docker-compose*.yml found with an ollama service — skipping."
    return 0
  fi
  docker compose "${files[@]}" pull ollama 2>/dev/null \
    && docker compose "${files[@]}" up -d --no-deps ollama \
    && ok "dockerised Ollama pulled + restarted (${files[*]})" \
    || warn "docker Ollama update failed — run 'docker compose ${files[*]} pull ollama' manually."
}

# ─── re-pull tracked models ─────────────────────────────────────────────────
repull_models() {
  if [[ ! -s "$MODELS_FILE" ]]; then
    warn "No tracked models in $MODELS_FILE — nothing to re-pull."
    return 0
  fi
  if ! command -v ollama >/dev/null 2>&1; then
    warn "ollama CLI not found — cannot re-pull models."
    return 0
  fi
  if [[ "$REPULL_ALL" == "0" ]]; then
    echo "    Re-pulling refreshes every tracked model to its latest tag."
    ask_yesno "    Re-pull all tracked models now?" "N" || return 0
  fi
  step "Re-pulling tracked models from $MODELS_FILE"
  local total ok_count fail_count
  total="$(wc -l < "$MODELS_FILE" | tr -d ' ')"
  ok_count=0
  fail_count=0
  while IFS= read -r model; do
    [[ -z "$model" ]] && continue
    printf "    pulling %s ... " "$model"
    if ollama pull "$model" >/dev/null 2>&1; then
      echo "ok"
      ok_count=$((ok_count + 1))
    else
      echo "FAILED"
      fail_count=$((fail_count + 1))
    fi
  done < "$MODELS_FILE"
  ok "Re-pull complete: ${ok_count}/${total} ok${fail_count:+, ${fail_count} failed}"
}

# ─── main ───────────────────────────────────────────────────────────────────
step "BCookieSubs — Ollama update + model tracking"

# Decide which runtime(s) to update. Native CLI present → update native.
# Docker compose ollama service present → offer to update dockerised too.
HAS_NATIVE=0
HAS_DOCKER=0
command -v ollama >/dev/null 2>&1 && HAS_NATIVE=1
if command -v docker >/dev/null 2>&1; then
  local_files=()
  while IFS= read -r -d '' f; do local_files+=("$f"); done < <(docker_ollama_compose_files)
  [[ ${#local_files[@]} -gt 0 ]] && HAS_DOCKER=1
fi

if [[ "$HAS_NATIVE" == "0" && "$HAS_DOCKER" == "0" ]]; then
  fail "Neither a native ollama CLI nor a dockerised ollama service was found."
fi

# 1) snapshot before the upgrade (so the file reflects what was actually in use).
snapshot_models

# 2) update the runtime.
if [[ "$HAS_NATIVE" == "1" ]]; then
  update_native_ollama
fi
if [[ "$HAS_DOCKER" == "1" ]]; then
  if [[ "$HAS_NATIVE" == "1" ]]; then
    if ask_yesno "    Also update the dockerised Ollama service?" "N"; then
      update_docker_ollama
    fi
  else
    update_docker_ollama
  fi
fi

# 3) re-pull tracked models to their latest tags.
repull_models

# ─── done ───────────────────────────────────────────────────────────────────
echo
ok "Ollama update finished."
echo "    Tracked models: $MODELS_FILE  ($(wc -l < "$MODELS_FILE" 2>/dev/null | tr -d ' ' || echo 0) entries)"
echo "    Re-run anytime:  ./update-ollama.sh            (snapshot + upgrade + prompt to re-pull)"
echo "    Refresh models: ./update-ollama.sh --repull   (re-pull all tracked models without prompting)"