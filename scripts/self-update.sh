#!/usr/bin/env bash
# Self-update to a release tag: backup -> git checkout -> rebuild/restart (docs/update.md).
# Triggered from the About page (Owner permission) or run manually: self-update.sh v1.0.1
set -euo pipefail

TAG="${1:?Usage: self-update.sh <tag>}"
cd "$(dirname "$0")/.."

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: $(pwd) is not a git checkout of the code."
  echo "Update from the host instead: git pull && docker compose --env-file .env up -d --build"
  exit 1
fi

if [[ -f .env ]]; then
  # POSTGRES_USER / POSTGRES_DB for the backup
  set -a
  . ./.env
  set +a
fi

backup_name="backups/$(date +%F-%H%M)-pre-update.sql"
if [[ -n "${POSTGRES_USER:-}" && -n "${POSTGRES_DB:-}" ]] && \
   docker compose --env-file .env ps postgres >/dev/null 2>&1; then
  mkdir -p backups
  if docker compose --env-file .env exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > "$backup_name"; then
    echo "Pre-update backup: $backup_name"
  else
    echo "WARN: database backup failed — continuing without it."
  fi
else
  echo "Skipping database backup: postgres is not running from this checkout."
fi

echo "Fetching latest release tag ${TAG}…"
git fetch --tags origin
git checkout "$TAG"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && \
   docker info >/dev/null 2>&1 && [[ -f .env ]]; then
  docker compose --env-file .env up -d --build
  echo "Update complete — containers rebuilt on ${TAG}."
else
  echo "Code checked out at ${TAG}. Docker compose is not usable from here."
  echo "Run on the host: docker compose --env-file .env up -d --build — then restart the app to finish the update."
fi
