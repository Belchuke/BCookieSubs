#!/usr/bin/env bash
# BCookieSubs — consolidated interactive setup.
#
# Walks through every initial configuration choice in one pass:
#   - deployment mode  : Docker (default) or local/native Node
#   - OS + GPU         : macOS Metal, Linux NVIDIA/AMD (ROCm), or CPU-only
#   - compose files    : docker-compose.yml / .macos.yml / .gpu.yml are
#                        generated for this machine (see scripts/_common.sh)
#   - Ollama           : local (default) or Ollama cloud (API key)
#   - TheMovieDB       : API key for library matching (optional)
#   - optional AI keys : OpenAI / Anthropic (for the ChatGPT / Claude providers)
#   - network          : host port
#   - .env             : written/merged, existing values are never overwritten
#   - service          : best-effort systemd/launchd install (optional)
#
# Existing values in .env are preserved — pressing Enter accepts the shown
# default. The dev variant (setup-with-dev.sh) remains available for live-reload
# development; this script is the only entry point for normal/production setup.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/_common.sh
source "$ROOT/scripts/_common.sh"

# Optional: force a GPU path and skip auto-detection (cpu | nvidia | amd | metal).
# Useful when detection is wrong on exotic hardware, e.g. ./setup.sh --gpu cpu
# (macOS always uses metal — Docker Desktop has no GPU passthrough.)
GPU_FORCE=""
if [[ "${1:-}" == "--gpu" ]]; then
  GPU_FORCE="${2:-}"
  case "$GPU_FORCE" in
    cpu|nvidia|amd|metal) ;;
    *) fail "--gpu must be one of: cpu, nvidia, amd, metal (got '${2:-<empty>}')" ;;
  esac
  ok "Forcing GPU path: ${GPU_FORCE} (auto-detection skipped)"
fi

# ─── helpers ───────────────────────────────────────────────────────────────
# Read a value into REPLY with a shown default; empty input keeps the default.
ask() {
  local prompt="$1" default="$2"
  read -r -p "$prompt [${default}] " REPLY || REPLY="$default"
  echo "${REPLY:-$default}"
}

# Yes/no question; default Y or N. Returns 0 on yes, 1 on no.
ask_yesno() {
  local prompt="$1" default="$2"
  local hint
  if [[ "$default" =~ ^[Yy]$ ]]; then hint="Y/n"; else hint="y/N"; fi
  read -r -p "$prompt [${hint}] " REPLY || REPLY="$default"
  REPLY="${REPLY:-$default}"
  [[ "$REPLY" =~ ^[Yy]$ ]]
}

# Set/replace a single KEY=value line in .env, appending if missing. A blank
# new value still overwrites (so the user can clear a key by pressing Enter on
# an empty default) — pass the existing value as the default to preserve it.
set_env_value() {
  local file="$1" key="$2" value="$3"
  if grep -Eq "^${key}=" "$file"; then
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"="{ if(!done){print k"="v; done=1; next} } {print}' "$file" > "$tmp"
    mv "$tmp" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

# Read the current value of KEY from .env (empty if absent/blank). Must return
# 0 even when the key is absent — this runs under `set -euo pipefail`, and a
# no-match grep (exit 1) would otherwise abort the whole script.
current_env() {
  local file="$1" key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | sed -E "s/^${key}=//" || true
}

# Ask the user which GPU/runtime path to use on Linux. Auto-detection only
# SUGGESTS a default — the user makes the final call. This avoids a wrong
# auto-detect forcing a GPU path that then fails at `docker compose up`
# (e.g. a stale /dev/kfd or a ROCm package without a real AMD GPU →
# "error gathering device information ... /dev/kfd: no such file or directory").
# macOS is handled by the caller (metal); this is Linux-only.
# Echoes nvidia | amd | cpu. Menu text goes to stderr so only the choice is
# captured by the caller's $(...).
choose_gpu() {
  local suggested default choice
  suggested="$(detect_gpu_type)"
  case "$suggested" in
    nvidia) default=1 ;;
    amd)    default=2 ;;
    *)      default=3 ;;
  esac
  {
    echo "    Auto-detected: ${suggested}"
    echo "    Choose your GPU / runtime:"
    echo "      1) NVIDIA  — Ollama GPU passthrough (needs nvidia-container-toolkit)"
    echo "      2) AMD     — Ollama via ROCm (ollama/ollama:rocm; needs /dev/kfd + /dev/dri)"
    echo "      3) CPU     — no GPU passthrough (works everywhere)"
  } >&2
  choice="$(ask "    GPU choice (1=NVIDIA, 2=AMD, 3=CPU)" "$default")"
  case "$choice" in
    1|nvidia) echo nvidia ;;
    2|amd)    echo amd ;;
    *)        echo cpu ;;
  esac
}

# Sequential step counter. do_step increments and prints "Step N of TOTAL".
# The "Service user" step is Linux-only, so TOTAL_STEPS is set after OS detection.
STEP_NUM=0
do_step() { STEP_NUM=$((STEP_NUM + 1)); step "Step ${STEP_NUM} of ${TOTAL_STEPS}: $1"; }

# ─── opening ────────────────────────────────────────────────────────────────
cat <<'EOF'

Hi thank you for trying out the BCookieSubs translation program in order to get you started we have some intial configuration steps we will need

EOF

# OS detection (used for GPU choice + compose file selection + service user).
OS="$(uname -s)"
case "$OS" in
  Darwin) ok "Detected macOS" ;;
  Linux)  ok "Detected Linux" ;;
  *)      warn "Detected $OS — not officially supported; proceeding with Linux defaults" ;;
esac
# The "Service user" step is Linux-only, so the total differs by OS.
if [[ "$OS" == "Linux" ]]; then TOTAL_STEPS=10; else TOTAL_STEPS=9; fi

do_step "Deployment mode"
echo "    Docker keeps the app + Ollama in containers (recommended)."
echo "    Local runs the Node app natively (you manage Ollama yourself)."
if ask_yesno "    Use Docker?" "Y"; then
  DEPLOY="docker"
else
  DEPLOY="local"
fi

GPU="cpu"
COMPOSE_FILES=()
if [[ "$DEPLOY" == "docker" ]]; then
  do_step "GPU / Ollama runtime"
  if [[ "$OS" == "Darwin" ]]; then
    # Docker Desktop on Mac has no GPU passthrough — use a native Ollama for
    # Metal acceleration (the macos compose file expects it on the host).
    GPU="metal"
    COMPOSE_FILES=(-f "$ROOT/docker-compose.macos.yml")
    echo "    macOS: Docker app + native Ollama (Metal GPU acceleration)."
  else
    GPU="${GPU_FORCE:-$(choose_gpu)}"
    case "$GPU" in
      nvidia)
        COMPOSE_FILES=(-f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.gpu.yml")
        ok "NVIDIA GPU detected (nvidia-smi present) — using GPU passthrough."
        if ! docker info 2>/dev/null | grep -qi "Runtimes:.*nvidia"; then
          warn "Docker has no 'nvidia' runtime. Install nvidia-container-toolkit:"
          warn "    https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/"
          warn "Falling back to CPU if the GPU runtime is missing at up-time."
        fi
        ;;
      amd)
        COMPOSE_FILES=(-f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.gpu.yml")
        ok "AMD GPU detected (/dev/kfd present) — using ROCm passthrough (ollama/ollama:rocm)."
        if [[ ! -d /dev/dri ]]; then
          warn "/dev/dri not found — ROCm DRI render nodes are missing."
          warn "    Ollama may fall back to CPU. See https://rocm.docs.amd.com/"
        fi
        ;;
      *)
        GPU="cpu"
        COMPOSE_FILES=(-f "$ROOT/docker-compose.yml")
        echo "    No GPU detected — CPU-only Ollama."
        ;;
    esac
  fi
else
  do_step "GPU / Ollama runtime"
  echo "    Local mode: the app does not manage Ollama for you."
  if [[ "$OS" == "Darwin" ]]; then
    GPU="metal"
    echo "    macOS: install Ollama from https://ollama.com for Metal GPU acceleration."
  else
    GPU="${GPU_FORCE:-$(choose_gpu)}"
    if [[ "$GPU" == "nvidia" ]]; then
      ok "NVIDIA GPU detected — Whisper can use CUDA (set in the app settings)."
    elif [[ "$GPU" == "amd" ]]; then
      ok "AMD GPU detected — Ollama can use ROCm; Whisper stays CPU (no ROCm backend)."
    else
      GPU="cpu"
      echo "    No GPU detected — CPU-only."
    fi
  fi
fi

# ─── ensure .env exists early so current_env works for the prompts below ─────
ensure_env_file "$ROOT"
ENV_FILE="$ROOT/.env"

# ─── Ollama provider ────────────────────────────────────────────────────────
do_step "Ollama"
echo "    Local: Ollama runs on your machine (default, free, no API key)."
echo "    Cloud: use Ollama's hosted cloud (needs an OLLAMA_API_KEY)."
CURR_OLLAMA_KEY="$(current_env "$ENV_FILE" OLLAMA_API_KEY)"
if ask_yesno "    Use Ollama cloud?" "N"; then
  OLLAMA_CLOUD="1"
  OLLAMA_API_KEY="$(ask "    OLLAMA_API_KEY" "$CURR_OLLAMA_KEY")"
else
  OLLAMA_CLOUD="0"
  OLLAMA_API_KEY="$CURR_OLLAMA_KEY"
fi

# ─── TheMovieDB ──────────────────────────────────────────────────────────────
do_step "TheMovieDB (library matching)"
echo "    An API key enables automatic movie/series matching from filenames."
echo "    Get one at https://www.themoviedb.org/settings/api (leave blank to skip)."
CURR_TMDB_KEY="$(current_env "$ENV_FILE" THEMOVIEDB_API_KEY)"
THEMOVIEDB_API_KEY="$(ask "    THEMOVIEDB_API_KEY" "$CURR_TMDB_KEY")"

# ─── optional AI providers ───────────────────────────────────────────────────
do_step "Optional AI providers (ChatGPT / Claude)"
echo "    Only needed if you plan to use the ChatGPT or Claude model providers."
echo "    Press Enter to keep the existing value or skip."
CURR_OPENAI="$(current_env "$ENV_FILE" OPENAI_API_KEY)"
OPENAI_API_KEY="$(ask "    OPENAI_API_KEY" "$CURR_OPENAI")"
CURR_ANTHROPIC="$(current_env "$ENV_FILE" ANTHROPIC_API_KEY)"
ANTHROPIC_API_KEY="$(ask "    ANTHROPIC_API_KEY" "$CURR_ANTHROPIC")"

# ─── library folder ──────────────────────────────────────────────────────────
# The root of the media library. The container mounts it at the SAME host path
# (so paths typed in the UI match what the container sees), and the app seeds
# its rootLibraryPath config from this. Created if missing.
do_step "Library folder"
echo "    The root folder of your media library. The scanner reads from here and"
echo "    translated subtitles are written next to the media. The container mounts"
echo "    it at the same host path (so UI paths match the container's view)."
CURR_LIB="$(current_env "$ENV_FILE" TRANSLATION_ROOT_DIR)"
[[ -z "$CURR_LIB" ]] && CURR_LIB="$ROOT/media"
LIBRARY_DIR="$(ask "    Library root path" "$CURR_LIB")"
if [[ -d "$LIBRARY_DIR" ]]; then
  LIBRARY_DIR="$(cd "$LIBRARY_DIR" && pwd)"
elif mkdir -p "$LIBRARY_DIR" 2>/dev/null; then
  LIBRARY_DIR="$(cd "$LIBRARY_DIR" && pwd)"
  ok "Created library folder: $LIBRARY_DIR"
else
  warn "Could not create '$LIBRARY_DIR' — keeping the path as-is (create it manually)."
fi

# ─── default UI language ─────────────────────────────────────────────────────
# Seeds the app's defaultLanguage config. Each user can still pick their own in
# the app. Validated against the supported locale list (keep in sync with
# src/i18n.ts SUPPORTED_LOCALES); an unknown code falls back to 'en' in-app.
do_step "Default UI language"
echo "    The default interface language for new users. Each user can still change"
echo "    theirs in the app. Common codes: en, da, th, de, es, fr, ja, zh, sv, nb."
CURR_LANG="$(current_env "$ENV_FILE" APP_DEFAULT_LANGUAGE)"
[[ -z "$CURR_LANG" ]] && CURR_LANG="en"
APP_LANG="$(ask "    Default language code" "$CURR_LANG")"
SUPPORTED_LOCALES="en da th de es fr sv nb fi pt ja zh ru tr ko vi nl it pl uk cs ro hu el id ms hi ar sq hy az eu be bn bs bg ca hr et fil ka he is ga kk lv lt mk sr sk sl ta te ur fa sw af zu tl my km lo mn ne si gu kn ml mr pa lb mt cy gd gl am ha ig yo so ky tg tk uz eo la"
if [[ -n "$APP_LANG" && " $SUPPORTED_LOCALES " != *" $APP_LANG "* ]]; then
  warn "'$APP_LANG' is not a known locale code — the app will fall back to 'en'."
fi

# ─── service user & library access (Linux only) ─────────────────────────────
# Create a dedicated system user to run the service / own the library folder, so
# the app doesn't run as your personal user. Access is granted via GROUP ownership
# (chgrp + g+rwX) so you keep ownership of the library. macOS skips this (launchd
# runs the agent as the current user). Best-effort with sudo.
SERVICE_USER=""
if [[ "$OS" == "Linux" ]]; then
  do_step "Service user & library access"
  echo "    Create a dedicated 'bcookiesubs' system user and give it read/write"
  echo "    access to the library folder. The service runs as this user (not yours);"
  echo "    you keep ownership of the library (access is via the group)."
  if ask_yesno "    Create the bcookiesubs service user and grant it library access?" "Y"; then
    SERVICE_USER="bcookiesubs"
    if id "$SERVICE_USER" >/dev/null 2>&1; then
      ok "User '$SERVICE_USER' already exists."
    elif sudo -v 2>/dev/null; then
      if sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
        || sudo adduser --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null; then
        ok "Created system user '$SERVICE_USER'."
      else
        warn "Could not create user '$SERVICE_USER' (useradd/adduser failed)."
        SERVICE_USER=""
      fi
    else
      warn "sudo is required to create a system user — skipping (run as a user with sudo)."
      SERVICE_USER=""
    fi
    # Grant the service user group read/write to the library; keep the owner as-is.
    if [[ -n "$SERVICE_USER" && -d "$LIBRARY_DIR" ]]; then
      if sudo chgrp -R "$SERVICE_USER" "$LIBRARY_DIR" 2>/dev/null \
        && sudo chmod -R g+rwX "$LIBRARY_DIR" 2>/dev/null; then
        ok "Granted '$SERVICE_USER' group read/write to '$LIBRARY_DIR'."
      else
        warn "Could not grant access to '$LIBRARY_DIR' — fix permissions manually so the service can read/write it."
      fi
    fi
  fi
fi

# ─── network ─────────────────────────────────────────────────────────────────
do_step "Network"
CURR_PORT="$(current_env "$ENV_FILE" HOST_PORT)"
[[ -z "$CURR_PORT" ]] && CURR_PORT="4850"
HOST_PORT="$(ask "    Host port to expose the app on" "$CURR_PORT")"

# ─── write .env ───────────────────────────────────────────────────────────────
do_step "Writing .env"
set_env_value "$ENV_FILE" "PORT" "4850"
set_env_value "$ENV_FILE" "HOST_PORT" "$HOST_PORT"
set_env_value "$ENV_FILE" "TRANSLATION_ROOT_DIR" "$LIBRARY_DIR"
set_env_value "$ENV_FILE" "APP_DEFAULT_LANGUAGE" "$APP_LANG"
set_env_value "$ENV_FILE" "THEMOVIEDB_API_KEY" "$THEMOVIEDB_API_KEY"
set_env_value "$ENV_FILE" "OLLAMA_API_KEY" "$OLLAMA_API_KEY"
set_env_value "$ENV_FILE" "OPENAI_API_KEY" "$OPENAI_API_KEY"
set_env_value "$ENV_FILE" "ANTHROPIC_API_KEY" "$ANTHROPIC_API_KEY"

# Ollama base URL: docker network for the dockerised Ollama, localhost
# otherwise. Don't clobber a non-empty value the user already set.
CURR_OLLAMA_URL="$(current_env "$ENV_FILE" OLLAMA_BASE_URL)"
if [[ -z "$CURR_OLLAMA_URL" ]]; then
  if [[ "$DEPLOY" == "docker" && "$GPU" != "metal" ]]; then
    set_env_value "$ENV_FILE" "OLLAMA_BASE_URL" "http://ollama:11434"
  else
    set_env_value "$ENV_FILE" "OLLAMA_BASE_URL" "http://localhost:11434"
  fi
fi

# GPU_TYPE is the single source of truth for which GPU path is active
# (cpu | nvidia | amd | metal). update-ollama.sh reads it for messaging.
set_env_value "$ENV_FILE" "GPU_TYPE" "$GPU"

# WHISPER_GPU_AVAILABLE=1 only for NVIDIA — whisper.cpp has a CUDA backend. AMD
# uses Ollama ROCm for inference, but whisper.cpp has no ROCm backend, so Whisper
# stays CPU-only on AMD (and on CPU/metal).
if [[ "$GPU" == "nvidia" ]]; then
  set_env_value "$ENV_FILE" "WHISPER_GPU_AVAILABLE" "1"
else
  set_env_value "$ENV_FILE" "WHISPER_GPU_AVAILABLE" ""
fi

ok ".env written at $ENV_FILE"

# ─── generate the docker-compose files for this machine ──────────────────────
# setup.sh owns docker-compose.yml / .macos.yml / .gpu.yml — regenerated each
# run, so they always match the detected OS + GPU. Hand-edits are overwritten.
step "Generating docker-compose files"
write_compose_base "$ROOT"
write_compose_macos "$ROOT"
if [[ "$GPU" == "nvidia" || "$GPU" == "amd" ]]; then
  write_compose_gpu "$ROOT" "$GPU"
else
  # CPU/Metal: no GPU overlay — remove any stale one from a previous GPU setup.
  remove_compose_gpu "$ROOT"
fi
ok "Compose files generated (GPU=${GPU})"

# ─── optional service install ─────────────────────────────────────────────────
INSTALL_SERVICE=0
if ask_yesno "    Install as a background service that starts on boot?" "N"; then
  INSTALL_SERVICE=1
fi

# ─── bring up ─────────────────────────────────────────────────────────────────
step "Starting BCookieSubs"
if [[ "$DEPLOY" == "docker" ]]; then
  require_docker
  ok "docker + compose v2 reachable"
  if [[ "$GPU" == "metal" ]]; then
    # The macos compose file expects a native Ollama on the host.
    if ! curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
      if command -v brew >/dev/null 2>&1; then
        command -v ollama >/dev/null 2>&1 || brew install ollama
        brew services start ollama >/dev/null 2>&1 || true
        for i in 1 2 3 4 5 6 7 8 9 10; do
          curl -fsS --max-time 1 http://localhost:11434/api/tags >/dev/null 2>&1 && break
          sleep 1
        done
      fi
      if curl -fsS --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
        ok "Native Ollama reachable on http://localhost:11434"
      else
        warn "Ollama not reachable on :11434 — start it (open the Ollama app or 'ollama serve')"
      fi
    else
      ok "Native Ollama reachable on http://localhost:11434"
    fi
  fi
  docker compose "${COMPOSE_FILES[@]}" up -d --build
  COMPOSE_ARG="${COMPOSE_FILES[*]}"
else
  # Local/native Node deployment.
  require_cmd node "install Node.js (https://nodejs.org)"
  require_cmd npm "install npm (ships with Node.js)"
  step "Installing dependencies"
  npm install
  step "Building TypeScript"
  npm run build
  ok "Build complete."
  echo "    Start the app with:  DBPATH=\"./subtitles.db\" PORT=\"$HOST_PORT\" TRANSLATION_ROOT_DIR=\"$LIBRARY_DIR\" APP_DEFAULT_LANGUAGE=\"$APP_LANG\" node dist/index.js"
  echo "    (Ollama must be running and reachable; Whisper/tesseract optional.)"
fi

# ─── service install (best-effort, after the stack is up) ─────────────────────
if [[ "$INSTALL_SERVICE" == "1" ]]; then
  step "Installing service"
  if [[ "$DEPLOY" == "docker" ]]; then
    # Docker Desktop / the compose plugin already keep the containers running
    # and start them on boot via Docker's restart policy.
    if [[ "$OS" == "Darwin" ]]; then
      warn "Docker Desktop starts on login by default — no extra service needed."
    elif command -v systemctl >/dev/null 2>&1; then
      sudo systemctl enable docker 2>/dev/null \
        && ok "Enabled the docker service at boot" \
        || warn "Could not enable docker at boot — enable it manually."
    else
      warn "No systemd found; ensure Docker starts on boot yourself."
    fi
  else
    # Local node app: write a systemd unit (Linux) or a launchd plist (macOS).
    if [[ "$OS" == "Darwin" ]]; then
      PLIST_PATH="$HOME/Library/LaunchAgents/com.bcookiesubs.app.plist"
      cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bcookiesubs.app</string>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string><string>dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>$HOST_PORT</string>
    <key>DBPATH</key><string>$ROOT/subtitles.db</string>
    <key>TRANSLATION_ROOT_DIR</key><string>$LIBRARY_DIR</string>
    <key>APP_DEFAULT_LANGUAGE</key><string>$APP_LANG</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
      launchctl load "$PLIST_PATH" 2>/dev/null && ok "Installed launchd agent ($PLIST_PATH)" \
        || warn "Could not load launchd agent — run: launchctl load $PLIST_PATH"
    elif command -v systemctl >/dev/null 2>&1; then
      UNIT_PATH="/etc/systemd/system/bcookiesubs.service"
      # Run as the bcookiesubs service user when one was created, and keep the DB
      # on a directory it owns so it can write there. $ROOT (the code) stays owned
      # by you and is world-readable, so node can still execute dist/index.js.
      if [[ -n "$SERVICE_USER" ]]; then
        UNIT_USER="User=$SERVICE_USER"
        UNIT_GROUP="Group=$SERVICE_USER"
        UNIT_DBPATH="/var/lib/bcookiesubs/subtitles.db"
        sudo mkdir -p /var/lib/bcookiesubs
        sudo chown "$SERVICE_USER:$SERVICE_USER" /var/lib/bcookiesubs 2>/dev/null || true
      else
        UNIT_USER=""
        UNIT_GROUP=""
        UNIT_DBPATH="$ROOT/subtitles.db"
      fi
      sudo tee "$UNIT_PATH" >/dev/null <<UNIT
[Unit]
Description=BCookieSubs translation app
After=network.target

[Service]
Type=simple
$UNIT_USER
$UNIT_GROUP
WorkingDirectory=$ROOT
Environment=PORT=$HOST_PORT
Environment=DBPATH=$UNIT_DBPATH
Environment=TRANSLATION_ROOT_DIR=$LIBRARY_DIR
Environment=APP_DEFAULT_LANGUAGE=$APP_LANG
ExecStart=/usr/bin/env node dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
      sudo systemctl daemon-reload
      sudo systemctl enable --now bcookiesubs 2>/dev/null \
        && ok "Installed + started systemd unit ($UNIT_PATH)" \
        || warn "Could not enable the systemd unit — run: sudo systemctl enable --now bcookiesubs"
    else
      warn "No systemd/launchd detected; skipping service install."
    fi
  fi
fi

# ─── done ─────────────────────────────────────────────────────────────────────
echo
ok "BCookieSubs is up."
echo "    Browse:        http://localhost:${HOST_PORT}"
if [[ "$DEPLOY" == "docker" ]]; then
  echo "    Logs:          docker compose $COMPOSE_ARG logs -f app"
  echo "    Stop:          docker compose $COMPOSE_ARG down"
else
  echo "    Logs:          node dist/index.js (foreground) or the service journal"
fi
echo "    First visit: open the URL above and create your admin user — the app"
echo "    will walk you through the remaining in-app setup (languages, models)."