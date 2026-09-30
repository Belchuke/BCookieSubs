# Backup and restore

PostgreSQL is the only state that must be backed up. Media files, poster images and worker model
directories live on Docker volumes and can be re-created by scans; the database cannot.

## Backup

Standard `pg_dump` text output (restorable with plain `psql`, no proprietary tools):

```bash
# From the repository root, with .env present:
docker compose --env-file .env exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/$(date +%F)-bcookiesubs.sql
```

For large databases, the compressed custom format is smaller and supports parallel restore:

```bash
docker compose --env-file .env exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > backups/$(date +%F)-bcookiesubs.dump
```

Notes:

- The `app_secrets` table stores API keys **encrypted**; the backup is safe to store as long as
  `SECRET_ENCRYPTION_KEY` from `.env` is not leaked alongside it. Keep `.env` backups separate
  from database backups.
- Schedule regular backups with cron; the dump can run while the stack is live (consistent
  snapshot, no downtime).

## Restore into the running stack

```bash
# Plain SQL:
docker compose --env-file .env exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose --env-file .env exec -T postgres psql -U "$POSTGRES_USER" "$POSTGRES_DB" \
  < backups/2026-09-24-bcookiesubs.sql
```

For `-Fc` dumps: `docker compose --env-file .env exec -T postgres pg_restore -U "$POSTGRES_USER"
-d "$POSTGRES_DB" --clean --if-exists < backups/...dump` (use `-j 4` for parallel restore).

After restoring, restart Web and Worker so they reconnect with fresh pools:

```bash
docker compose --env-file .env restart web worker
```

## Volume snapshot (optional, coarse)

```bash
docker compose --env-file .env stop postgres
docker run --rm -v bcookiesubs_pgdata:/data -v "$PWD/backups:/out" alpine \
  tar czf /out/pgdata-$(date +%F).tar.gz -C /data .
docker compose --env-file .env start postgres
```

Volume snapshots must be taken while PostgreSQL is stopped; `pg_dump` is the primary method.