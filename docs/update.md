# Updating BCookieSubs

The standard update flow: backup → pull → build → restart (migrations apply automatically) → verify.

## 1. Back up

```bash
docker compose --env-file .env exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/$(date +%F)-pre-update.sql
```

See `docs/backup.md`.

## 2. Pull the new code

```bash
git pull
```

## 3. Build and restart

```bash
docker compose --env-file .env up -d --build
```

This rebuilds the Web/Worker/Python-worker images and recreates the containers. On startup both
Web and Worker apply pending EF Core migrations under a PostgreSQL advisory lock (only one
process migrates; the other waits), then seed reference data idempotently. PostgreSQL itself
keeps its data in the `bcookiesubs_pgdata` volume and is recreated only if the compose
configuration changes its definition.

Schema-affecting EF migrations are designed to run while old rows are still present; check
release notes for any manual step.

## 4. Verify

- Web health: `curl -f http://localhost:$WEB_PORT/healthz` and `/health/database`
- Worker health: `curl -f http://localhost:$WORKER_GATEWAY_PORT/healthz`
- Web UI: log in, open the library, workers page and dashboard.
- Python worker: the Workers page should show it connected with a recent heartbeat after a
  minute or two. This is automatic when `.env` defines `WORKER_BOOTSTRAP_TOKEN` (the compose
  worker enrolls with it at startup); without it, mint a single-use code on the Workers page
  and set it as `LOCAL_WORKER_ENROLLMENT_TOKEN`, then recreate the python-worker container.

## Rollback

```bash
git checkout <previous-tag-or-commit>
docker compose --env-file .env up -d --build
# If the schema moved forward in a way the older code cannot use:
docker compose --env-file .env exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose --env-file .env exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" \
  < backups/<date>-pre-update.sql
docker compose --env-file .env restart web worker
```

Restoring the pre-update dump returns both schema and data to the pre-update state.

## Notes

- `setup.sh` is safe to re-run at any time: it only rebuilds and restarts the same services;
  volumes persist.
- Media, poster photos and model directories are volumes — container recreation does not lose
  them; a `down -v` does.
- Identity login sessions persist across container recreation (`dpkeys` volume holds the
  ASP.NET DataProtection keys). Only `down -v` loses them.