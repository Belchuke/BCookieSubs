set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(pwd)"

GPU_FORCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu)
      [ $# -ge 2 ] || fail "--gpu needs a value (nvidia|cpu)."
      GPU_FORCE="$2"
      shift 2
      ;;
    *) fail "Unknown argument: $1 (usage: ./setup.sh [--gpu nvidia|cpu])" ;;
  esac
done

NO_COLOR="${NO_COLOR:-}"
if [[ -z "$NO_COLOR" && -t 1 ]]; then
  C_BLUE='\033[34m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_OFF='\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_OFF=''
fi
step()  { printf "${C_BLUE}==>${C_OFF} %s\n" "$*"; }
ok()    { printf "${C_GREEN}OK${C_OFF}  %s\n" "$*"; }
warn()  { printf "${C_YELLOW}!!${C_OFF}  %s\n" "$*" >&2; }
fail()  { printf "${C_RED}xx${C_OFF}  %s\n" "$*" >&2; exit 1; }

ask() {
  local reply
  read -r -p "$1 [$2] " reply || reply=""
  printf '%s' "${reply:-$2}"
}

ask_secret() {
  local reply
  if [[ -n "$2" ]]; then
    read -r -s -p "$1 [currently configured — press Enter to keep] " reply || reply=""
    echo
    printf '%s' "${reply:-KEEP}"
  else
    read -r -s -p "$1 [leave empty to skip] " reply || reply=""
    echo
    printf '%s' "$reply"
  fi
}

ask_yesno() {
  local prompt="$1" default="$2" reply hint
  if [[ "$default" =~ ^[Yy]$ ]]; then hint="Y/n"; else hint="y/N"; fi
  read -r -p "$prompt [${hint}] " reply || reply=""
  [[ "${reply:-$default}" =~ ^[Yy]$ ]]
}

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not installed. Install Docker first: https://docs.docker.com/engine/"
fi
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  fail "Docker Compose v2 is not available (docker compose plugin or docker-compose binary)."
fi
if ! docker info >/dev/null 2>&1; then
  if [ "$(uname -s)" = "Darwin" ] && [ -d "/Applications/Docker.app" ]; then
    echo "Docker daemon is not running; starting Docker Desktop..."
    open -a Docker
    waited=0
    until docker info >/dev/null 2>&1; do
      sleep 2; waited=$((waited + 2))
      if [ "${waited}" -ge 120 ]; then
        fail "Docker Desktop did not become ready within 2 minutes."
      fi
    done
  else
    fail "Docker daemon is not running. Start it (Docker Desktop / colima / systemd) and retry."
  fi
fi

echo
echo "=============================================================="
echo " Hi, thank you for trying BCookieSubs. To get you started,"
echo " there are a few initial configuration steps."
echo "=============================================================="
echo

OS="$(uname -s)"
case "$OS" in
  Darwin)                      PLATFORM="macos";   ok "Detected macOS" ;;
  Linux)                       PLATFORM="linux";   ok "Detected Linux" ;;
  MINGW*|MSYS*|CYGWIN*)        PLATFORM="windows"; warn "Detected Windows (Git Bash/MSYS). Deployment uses Docker Desktop — proceed as for Linux Docker." ;;
  *)                           PLATFORM="unknown"; warn "Detected OS '$OS' — not officially supported; using Linux Docker defaults." ;;
esac

ENV_FILE="${REPO_ROOT}/.env"
ENV_EXAMPLE="${REPO_ROOT}/.env.example"
NEW_ENV=0
if [ ! -f "${ENV_FILE}" ]; then
  if [ ! -f "${ENV_EXAMPLE}" ]; then
    fail "Neither .env nor .env.example found in ${REPO_ROOT}."
  fi
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  NEW_ENV=1
  ok "Created .env from .env.example — your answers below fill it in."
else
  ok "Found an existing .env — current values are shown as defaults and kept unless you change them."
fi

get_env_value() {
  grep -E "^$1=" "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true
}
upsert_env_line() {
  if grep -qE "^$1=" "${ENV_FILE}"; then
    awk -v k="$1=" -v v="$2" '
      index($0, k) == 1 && !done { print k v; done = 1; next }
      { print }
      END { if (!done) print k v }
    ' "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  else
    printf '%s=%s\n' "$1" "$2" >> "${ENV_FILE}"
  fi
}

step "1/8 Host ports"
echo "    Web 4850 · PostgreSQL 4851 (host/admin only) · Ollama 4852 · Worker gateway 4853."
echo "    The Python worker has no host port — it connects outbound only."
WEB_PORT="$(ask "    Web port" "$(get_env_value WEB_PORT || true)")";           WEB_PORT="${WEB_PORT:-4850}"
PG_PORT="$(ask "    PostgreSQL host port" "$(get_env_value POSTGRES_PORT || true)")"; PG_PORT="${PG_PORT:-4851}"
OLLAMA_PORT="$(ask "    Ollama host port" "$(get_env_value OLLAMA_PORT || true)")"; OLLAMA_PORT="${OLLAMA_PORT:-4852}"
GW_PORT="$(ask "    Worker gateway port" "$(get_env_value WORKER_GATEWAY_PORT || true)")"; GW_PORT="${GW_PORT:-4853}"

step "2/8 GPU"
if [[ "$PLATFORM" == "macos" ]]; then
  GPU="none"
  echo "    macOS runs everything in Docker without GPU passthrough. Ollama, when"
  echo "    used locally, runs on the host with Metal acceleration (next step)."
else
  DETECTED_GPU="cpu"
  if command -v nvidia-smi >/dev/null 2>&1; then DETECTED_GPU="nvidia"; fi
  if [[ "$DETECTED_GPU" == "nvidia" ]]; then
    echo "    NVIDIA GPU detected (nvidia-smi present) — suggested default."
    if ! docker info 2>/dev/null | grep -qi "runtimes.*nvidia\|nvidia-container"; then
      warn "The NVIDIA container runtime is not visible. Install nvidia-container-toolkit"
      warn "or GPU passthrough will fail at start time:"
      warn "    https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/"
    fi
    echo "    Note: this deployment supports NVIDIA GPU passthrough and CPU. AMD/ROCm"
    echo "    containers are not provided (AMD hosts run CPU-only)."
  else
    echo "    No NVIDIA GPU detected — CPU-only is the suggested default."
    echo "    Note: this deployment supports NVIDIA GPU passthrough and CPU. AMD/ROCm"
    echo "    containers are not provided (AMD hosts run CPU-only)."
  fi
  GPU_DEFAULT="${GPU_FORCE:-$DETECTED_GPU}"
  GPU="$(ask "    GPU (nvidia/cpu)" "$GPU_DEFAULT")"
  case "$GPU" in
    nvidia) ok "NVIDIA passthrough enabled for the Python worker and local Ollama." ;;
    cpu)    echo "    CPU-only deployment." ;;
    amd)    warn "AMD/ROCm containers are not provided in this deployment — using CPU instead."
            GPU="cpu" ;;
    *)      warn "Unknown GPU '$GPU' — using CPU."; GPU="cpu" ;;
  esac
fi

step "3/8 Ollama"
echo "    How do you want to use Ollama?"
echo "      1. Local Ollama  (your hardware, free, private)"
echo "      2. Ollama Cloud  (large hosted models, needs an API key)"
echo "      3. Both"
OLLAMA_MODE_DEFAULT="1"
CURR_BASE_URL="$(get_env_value OLLAMA_BASE_URL || true)"
CURR_OLLAMA_KEY_SET="$(get_env_value OLLAMA_API_KEY || true)"
if [[ -n "$CURR_OLLAMA_KEY_SET" && -z "$CURR_BASE_URL" ]]; then OLLAMA_MODE_DEFAULT="2"; fi
read -r -p "    Choose [1/2/3, default ${OLLAMA_MODE_DEFAULT}] " OLLAMA_CHOICE || OLLAMA_CHOICE=""
OLLAMA_CHOICE="${OLLAMA_CHOICE:-$OLLAMA_MODE_DEFAULT}"

OLLAMA_MODE="none"
case "$OLLAMA_CHOICE" in
  1)
    OLLAMA_MODE="local"
    if [[ "$PLATFORM" == "macos" ]]; then
      upsert_env_line OLLAMA_BASE_URL "http://host.docker.internal:11434"
      echo "    macOS: native host Ollama (Metal). Containers reach it via"
      echo "    host.docker.internal:11434 — make sure the Ollama app is running."
      if ! command -v ollama >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1 && ask_yesno "    Ollama is not installed — install it via Homebrew now?" "Y"; then
          brew install ollama && ok "Installed Ollama (start it with: brew services start ollama)" \
            || warn "brew install failed — download from https://ollama.com/download"
        else
          warn "Install Ollama from https://ollama.com/download before starting."
        fi
      fi
    else
      upsert_env_line OLLAMA_BASE_URL "http://ollama:11434"
      echo "    Ollama runs as a Compose service (persistent model storage),"
      echo "    internal URL http://ollama:11434, host port ${OLLAMA_PORT}."
      if [[ "$GPU" == "nvidia" ]]; then
        echo "    NVIDIA passthrough will be layered in via docker-compose.gpu.yml."
      fi
    fi
    ;;
  2)
    OLLAMA_MODE="cloud"
    echo "    Ollama Cloud only — no local Ollama service will run."
    NEW_KEY="$(ask_secret "    OLLAMA_API_KEY" "$CURR_OLLAMA_KEY_SET")"
    if [[ "$NEW_KEY" == "KEEP" ]]; then
      echo "    Keeping the configured OLLAMA_API_KEY."
    elif [[ -n "$NEW_KEY" ]]; then
      upsert_env_line OLLAMA_API_KEY "$NEW_KEY"
    else
      warn "No API key entered — cloud models will not work until one is set."
    fi
    if grep -qE '^OLLAMA_BASE_URL=' "${ENV_FILE}"; then
      awk '/^OLLAMA_BASE_URL=/{ skip=1; next } { print }' "${ENV_FILE}" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "${ENV_FILE}"
      echo "    Removed OLLAMA_BASE_URL (cloud-only)."
    fi
    ;;
  3)
    OLLAMA_MODE="both"
    echo "    Both: a local Ollama service AND Ollama Cloud with an API key."
    NEW_KEY="$(ask_secret "    OLLAMA_API_KEY" "$CURR_OLLAMA_KEY_SET")"
    if [[ "$NEW_KEY" == "KEEP" ]]; then
      echo "    Keeping the configured OLLAMA_API_KEY."
    elif [[ -n "$NEW_KEY" ]]; then
      upsert_env_line OLLAMA_API_KEY "$NEW_KEY"
    else
      warn "No API key entered — cloud models will not work until one is set."
    fi
    if [[ "$PLATFORM" == "macos" ]]; then
      upsert_env_line OLLAMA_BASE_URL "http://host.docker.internal:11434"
    else
      upsert_env_line OLLAMA_BASE_URL "http://ollama:11434"
    fi
    ;;
  *)
    OLLAMA_MODE="none"
    echo "    Skipping Ollama for now — you can configure it later on the Models page"
    echo "    or by re-running ./setup.sh."
    ;;
esac

if [[ -n "$(get_env_value OLLAMA_BASE_URL || true)" ]] && [[ "$(get_env_value OLLAMA_BASE_URL || true)" != "http://ollama:11434" ]] \
   && [[ "$(get_env_value OLLAMA_BASE_URL || true)" != "http://host.docker.internal:11434" ]]; then
  echo "    Custom OLLAMA_BASE_URL in .env is respected ($(get_env_value OLLAMA_BASE_URL || true))."
  OLLAMA_MODE="external"
fi
if [ -z "$(get_env_value OLLAMA_BASE_URL || true)" ] && [ -n "$(get_env_value OLLAMA_API_KEY || true)" ]; then
  OLLAMA_PROFILE=""
elif [ "$(get_env_value OLLAMA_BASE_URL || true)" = "http://ollama:11434" ]; then
  OLLAMA_PROFILE="--profile ollama"
else
  OLLAMA_PROFILE=""
fi

step "4/8 TheMovieDB (optional but recommended)"
echo "    A TMDB API key enables automatic movie/series matching from filenames —"
echo "    titles, years, posters and better translation context. Free key:"
echo "    https://www.themoviedb.org/settings/api (v3 key)."
CURR_TMDB_SET="$(get_env_value THEMOVIEDB_API_KEY || true)"
NEW_KEY="$(ask_secret "    THEMOVIEDB_API_KEY" "$CURR_TMDB_SET")"
if [[ "$NEW_KEY" == "KEEP" ]]; then
  echo "    Keeping the configured TMDB key."
elif [[ -n "$NEW_KEY" ]]; then
  upsert_env_line THEMOVIEDB_API_KEY "$NEW_KEY"
else
  echo "    Skipped — matching can be enabled later on the Secrets admin page."
fi

step "5/8 Optional cloud providers"
echo "    Only needed if you plan to use ChatGPT or Claude model providers."
for PROVIDER in OPENAI ANTHROPIC; do
  CURR_SET="$(get_env_value ${PROVIDER}_API_KEY || true)"
  if [[ -n "$CURR_SET" ]]; then
    if ask_yesno "    ${PROVIDER} API key is currently configured — replace it?" "N"; then
      NEW_KEY="$(ask_secret "    ${PROVIDER}_API_KEY (empty keeps it configured)" "")"
      if [[ -n "$NEW_KEY" ]]; then upsert_env_line ${PROVIDER}_API_KEY "$NEW_KEY"; fi
    else
      echo "    ${PROVIDER}: keeping the configured key."
    fi
  else
    if ask_yesno "    Configure ${PROVIDER} now?" "N"; then
      NEW_KEY="$(ask_secret "    ${PROVIDER}_API_KEY (empty to skip)" "")"
      if [[ -n "$NEW_KEY" ]]; then upsert_env_line ${PROVIDER}_API_KEY "$NEW_KEY"; fi
    fi
  fi
done

step "6/8 Local media library root (optional)"
echo "    Root folder of your media library. It is mounted into every container at"
echo "    the same absolute path, so paths typed in the UI match what the containers"
echo "    see. Additional Local or SFTP Library Paths can be added later in the app"
echo "    (Library Paths page). Leave empty if your libraries live elsewhere."
CURR_LIB="$(get_env_value TRANSLATION_ROOT_DIR || true)"
LIBRARY_DIR="$(ask "    Library root path" "$CURR_LIB")"
if [[ -n "$LIBRARY_DIR" ]]; then
  if [[ -d "$LIBRARY_DIR" ]]; then
    LIBRARY_DIR="$(cd "$LIBRARY_DIR" && pwd)"
  elif mkdir -p "$LIBRARY_DIR" 2>/dev/null; then
    LIBRARY_DIR="$(cd "$LIBRARY_DIR" && pwd)"
    ok "Created library folder: $LIBRARY_DIR"
  else
    warn "Could not create '$LIBRARY_DIR' — keeping the path as-is (create it manually)."
  fi
  upsert_env_line TRANSLATION_ROOT_DIR "$LIBRARY_DIR"
fi

step "7/8 Default UI language"
echo "    The default interface language for new users. Each user can still change"
echo "    theirs in the app. Common codes: en, da, th, de, es, fr, ja, zh, sv, nb."
CURR_LANG="$(get_env_value APP_DEFAULT_LANGUAGE || true)"
if [[ -z "$CURR_LANG" ]]; then CURR_LANG="en"; fi
APP_LANG="$(ask "    Default language code" "$CURR_LANG")"
SEED_FILE="${REPO_ROOT}/src/BCookieSubs.Shared/Database/Seeding/LanguageSeedData.cs"
if [[ -f "$SEED_FILE" ]]; then
  if ! awk -F'"' '/^    new\(/ {print $4}' "$SEED_FILE" | grep -qx "$APP_LANG"; then
    warn "'$APP_LANG' is not in the app's language catalog — it will fall back to 'en'."
  fi
fi
upsert_env_line APP_DEFAULT_LANGUAGE "$APP_LANG"

step "8/8 Secrets"
echo "    Missing required secrets are generated automatically. Existing values are"
echo "    kept and never printed."
require_openssl() { command -v openssl >/dev/null 2>&1 || fail "openssl is required to generate secrets."; }
require_openssl

ensure_secret() {
  local key="$1" length="$2" current
  current="$(get_env_value "$key" || true)"
  if [[ -n "$current" ]]; then
    echo "    ${key}: currently configured (kept)."
  else
    upsert_env_line "$key" "$(openssl rand -hex "$length")"
    echo "    ${key}: generated."
  fi
}
ensure_secret POSTGRES_PASSWORD 16
ensure_secret ORCHESTRATION_API_KEY 32
ensure_secret WORKER_JWT_SIGNING_KEY 32
ensure_secret SECRET_ENCRYPTION_KEY 32
ensure_secret WORKER_BOOTSTRAP_TOKEN 24

for KEY in POSTGRES_USER POSTGRES_DB; do
  if [ -z "$(get_env_value $KEY || true)" ]; then
    upsert_env_line $KEY "bcookiesubs"
  fi
done
if [ -n "$(get_env_value POSTGRES_HOST_PORT || true)" ] && [ -z "$(get_env_value POSTGRES_PORT || true)" ]; then
  upsert_env_line POSTGRES_PORT "$(get_env_value POSTGRES_HOST_PORT)"
  echo "    Migrated POSTGRES_HOST_PORT to POSTGRES_PORT."
fi
upsert_env_line WEB_PORT "$WEB_PORT"
upsert_env_line POSTGRES_PORT "$PG_PORT"
upsert_env_line OLLAMA_PORT "$OLLAMA_PORT"
upsert_env_line WORKER_GATEWAY_PORT "$GW_PORT"

upsert_deployment() {
  local file="${REPO_ROOT}/.deployment.env"
  touch "$file"
  if grep -qE "^$1=" "$file"; then
    awk -v k="$1=" -v v="$2" '
      index($0, k) == 1 && !done { print k v; done = 1; next }
      { print }
      END { if (!done) print k v }
    ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  else
    printf '%s=%s\n' "$1" "$2" >> "$file"
  fi
}
DEPLOY_OLLAMA_META="none"
case "$OLLAMA_MODE" in
  local)  DEPLOY_OLLAMA_META="$([[ "$PLATFORM" == "macos" ]] && echo host || echo compose)" ;;
  both)   DEPLOY_OLLAMA_META="$([[ "$PLATFORM" == "macos" ]] && echo host || echo compose)" ;;
  cloud)  DEPLOY_OLLAMA_META="cloud" ;;
esac
if [[ "$OLLAMA_MODE" == "none" && -n "$(get_env_value OLLAMA_BASE_URL || true)" ]]; then
  DEPLOY_OLLAMA_META="external"
fi
upsert_deployment DEPLOY_PLATFORM "$PLATFORM"
upsert_deployment DEPLOY_GPU_TYPE "$([ "$PLATFORM" == "macos" ] && echo metal || echo "$GPU")"
upsert_deployment DEPLOY_OLLAMA_MODE "$DEPLOY_OLLAMA_META"
upsert_deployment DEPLOY_WEB_PORT "$WEB_PORT"
upsert_deployment DEPLOY_POSTGRES_PORT "$PG_PORT"
upsert_deployment DEPLOY_OLLAMA_PORT "$OLLAMA_PORT"
upsert_deployment DEPLOY_WORKER_GATEWAY_PORT "$GW_PORT"

echo
step "Configuration summary"
echo "    Operating system:      $PLATFORM"
if [[ "$PLATFORM" == "macos" ]]; then
  echo "    GPU:                   metal (host Ollama acceleration)"
else
  echo "    GPU:                   $GPU"
fi
echo "    Ollama:                $OLLAMA_MODE"
if [[ "$DEPLOY_OLLAMA_META" == "cloud" ]]; then
  echo "      (cloud only — no local Ollama service)"
fi
echo "    Web port:              $WEB_PORT"
echo "    PostgreSQL port:       $PG_PORT (host/admin only)"
echo "    Ollama port:           $OLLAMA_PORT (only when local Ollama is used)"
echo "    Worker gateway port:   $GW_PORT"
LIBRARY_ROOT_VALUE="$(get_env_value TRANSLATION_ROOT_DIR || true)"
echo "    Local media root:      ${LIBRARY_ROOT_VALUE:-(none — add paths in the app)}"
echo "    TMDB configured:       $([[ -n "$(get_env_value THEMOVIEDB_API_KEY || true)" ]] && echo yes || echo no)"
echo "    OpenAI configured:     $([[ -n "$(get_env_value OPENAI_API_KEY || true)" ]] && echo yes || echo no)"
echo "    Anthropic configured:  $([[ -n "$(get_env_value ANTHROPIC_API_KEY || true)" ]] && echo yes || echo no)"
echo "    Ollama Cloud:          $([[ -n "$(get_env_value OLLAMA_API_KEY || true)" ]] && echo yes || echo no)"
echo
if ! ask_yesno "    Continue and start the stack?" "Y"; then
  echo "    Setup stopped — your answers are saved in .env; re-run ./setup.sh later."
  exit 0
fi

COMPOSE_ARGS=(--env-file "${ENV_FILE}")
COMPOSE_FILES=(-f "${REPO_ROOT}/docker-compose.yml")
if [[ "$PLATFORM" != "macos" && "$GPU" == "nvidia" ]]; then
  COMPOSE_FILES+=(-f "${REPO_ROOT}/docker-compose.gpu.yml")
fi
if [[ "$DEPLOY_OLLAMA_META" == "compose" ]]; then
  COMPOSE_ARGS+=(--profile ollama)
fi

echo
step "Building and starting the stack (this can take a few minutes on first run)..."
${COMPOSE} "${COMPOSE_FILES[@]}" "${COMPOSE_ARGS[@]}" up -d --build

wait_for() {
  local name="$1" cmd="$2" tries="${3:-40}"
  local i=0
  printf "    waiting for %s " "$name"
  while [ $i -lt "$tries" ]; do
    if eval "$cmd" >/dev/null 2>&1; then
      echo ""
      ok "$name is healthy."
      return 0
    fi
    printf "."
    sleep 3
    i=$((i + 1))
  done
  echo ""
  warn "$name did not become healthy — check the logs below."
  return 1
}

step "Health checks"
PG_HEALTHY=1; WEB_HEALTHY=1; WORKER_HEALTHY=1; PY_HEALTHY=1; OLLAMA_HEALTHY=1

wait_for "PostgreSQL" \
  "${COMPOSE} ${COMPOSE_FILES[*]} ${COMPOSE_ARGS[*]} exec -T postgres pg_isready -U \"$(get_env_value POSTGRES_USER)\" -d \"$(get_env_value POSTGRES_DB)\"" \
  40 || PG_HEALTHY=0

wait_for "web" \
  "curl -fsS --max-time 5 http://localhost:${WEB_PORT}/healthz" 40 || WEB_HEALTHY=0

wait_for "C# worker gateway" \
  "curl -fsS --http2-prior-knowledge --max-time 5 http://localhost:${GW_PORT}/healthz" 40 || WORKER_HEALTHY=0

if ${COMPOSE} "${COMPOSE_FILES[@]}" "${COMPOSE_ARGS[@]}" ps python-worker 2>/dev/null | grep -qE "running|Up"; then
  ok "python-worker is running."
else
  warn "python-worker is not running — check: ${COMPOSE} ${COMPOSE_FILES[*]} ${COMPOSE_ARGS[*]} logs python-worker"
  PY_HEALTHY=0
fi

if [[ "$DEPLOY_OLLAMA_META" == "compose" ]]; then
  wait_for "Ollama" "curl -fsS --max-time 5 http://localhost:${OLLAMA_PORT}/api/tags" 20 || OLLAMA_HEALTHY=0
elif [[ "$DEPLOY_OLLAMA_META" == "host" ]]; then
  if curl -fsS --max-time 5 http://localhost:11434/api/tags >/dev/null 2>&1; then
    ok "Host Ollama (Metal) is reachable on http://localhost:11434."
  else
    warn "Host Ollama is not reachable on http://localhost:11434 — start the Ollama app, then refresh the Models page."
    OLLAMA_HEALTHY=0
  fi
fi

echo
echo "=============================================================="
ok "BCookieSubs is up."
echo
echo "    Open:          http://localhost:${WEB_PORT}"
echo "    First open:    create the owner account (setup flow),"
echo "                   then add workers under Workers."
echo
echo "    Web logs:      ${COMPOSE} ${COMPOSE_FILES[*]} ${COMPOSE_ARGS[*]} logs -f web"
echo "    Stop:          ${COMPOSE} ${COMPOSE_FILES[*]} ${COMPOSE_ARGS[*]} down"
echo "    Restart:       ${COMPOSE} ${COMPOSE_FILES[*]} ${COMPOSE_ARGS[*]} up -d"
echo "    Update app:    git pull && ${COMPOSE} ${COMPOSE_FILES[*]} ${COMPOSE_ARGS[*]} up -d --build"
if [[ "$DEPLOY_OLLAMA_META" != "none" && "$DEPLOY_OLLAMA_META" != "external" && "$DEPLOY_OLLAMA_META" != "cloud" ]]; then
  echo "    Ollama update: ./update-ollama.sh"
fi
echo
if [[ "$PG_HEALTHY" == "0" || "$WEB_HEALTHY" == "0" || "$WORKER_HEALTHY" == "0" || "$PY_HEALTHY" == "0" || "$OLLAMA_HEALTHY" == "0" ]]; then
  warn "Some services did not become healthy yet — they may still be starting."
  warn "Inspect: ${COMPOSE} ${COMPOSE_FILES[*]} ${COMPOSE_ARGS[*]} ps"
fi
echo "=============================================================="