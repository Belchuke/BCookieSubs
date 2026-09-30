set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

NO_COLOR="${NO_COLOR:-}"
if [[ -z "$NO_COLOR" && -t 1 ]]; then
  C_BLUE='\033[34m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_OFF='\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_OFF=''
fi
step() { printf "${C_BLUE}==>${C_OFF} %s\n" "$*"; }
ok()   { printf "${C_GREEN}OK${C_OFF}  %s\n" "$*"; }
warn() { printf "${C_YELLOW}!!${C_OFF}  %s\n" "$*" >&2; }
fail() { printf "${C_RED}xx${C_OFF}  %s\n" "$*" >&2; exit 1; }

ask_yesno() {
  local prompt="$1" default="$2" hint
  if [[ "$default" =~ ^[Yy]$ ]]; then hint="Y/n"; else hint="y/N"; fi
  read -r -p "$prompt [${hint}] " REPLY || REPLY="$default"
  REPLY="${REPLY:-$default}"
  [[ "$REPLY" =~ ^[Yy]$ ]]
}

env_value() {
  for f in "$ROOT/.deployment.env" "$ROOT/.env"; do
    [[ -f "$f" ]] || continue
    local v
    v="$(grep -E "^$1=" "$f" | tail -n1 | cut -d= -f2- || true)"
    if [[ -n "$v" ]]; then printf '%s' "$v"; return; fi
  done
  true
}

MODELS_FILE="${OLLAMA_MODELS_FILE:-$ROOT/ollama-models.txt}"
OS="$(uname -s)"
REPULL_ALL=0
if [[ "${1:-}" == "--repull" ]]; then REPULL_ALL=1; fi

BASE_URL="$(env_value OLLAMA_BASE_URL)"
API_KEY_SET=0
if [[ -n "$(env_value OLLAMA_API_KEY)" ]]; then API_KEY_SET=1; fi

DEPLOY_OLLAMA_MODE="$(env_value DEPLOY_OLLAMA_MODE)"
DEPLOY_GPU_TYPE="$(env_value DEPLOY_GPU_TYPE)"
if [[ -z "$DEPLOY_OLLAMA_MODE" ]]; then
  if [[ -z "$BASE_URL" && "$API_KEY_SET" == "1" ]]; then
    DEPLOY_OLLAMA_MODE="cloud"
  elif [[ "$BASE_URL" == "http://ollama:11434" ]]; then
    DEPLOY_OLLAMA_MODE="compose"
  elif [[ "$BASE_URL" == *host.docker.internal* ]]; then
    DEPLOY_OLLAMA_MODE="host"
  elif [[ -z "$BASE_URL" ]]; then
    DEPLOY_OLLAMA_MODE="$([[ "$OS" == "Darwin" ]] && echo host || echo compose)"
  else
    DEPLOY_OLLAMA_MODE="external"
  fi
fi
if [[ -z "$DEPLOY_GPU_TYPE" ]]; then
  if [[ "$OS" == "Darwin" ]]; then DEPLOY_GPU_TYPE="metal"
  elif command -v nvidia-smi >/dev/null 2>&1; then DEPLOY_GPU_TYPE="nvidia"
  elif [[ -e /dev/kfd ]]; then DEPLOY_GPU_TYPE="amd"
  else DEPLOY_GPU_TYPE="cpu"; fi
fi

COMPOSE="docker compose"
command -v docker >/dev/null 2>&1 || COMPOSE=""
compose_ollama() {
  [[ -n "$COMPOSE" ]] || return 1
  ${COMPOSE} --profile ollama --env-file "$ROOT/.env" "$@"
}

snapshot_models() {
  local tmp
  tmp="$(mktemp)"
  step "Snapshotting pulled models to $MODELS_FILE"
  if [[ "$DEPLOY_OLLAMA_MODE" == "compose" ]]; then
    if ! compose_ollama ps ollama >/dev/null 2>&1; then
      rm -f "$tmp"
      warn "Ollama Compose service is not reachable — snapshot skipped."
      return 0
    fi
    compose_ollama exec -T ollama ollama list 2>/dev/null \
      | awk 'NR>1 && $1 != "" {print $1}' | sort -u > "$tmp"
  elif command -v ollama >/dev/null 2>&1 && curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
    ollama list 2>/dev/null | awk 'NR>1 && $1 != "" {print $1}' | sort -u > "$tmp"
  fi
  if [[ -s "$tmp" ]]; then
    mv "$tmp" "$MODELS_FILE"
    ok "Saved $(wc -l < "$MODELS_FILE" | tr -d ' ') model(s) to $MODELS_FILE"
  else
    rm -f "$tmp"
    warn "No pulled models reported — snapshot skipped (existing file kept)."
  fi
}

update_host_ollama() {
  if ! command -v ollama >/dev/null 2>&1; then
    warn "Native ollama CLI not found — nothing to upgrade on the host."
    return 0
  fi
  step "Updating native Ollama (Metal runtime on macOS)"
  if [[ "$OS" == "Darwin" ]]; then
    if command -v brew >/dev/null 2>&1; then
      if brew list --formula ollama >/dev/null 2>&1 || brew list --cask ollama >/dev/null 2>&1; then
        brew upgrade ollama && ok "Ollama upgraded via Homebrew" \
          || warn "brew upgrade ollama failed — update from https://ollama.com"
      else
        warn "Ollama is installed but not managed by Homebrew. Update it from the"
        warn "Ollama app (menu bar → Restart/Update) or https://ollama.com/download —"
        warn "this script does not reinstall third-party installations."
      fi
    else
      warn "Homebrew not found. Update Ollama from its app or https://ollama.com/download."
    fi
  else
    if ask_yesno "    Re-run the official Ollama install script to upgrade?" "Y"; then
      curl -fsSL https://ollama.com/install.sh | sh && ok "Ollama install/upgrade complete" \
        || warn "Install script failed — see https://ollama.com for manual steps."
    fi
  fi
}

update_compose_ollama() {
  command -v docker >/dev/null 2>&1 || { warn "docker not found — skipping."; return 0; }
  step "Updating the Ollama Compose service (models volume is preserved)"
  if compose_ollama pull ollama && compose_ollama up -d --no-deps ollama; then
    ok "Ollama image pulled and container recreated (models volume untouched)"
  else
    warn "Compose update failed — run: ${COMPOSE} --profile ollama pull ollama && ${COMPOSE} --profile ollama up -d --no-deps ollama"
    return 1
  fi
}

repull_models() {
  if [[ ! -s "$MODELS_FILE" ]]; then
    warn "No tracked models in $MODELS_FILE — nothing to re-pull."
    return 0
  fi
  local runner=""
  if [[ "$DEPLOY_OLLAMA_MODE" == "compose" ]]; then
    if ! compose_ollama ps ollama >/dev/null 2>&1; then
      warn "Ollama Compose service is not reachable — skipping model re-pull."
      return 0
    fi
    runner="compose"
  elif command -v ollama >/dev/null 2>&1 && curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
    runner="host"
  else
    warn "Ollama is not reachable — skipping model re-pull."
    return 0
  fi
  if [[ "$REPULL_ALL" == "0" ]]; then
    echo "    Re-pulling refreshes every tracked model to its latest tag."
    ask_yesno "    Re-pull all tracked models now?" "N" || return 0
  fi
  step "Re-pulling tracked models from $MODELS_FILE"
  local total ok_count fail_count model
  total="$(wc -l < "$MODELS_FILE" | tr -d ' ')"
  ok_count=0; fail_count=0
  while IFS= read -r model; do
    if [[ -z "$model" ]]; then continue; fi
    printf "    pulling %s ... " "$model"
    if [[ "$runner" == "host" ]]; then
      ollama pull "$model" >/dev/null 2>&1 && echo ok || { echo FAILED; fail_count=$((fail_count + 1)); continue; }
    else
      compose_ollama exec -T ollama ollama pull "$model" >/dev/null 2>&1 && echo ok || { echo FAILED; fail_count=$((fail_count + 1)); continue; }
    fi
    ok_count=$((ok_count + 1))
  done < "$MODELS_FILE"
  ok "Re-pull complete: ${ok_count}/${total} ok${fail_count:+, ${fail_count} failed}"
}

verify_ollama() {
  case "$DEPLOY_OLLAMA_MODE" in
    compose)
      if compose_ollama exec -T ollama ollama --version >/dev/null 2>&1; then
        local ver
        ver="$(compose_ollama exec -T ollama ollama --version 2>/dev/null | head -n1)"
        ok "Ollama reachable inside the Compose service: ${ver:-version unknown}"
        if docker volume inspect "bcookiesubs_ollama" >/dev/null 2>&1; then
          ok "Model storage volume bcookiesubs_ollama present — existing models preserved."
        else
          warn "Model volume bcookiesubs_ollama not found — models may be missing."
        fi
      else
        warn "Ollama is NOT reachable inside the Compose service after the update."
        warn "Check: ${COMPOSE} --profile ollama logs ollama"
      fi
      ;;
    host)
      if curl -fsS --max-time 5 http://localhost:11434/api/tags >/dev/null 2>&1; then
        ok "Host Ollama reachable at http://localhost:11434 (Metal on macOS)."
      else
        warn "Host Ollama not reachable on http://localhost:11434 after the update."
        warn "Start it (Ollama app / 'ollama serve' / 'brew services start ollama')."
      fi
      ;;
  esac
}

echo "Detected Ollama mode: ${DEPLOY_OLLAMA_MODE} (runtime/GPU: ${DEPLOY_GPU_TYPE})"
echo

case "$DEPLOY_OLLAMA_MODE" in
  cloud)
    ok "This deployment uses Ollama Cloud only — there is no local Ollama to update."
    echo "    Cloud models are updated on Ollama's side; your OLLAMA_API_KEY and"
    echo "    selected cloud models in the Models page are unaffected."
    exit 0
    ;;
  none)
    warn "Ollama is not configured in .env (no OLLAMA_BASE_URL, no OLLAMA_API_KEY)."
    echo "    Configure Ollama in the Models page or re-run ./setup.sh, then retry."
    exit 0
    ;;
  external)
    warn "OLLAMA_BASE_URL points at a remote Ollama (${BASE_URL})."
    echo "    BCookieSubs does not manage that installation — update it on the host"
    echo "    that runs it. Nothing was changed here."
    exit 0
    ;;
  compose) HAS_DOCKER=1 ;;
  host) HAS_NATIVE=1 ;;
  *)
    fail "Unknown Ollama mode '${DEPLOY_OLLAMA_MODE}' — re-run ./setup.sh to fix the metadata."
    ;;
esac

snapshot_models
if [[ "${HAS_NATIVE:-0}" == "1" ]]; then
  update_host_ollama
else
  update_compose_ollama || true
fi
repull_models
verify_ollama

echo
ok "Ollama update finished."
echo "    Tracked models: $MODELS_FILE ($(wc -l < "$MODELS_FILE" 2>/dev/null | tr -d ' ' || echo 0) entries)"
echo "    Re-run anytime:  ./update-ollama.sh           (snapshot + upgrade + prompt to re-pull)"
echo "    Refresh models:  ./update-ollama.sh --repull  (re-pull all tracked models without prompting)"