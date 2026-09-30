# BCookieSubs

A self hosted app that translates subtitle files using local or cloud LLMs, with a focus on
watch-along quality rather than literal word by word translation.

```
Browser ──> BCookieSubs.Web ──EF Core──> PostgreSQL
                 │ gRPC
                 ▼
           BCookieSubs.Worker <──outbound gRPC── Python Worker(s)
```

## What does this program do?

- **Scans your media library** — point it at movie and series folders; it matches titles against
  [TheMovieDB](https://www.themoviedb.org) (posters, year, genres), tracks seasons/episodes and
  extras, and can rescan on a schedule.
- **Finds subtitle sources for each item** — companion subtitle files next to the video, subtitle
  tracks embedded in MKV/MP4 containers, and image-based tracks.
- **Translates subtitles with LLMs** — a subtitle is split into chunks; every configured
  translation model × prompt produces a candidate per chunk, and a judge model votes on the best
  one (with a fallback judge). Supported providers: **local Ollama**, **Ollama Cloud**,
  **OpenAI (ChatGPT)** and **Anthropic (Claude)**. You can manage models, prompts (versioned),
  translation schedules and per-user target languages.
- **Creates source subtitles from audio** — Whisper transcription on remote Python compute
  workers, including resumable runs and automatic translation-job creation afterwards.
- **Reads image-based subtitles via OCR** — PGS (`.sup`) and VobSub (`.sub` + `.idx`) are burned
  frame-by-frame and OCR'd (Tesseract) on a Python worker, then enter the normal translation flow.
- **An offset editor** — shift the timings of a text subtitle file by up to ±5 minutes, with
  preview and save back into the library.
- **A live dashboard** — queue control (pause/resume, reorder, retry, bulk actions), statistics,
  logs and live updates over SignalR.
- **Multi-user with roles and permissions** — ASP.NET Core Identity, per-role permission claims,
  audit logging, encrypted secret storage.
- **Remote compute workers** — Python workers (Whisper / OCR / vision) enroll once and connect
  outbound over gRPC; no inbound ports, per-worker capability and concurrency control.

### Subtitle formats

- **Text subtitles**: `.srt`, `.ass`/`.ssa` are handled directly. A text `.sub`
  (MicroDVD/SubViewer frame-based format) is converted to SRT, using the FPS from the media file
  (or a supplied value) for frame↔time conversion.
- **Image subtitles**: VobSub (`.sub` + `.idx`) and PGS (`.sup`) go through the OCR pipeline.
- Note that `.sub` files are **not** all the same: a text `.sub` parses directly, a VobSub `.sub`
  is a bitmap container that only works together with its `.idx` sidecar.

## Why did I build this project?

I have a Thai girlfriend and most of the movies I own have English subtitles.
Thai subtitles? Almost never.

So I wrote a little script to translate `.srt` files from English to Thai so we could watch movies together. Then I thought, "what if I had a tiny UI for it?" and then "what if multiple models voted on the best translation?" and then "what if it could scan a folder?" and a few months later it became this.

**Use it on subtitles for media you legally own.** I do not endorse or support piracy in any form. This project was built for couples and families like mine where partners speak different languages and struggle to find subtitles in the right language for their media collection. It doesn't download, host, or distribute any copyrighted content; it only operates on subtitle files you provide, on your own machine. Translate subtitles for movies and shows you legitimately own so your loved ones don't miss out on the dialogue.

## Prerequisites

- **Docker + Docker Compose v2** (Docker Desktop on macOS / Windows, or `docker.io` + the compose
  plugin on Linux). This is the supported way to host BCookieSubs.
- Disk space for the database (small) and any Ollama models you choose to install (large — many
  GBs each).
- A **TheMovieDB API key** (recommended) for media name detection. It's free: create an account at
  <https://www.themoviedb.org>, go to _Settings → API_, request a developer key. v3 auth (the
  simple API key string) is all you need.
- Optional: an **NVIDIA GPU** on Linux/Windows hosts accelerates Whisper/OCR in the bundled
  workers; on macOS the host Ollama uses Metal.

Running from source instead (development): .NET 10 SDK, a PostgreSQL instance and Python 3.11+ —
see `docs/architecture.md` for the layout and `scripts/` for the proto/worker helpers.

## Hosting / Installation

The canonical install is the setup script. It asks about ports, GPU usage, Ollama placement
(local / cloud / both), optional API keys, your library folder and the default UI language,
generates strong secrets into `.env` (existing values are kept and never printed), then builds
and starts everything and health-checks the stack:

```bash
./setup.sh
```

Default host ports (all overridable in `.env`): Web **4850**, PostgreSQL **4851**, Ollama **4852**
(only when the Ollama Compose service is used), C# worker gateway **4853**. Port **4854** is
reserved for the Python worker but stays unused — Python workers connect outbound only and expose
no listener. PostgreSQL is published on the host loopback only (`POSTGRES_BIND_ADDRESS=127.0.0.1`
default), so local administration and DBeaver over an SSH tunnel work but the database is not
reachable from outside. Setting `POSTGRES_BIND_ADDRESS=0.0.0.0` (or a LAN IP) in `.env` deliberately
exposes it on that interface — see `.env.example` for the security implications.

Ollama placement is platform-specific and handled by `setup.sh`: on macOS it uses the host Ollama
via `host.docker.internal`; on Linux/Windows Docker hosts it runs Ollama as a Compose service
(profile `ollama`, models persisted in the `ollama` volume, CPU by default — layer
`docker-compose.gpu.yml` for NVIDIA GPUs); with `OLLAMA_API_KEY` set and no `OLLAMA_BASE_URL` it
uses Ollama Cloud and never starts the local service. A custom `OLLAMA_BASE_URL` in `.env` is
always respected.

On first open, create the owner account, then manage workers at **/workers**.

The setup flow only appears while no user exists. PostgreSQL data lives in the `bcookiesubs_pgdata`
volume, which survives container recreation and `setup.sh` re-runs. To wipe the database and get the
setup flow back: `docker compose --env-file .env down -v` (removes all project
volumes, including the Python worker's identity and the media/work/models volumes), then re-run the
setup script. To reset only the database: `docker compose --env-file .env down`, then
`docker volume rm bcookiesubs_pgdata`.

For GPU-enabled Python workers (NVIDIA runtime required):

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --env-file .env up -d
```

Development overrides: `docker-compose.dev.yml` (exposes PostgreSQL on the host, Development env).

### Remote worker setup

1. In the web UI: **Workers → Add Worker**, copy the one-time enrollment token.
2. On the worker machine: `./scripts/setup-worker.sh` — it asks for the server URL, the token, a
   worker name, capabilities and max concurrency, detects hardware, and starts only the Python
   worker (Docker if available, otherwise a venv). The worker connects outbound to the central
   server; no inbound ports are required.

### Documentation

- `docs/architecture.md` — full architecture
- `docs/workers.md` — enrollment, credentials, heartbeat, drain/disable/remove, eligibility
- `docs/update.md` — update procedure
- `docs/backup.md` — backup and restore
- `docs/database.md` — the PostgreSQL schema and design decisions

## Updating

Before updating, back up the database (see `docs/backup.md`):

```bash
docker compose --env-file .env exec -T postgres \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backups/$(date +%F)-pre-update.sql
```

Then update the application (migrations apply automatically on startup):

```bash
git pull
docker compose --env-file .env up -d --build
```

Never use `docker compose down -v` as part of an update — it deletes volumes, including the
database, worker identities and Ollama models. The full procedure, verification steps and rollback
are in `docs/update.md`.

To update Ollama itself (native install on macOS, the Compose service elsewhere, or nothing at all
when you use Ollama Cloud), run:

```bash
./update-ollama.sh
```

It snapshots your pulled models to `ollama-models.txt`, upgrades the runtime without touching the
models volume, optionally re-pulls the tracked models and prints a health summary.

## Support me

If this saves you from hand-translating subtitles for your partner / family / film club, and you'd like to chip in toward keeping it maintained, [details coming soon].

In the meantime the best support is:

- Star the repo so it's easier for others to find.
- File issues with reproduction steps when something breaks.
- Share which translation prompts work well for your language pair so I can fold them into the defaults.
