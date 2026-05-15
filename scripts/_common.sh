# shellcheck shell=bash
# Shared helpers for setup scripts. Sourced — not run directly.

# Colourised status lines. No-op if NO_COLOR is set.
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  C_BLUE='\033[34m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_DIM='\033[2m'; C_OFF='\033[0m'
else
  C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_DIM=''; C_OFF=''
fi

step()  { printf "${C_BLUE}==>${C_OFF} %s\n" "$*"; }
ok()    { printf "${C_GREEN}OK${C_OFF}  %s\n" "$*"; }
warn()  { printf "${C_YELLOW}!!${C_OFF}  %s\n" "$*" >&2; }
fail()  { printf "${C_RED}xx${C_OFF}  %s\n" "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1${2:+ ($2)}"
}

require_docker() {
  require_cmd docker "install Docker Desktop or the Docker Engine"
  if ! docker compose version >/dev/null 2>&1; then
    fail "Docker Compose v2 plugin not found. Update Docker or install the compose plugin."
  fi
  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon is not reachable. Start Docker Desktop / the docker service and retry."
  fi
}

# Create .env from .env.example if missing and fill in a random AES_KEY
# when blank. Existing values are never overwritten.
ensure_env_file() {
  local root="$1"
  local env_file="$root/.env"
  local example="$root/.env.example"

  if [[ ! -f "$env_file" ]]; then
    if [[ ! -f "$example" ]]; then
      fail "Neither .env nor .env.example exists at $root"
    fi
    cp "$example" "$env_file"
    ok "Created .env from .env.example"
  fi

  # Generate AES_KEY if the value is empty. AES-256-GCM needs a 32-byte key
  # (64 hex chars).
  if grep -Eq '^AES_KEY=[[:space:]]*$' "$env_file"; then
    require_cmd openssl "needed to generate a random AES_KEY"
    local key
    key="$(openssl rand -hex 32)"
    # Portable in-place edit (BSD + GNU sed) via tmpfile.
    local tmp
    tmp="$(mktemp)"
    awk -v k="$key" 'BEGIN{done=0} /^AES_KEY=/{ if(!done){print "AES_KEY="k; done=1; next} } {print}' "$env_file" > "$tmp"
    mv "$tmp" "$env_file"
    ok "Generated random AES_KEY in .env"
  fi
}

# Print a "what's next" footer.
print_done_banner() {
  local port="${HOST_PORT:-4850}"
  echo
  ok "BCookieSubs is up."
  echo "    Browse:  http://localhost:${port}"
  echo "    Logs:    docker compose $1 logs -f app"
  echo "    Stop:    docker compose $1 down"
}
