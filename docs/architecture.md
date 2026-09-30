# BCookieSubs Architecture

## Overview

```
Browser ──HTTP──> BCookieSubs.Web ──EF Core──> PostgreSQL
                        │                          ▲
                        │ gRPC (orchestration)     │ EF Core
                        ▼                          │
                  BCookieSubs.Worker ──────────────┘
                        ▲
                        │ gRPC (worker gateway, outbound)
                        ▼
                  Python Worker(s)
```

Three C# projects, one Python worker codebase:

- **BCookieSubs.Shared** — EF Core (`BCookieSubsDbContext`, entities, configurations, migrations),
  repositories, services, security/token helpers, protobuf message/stub generation (generated once
  here so types exist in exactly one assembly).
- **BCookieSubs.Web** — ASP.NET Core MVC + SignalR. Identity cookie auth, setup flow, Worker
  Management UI, admin/configuration UI (users, roles, settings, languages, themes, secrets,
  models, prompts, about), health endpoints.
- **BCookieSubs.Worker** — hosts the gRPC **gateway** Python workers connect to (outbound), the
  internal **orchestration** channel for Web, the in-memory connection registry, heartbeat
  persistence and health endpoints.

## Repository → Service architecture

Controllers/BackgroundServices stay thin; services own business logic and orchestration; repositories
own database access only. There are no repository/service interfaces where only one implementation
exists (per project rules). Interfaces are reserved for things with real alternatives (e.g. future
`ILlmProvider`, `ITranscriptionEngine`).

## PostgreSQL / EF Core

- Npgsql + EF Core 10, migrations in `BCookieSubs.Shared/Database/Migrations`, applied at startup by
  `DatabaseInitializer.ApplyMigrationsAsync` (both Web and Worker).
- Migration application is serialized across processes with a **session-level advisory lock**
  (`pg_advisory_lock`) so Web and Worker startup never race on the migrations table.
- `EnsureCreated` is not used.
- JSONB: worker hardware facts are an owned JSON entity; capability lists are JSONB via converters.

## Identity

- `ApplicationUser : IdentityUser<long>`, `ApplicationRole : IdentityRole<long>`,
  `IdentityDbContext`-derived context.
- Browser auth = Identity cookies. JWT exists for worker/external-API purposes only.
- First run: `FirstRunMiddleware` redirects to `/setup` while no user exists; the setup flow creates
  the **Owner** role with the full permission claim set and the owner account.
- Deactivating a user is Identity lockout (`LockoutEnd` ~100 years out) plus a security-stamp
  update, so existing cookies die immediately. Deleting is never used for admin deactivation.
- The cookie lifetime is wired to `ApplicationConfig.SessionTimeoutMinutes` at startup via
  `IOptionsMonitor<CookieAuthenticationOptions>`.

## Authorization

Permissions are a **code-defined catalog** (`PermissionCatalog`, keys like `permission:workers.view`),
stored as Identity RoleClaims per role. There is no permissions table; the catalog is seeded into
role claims at startup (idempotent, never removes claims an admin added).

- Controllers carry `[Authorize(Policy = "Perm:<key>")]`; a dynamic policy provider +
  `PermissionAuthorizationHandler` check the permission **from the database on each request**
  (UserRoles ⋈ RoleClaims), so role edits take effect without re-login. Hiding UI elements is
  cosmetic only — the backend check is mandatory and always present.
- Roles carry a `Level` (User=10 → SuperUser=20 → MasterUser=30 → Admin=40 → Owner=50).
  Management rules live in `UserManagementService`/`RoleManagementService`:
  - an actor may manage a target only when `actorLevel > targetLevel` (managing yourself is always
    allowed, except disabling yourself);
  - an actor may grant roles with `roleLevel <= actorLevel` — Owner can create another Owner but
    cannot edit a different Owner account;
  - the Owner role cannot be edited or deleted, and the last owner account cannot lose the role.
- Users can hold several roles; effective permission = union of role claims; effective level = max.

## Configuration

Single-row `ApplicationConfig` (EF-tracked). `ConfigService` validates and saves only when values
actually changed (change-tracking diff), so unchanged saves write nothing and audit nothing.
Settings precedence is explicit: environment variables own their settings (e.g. `OLLAMA_BASE_URL`,
secret env vars) and the UI shows them as **env-managed** — DB values never override a present env
var, and env-managed rows are locked against UI writes.

## Secrets

Optional runtime secrets (e.g. Ollama API key) are stored AES-256-GCM-encrypted using
`SECRET_ENCRYPTION_KEY`. The secrets page shows only configured/not and managed-by (env or UI);
plaintext never leaves the service layer, and env-managed secrets cannot be overwritten or deleted
from the UI while the env var exists.

## Models and prompts

- **Models**: catalog of configured LLM models (display name, Ollama model name, provider, base
  URL, roles). Uniqueness is `(modelName, modelUpdatedAt)`; soft-deleted
  models keep that key, so re-adding the same model **restores** the row instead of creating a
  duplicate. `ModelRole` rows (Translation/Judge/…) are freed on soft delete. A local Ollama catalog
  (`/api/tags`) and a seeded `recommended_models` table back the add flows; recommending an Ollama
  model requires it to be installed locally first.
- **Prompts**: `prompt` + immutable `promptVersion` rows. Editing creates a new version and
  deactivates the previously active one; any old version can be re-activated; deletion is soft.
  Required placeholders are validated warn-only (`//targetLang//` for Translation prompts,
  `//sourceText// //candidateList// //total// //totalMinusOne//` for Judge). `prompt_stats` keep
  per-version usage counters, shown on the prompt detail page.

## Theming and languages

- `theme` rows hold 17 CSS color tokens; seeded themes are built-in and locked. The effective theme
  resolves user pick → app default (`ApplicationConfig.SelectedThemeId`) → **Default Blue**. Layout
  emits the tokens as an inline `:root` style overriding `site.css`. Deleting the app-default theme
  resets the default to Default Blue.
- `language` (94 rows) is a seeded read-only catalog. The **translation-language order** exists
  globally (admin-managed) and per user (profile); editing the global list resyncs the acting
  admin's personal list.

## Audit log

Admin actions (user/role/permission changes, settings saves, secret changes, model/prompt/theme
changes, failed logins) are written through `AuditService.AdminActionAsync` as log rows
(`Level=Info`, `Type=admin`) with acting user, entity type/id and a message.

## UI

The UI's design lives in `wwwroot/css/style.css` and `wwwroot/js/app.js`; FontAwesome and
flag-icons live under `wwwroot/lib/`. Razor views reproduce the page structure one-to-one
(layout shell, sidebar, toasts, modals, tabs, step wizard), and theme tokens resolve to
consistent values. Flag icons are derived from the locale via `FlagCodes.Derive`,
not from the emoji column.

Intentional behaviors:

- `/settings` carries the configuration UI; config key `tmdbApiKey`.
- Secrets are never rendered as plaintext; env-managed rows show a "Set by environment" badge and
  are locked against UI writes.
- Forms carry antiforgery tokens; toasts use TempData instead of `?toast=`
  query strings.
- The password policy requires digit + upper + lower.
- `/models/add-recommended/:id` is folded into the add/sync modal via a hidden
  `recommendedModelId` field.
- `/account/language` validates the submitted code ("Unsupported language").
- Recommended models are listed in seed (id) order.

## Library scanning

- **Ownership**: scanning lives in the C# Worker (`LibraryScanCoordinator` hosting
  `LibraryScannerService` from Shared); the Web app never touches the filesystem. Schedules are
  stored per library path (hourly / custom / never) and evaluated by the coordinator. Scan state
  (`Idle`/`Scanning`/`Error`) is a database column; a crashed scan is recovered as stale on worker
  start. One scan per path at a time; a failing file logs and continues.
- **Matching**: candidate chain per file (series root folder → cleaned filename → embedded TMDB id
  → TMDB search → series reuse → NameFormatter LLM as last resort). TMDB calls are rate-limited and
  cached per scan. Poster images land in `MEDIA_PHOTOS_DIR` (shared `media-photos` volume; web
  serves them at `/media-photos/{file}` behind login, with a path-traversal guard).
- **Subtitle sources**: per-item cache rows (`library_path_item_subtitle_source`) hold discovered
  external files and mkvmerge -J embedded tracks, invalidated by mtime+size. Image-based tracks are
  listed and consumed by the OCR compute queue (external `.sup`/VobSub files OCR on a Python worker;
  embedded image tracks are extracted to a temp file first).
- **Events**: the coordinator publishes scan events on the orchestration bus → `WatchEvents` →
  Web's `OrchestrationWatcherService` → SignalR hub `/hubs/library` (group `library`, event
  `scanEvent`). Progress events are throttled server-side; `done` bypasses the throttle. The
  Library Paths page subscribes and keeps its 15 s diffing poll as a fallback.
- **Rescan**: the UI resets the row to `Idle` and clears `LastRunAt`; the coordinator's scheduler
  picks the path up within one tick and restarts a wedged scan.
- **Storage modes**: a library path is either a local mounted folder or a remote directory over
  SFTP. All library file I/O goes through `ILibraryFileSystem` (see
  [sftp-library-paths.md](sftp-library-paths.md)): credentials live encrypted in `app_secrets`,
  the SSH host key is pinned per path (no accept-unknown mode), and only files that need local
  tools (embedded probing/extraction, Whisper) are staged to `/work/staging` temporarily.

## Library pages: behavior

The Library Paths and Library Requests pages provide tabs, filters, lazy group/season
panels, poll diffing, accordion persistence, scroll restore, directory browser and bulk
selection. Behavior notes:

- English literals instead of i18n (same decision as the settings pages); success toasts now render.
- Forms carry antiforgery tokens (JS-rendered forms get the token injected by the page script).
- `/media-photos` requires login and rejects path traversal.
- The original select-candidate / select-TMDB library routes had no permission gate; the new service
  enforces `canChangeMatchForLibraryPaths` server-side.
- Library Requests change-match reuses the Library Paths search/select endpoints
  (`/library-paths/item/{id}/…`); the original `/library-requests/item/:id/match` route is folded away.
- `bulk-change-match` takes a flat form body (`itemIds` + match fields) instead of the original
  nested `tmdb` object the shipped JS never sent.

## Translation pipeline

All pipeline state lives in PostgreSQL; the C# Worker runs the loop, Web only creates tasks and
renders state. Flow: `subtitle` → one `subtitle_job` per target language → `subtitle_chunk`s of
~`DefaultChunkSize` original rows.

- **Claiming**: the translation runner (`TranslationRunnerHostedService` → `TranslationRunnerService`,
  2 s work tick / 5 s idle tick) claims chunks with raw `FOR UPDATE SKIP LOCKED` SQL (Npgsql), focused
  (finish the subtitle that already has running chunks first) or global. Chunks whose job/subtitle is
  cancelled/completed/failed/paused are never claimed. Chunk states: Queued → Running →
  WaitingForJudge → Retrying → Completed/Failed; retries capped by `MaxRetriesPerChunk`.
- **Candidates**: each attempt (per model × prompt version) parses the raw LLM answer as trcnk XML,
  integrity-validates it against the original rows and stores a candidate as camelCase JSON rows
  (`{ id, text }`). When enough candidates exist the Judge model (model role) receives them, picks a
  winner (reasoning + score into `judge_evaluations`), the winner is bound to the chunk and
  non-selected candidates are deleted.
- **Assembly/finalize** (`TranslationAssemblyService`): selected candidates are collected in chunk
  order, deserialized (case-insensitive, trcnk parse as fallback) and re-serialized in the source
  format (SRT renumbered 1..N, ASS mapped back by id). The job flips Completed with an output hash;
  when every job of a subtitle settles the subtitle flips Completed (or Failed if any job failed) and
  the final export runs.
- **LLM dispatch** (`LlmChatService`): Ollama local/cloud, ChatGPT, Claude. Ollama is **external** via
  `OLLAMA_BASE_URL` (see deviations). 10-minute request timeout.
- **Pause & schedules**: pause/resume from the dashboard aborts the in-flight model request, not just
  future ticks. Recurrence windows (day + start/end) gate the worker; while a window is open the
  schedule stays sticky; outside any window the runner auto-pauses. No enabled schedules means
  always run.
- **Recovery**: startup sweep resets chunks stuck in Running for `ModelRequestTimeout` + 60 s; a
  crashed tick releases its running chunk (candidates kept) and logs `Translation worker loop
  crashed: …`, then the loop continues.

## Library integration (V5)

- **Auto-translate hook points**: a new media item on an `AutoTranslate`
  path is queued automatically (`AutoTranslateItemAsync`: blacklist → image-based sources go to the
  OCR compute queue → `.sub` converted → source SRT read → per-user-language targets →
  `CreateSubtitleTaskAsync` → item Queued). Existing items are never auto-translated; the scan only
  re-reconciles exports and refreshes stale subtitle-source caches.
- **Standalone companion SRTs** discovered on disk are auto-detected as sources; external/embedded
  overrides are honored. Image-based sources are queued for OCR (compute jobs) instead of being
  rejected.
- **Exports** (`LibrarySubtitleExportService`): everything is gated on `libraryPath.AutoExtract`.
  Naming is
  `<mediaBase>.<iso639>.srt` beside the media (Jellyfin/Plex companion naming); SRT gets a
  "Translated by BCookieSubs" credit cue (first 0–0.9 s) and renumbering; ASS gets the Thai font
  policy. Written once and registered in `exported_subtitle_files` (unique per library path + path),
  so later sweeps skip existing files; the next scan's reconcile pass registers detected exports in
  `translated_library_items`.
- **`autoExtractItems` sweep**: at the end of every scan, finished subtitles for the path are exported
  using the exporter default `markCompleted=true` (a later-enabled path flips its items to Completed).
- **Subtitle sources / live recompute**: source-cache rows are invalidated by mtime+size; a stale
  cache is recomputed during the scan and the reconcile pass follows immediately.
- Whisper originals export as `IsWhisper` registry rows (transcript sources for the compute
  pipeline).

## Translation pipeline notes

The pipeline: candidates per model/prompt version, judge selection, per-chunk retries, chunk
size, focused claim, startup stale sweep + crash-release loop. Behavior notes:

- Ollama is an external service reached via `OLLAMA_BASE_URL` (never spawned in-process). The
  compose worker passes the API keys and base URL through as env
  vars. In Docker deployments `setup.sh` picks the placement per platform: macOS uses the host
  Ollama via `host.docker.internal`; Linux/Windows run Ollama as a Compose service (profile
  `ollama`, CPU by default, NVIDIA via the GPU overlay); Ollama Cloud installs set only
  `OLLAMA_API_KEY`.
- OCR-dependent paths run on the compute job queues (Python workers OCR `.sup`/VobSub, then the
  translation path continues normally).
- Web never touches the media filesystem; scans and exports run in the C# Worker.

Defects found during end-to-end validation (all fixed; kept here as a register):

1. Raw-SQL identifiers must be quoted PascalCase — unquoted identifiers fold to lowercase
   (`column x.id does not exist`) on the claim paths.
2. SRT parser port of `srt-parser-2`: capture-split off-by-one swapped timing columns.
3. Ollama requires `stream:false` for single-response reads; NDJSON streaming responses
   otherwise fail JSON parsing.
4. Scan coordinator/watcher deadlock: a successful scan awaited a watcher that only exits once the
   scan itself leaves the Scanning state — every successful scan hung until stuck-recovery. Fixed
   with a linked cancellation token the coordinator cancels before joining the watcher.
5. Assembly candidate JSON is stored camelCase — deserialization needs
   `PropertyNameCaseInsensitive` (case-sensitive defaults produced null row ids → assembly crash).
6. `ExecuteUpdateAsync` bypasses the EF change tracker; tracked snapshots went stale at two
   finalize/export points (subtitle finalize read stale "Running" jobs; export read a stale null
   `TranslatedText` and wrote 0-byte files). Reads made `AsNoTracking`.
7. The autoExtract sweep initially passed `MarkCompleted=false`; the exporter default
   (true) is what callers should rely on. Fixed.

## Compute jobs

Whisper and OCR run as durable `worker_jobs` rows dispatched to Python
workers over the gateway stream. `ComputeJobService` owns state transitions (C# is the source of
truth); `ComputeJobDispatcher` (2 s tick) claims and pushes; Python only computes.

- **Whisper** (`whisper.transcribe`): Web's `create-whisper-subtitle` creates the subtitle row
  (`Source=Whisper`, state `QueuedForTranscription`) plus placeholder translation jobs
  (`TotalChunks=0`). The dispatcher's queue-head query dispatches only the head, and a head change
  preempts in-flight runs with a `JobCancel` whose checkpoint
  (`WhisperResumeSrt`/`WhisperResumeMs`) keeps the run resumable. Finalize: SRT dedupe, idempotent
  hash, `transcription_completed`, export to the library folder, then translation-job creation
  (placeholders become real, extra languages added),
  and finally the state is cleared to NULL with `Status=Queued`.
- **OCR** (`ocr`): `EnqueueOcrJobAsync` queues an item-bound payload (priority = max+1). Source
  resolution moved to claim time in the dispatcher: text sources (`.srt`,
  `.sub`/`.idx` with text content, embedded text tracks) complete inline
  (`CompleteOcrTextSourceAsync`) and queue translation directly; image sources (`.sup`, `.sub` with
  sibling `.idx`) are staged under the C# worker's OCR staging directory
  (`BCOOKIESUBS_OCR_STAGING_DIR`, default `/work/ocr`) and dispatched with
  `imageKind`/`imagePath`/`ocrLang`. Python parses the container → burns onto a black canvas with
  ffmpeg → one frame per event → Tesseract psm 6 (`|` normalized to `I`) → SRT. The result feeds
  `PrepareTranslationForItemAsync`.
- **Transcription engine**: faster-whisper (CTranslate2). Payload semantics are
  (model, timestamps length, CUDA, resume checkpoint). Documented in `docs/workers.md`.
- **Progress**: `JobProgress` doubles as the job heartbeat; whisper gets the longer lease because
  progress can be sparse over long silences. Aborts return a partial checkpoint (`aborted`),
  consistent with the pause/preempt path.
- **Local worker bootstrap**: the compose Python worker enrolls on first run via the
  `LOCAL_WORKER_ENROLLMENT_TOKEN` env pass-through (`bcsen_…` minted in the Workers UI), then
  persists its identity in the `python-worker-data` volume; a spent token is harmless.

Defects found during compute-job validation (all fixed; kept here as a register):

1. Cleartext HTTP/2: a Kestrel `Http1AndHttp2` cleartext endpoint never negotiates h2c
   (dotnet/aspnetcore#56984). The worker's gRPC port is configured `HttpProtocols.Http2`
   explicitly; healthchecks use `curl --http2-prior-knowledge`.
2. `ExecuteUpdate` staleness in the whisper finalize: the subtitle re-read after the dedupe write
   returned a stale tracked row → "Original SRT could not be parsed". Fresh `AsNoTracking` reads
   in both finalize and translation-job creation.
3. Whisper queue-head re-claim loop: with EF relational null semantics, `state != 'completed'`
   also matched `state IS NULL`, so finished
   subtitles re-entered the queue every tick. The query now requires a non-null state.
4. Inactive-protobuf-oneof access: `first.Auth.X` on an `Enroll` message (and vice versa) throws —
   both gateway reads are guarded by `PayloadCase`.
5. Orchestration `WatchEvents` opened without the shared API key header (only the snapshot probe
   had it) → "invalid orchestration key" log spam. The header now rides on the stream itself.
6. Empty-string source-override `Codec` from the translate-batch endpoint selected the
   embedded-track branch and skipped companion files; `ResolveSrtSourceAsync` normalizes
   empty/zero preferences to null.
7. OCR engine validation: PGS `.sup` synthesis must match ffmpeg's `pgssubdec` exactly
   (ODS carries width/height *inside* the 24-bit length; PCS object count at offset 10).
   VobSub shares the burn/frame/Tesseract pipeline and the `.idx` timestamp parser; the
   PGS path carries the e2e validation.

## Worker model

Durable (PostgreSQL): `worker_nodes` (registration, capabilities, allowed capabilities, hardware,
concurrency, timestamps), `worker_enrollments` (one-time codes, hash-only), `worker_credentials`
(secret hash, revocation).

Runtime (memory, C# Worker only): `WorkerConnectionRegistry` — live sessions, heartbeat times,
readiness, active jobs, connection lifecycle. Nothing about streams is persisted.

Effective state = `f(durable, live)`:

| Condition | State |
|---|---|
| `Enabled = false` | Disabled |
| no live connection, never connected | Pending |
| no live connection | Offline |
| connected + draining | Draining |
| connected, `ActiveJobs >= MaxConcurrency` | Busy |
| otherwise | Online |

A recent `LastSeenAt` never implies eligibility; the live connection does.

## Worker enrollment and authentication

1. Admin creates an enrollment → random one-time token (`bcsen_…`), stored **hash-only**, 24 h expiry,
   single-use (conditional update prevents double-spend).
2. The Python worker sends an `EnrollRequest` over the gateway stream. Server consumes the code in a
   transaction (worker row + credential + consume), returns the generated worker secret (`bcsk_…`)
   **once** and a short-lived JWT (HS256, `Worker:SigningKey`).
3. The worker persists `worker_id` + secret locally (0600 file) and authenticates every future
   connection with a secret hash comparison (constant-time). `WorkerId` alone is never trusted.
4. Removing a worker revokes credentials first, deletes the row, and force-closes the live stream.
   Re-connection requires fresh enrollment.

## gRPC

- `proto/worker_gateway.proto` — the bidirectional `Connect` stream: first message enrolls or
  authenticates; then heartbeats, config updates, drain/resume, disconnects.
- `proto/orchestration.proto` — internal Web ⇄ Worker channel (shared API key header):
  `GetSnapshot`, `WatchEvents` (server-stream), `NotifyWorkerChanged` (UI actions reach live sessions).
- Python code generation: `scripts/generate-proto-python.sh`; C# generation: Grpc.Tools at build.

## SignalR

Browsers join the `workers` group on `/hubs/workers`, the dashboard group on `/hubs/dashboard` and
the library group on `/hubs/library`. Web's `OrchestrationWatcherService` streams orchestration
events into SignalR; UI-triggered durable changes broadcast directly. Events carry their data
payloads (row/log/count DTOs built server-side), so browsers update DOM entries in place and never
issue follow-up requests for a pushed change; request counts are per-user (`Clients.User`).
HTTP fetches happen only on page load, on reconnect reconciliation, for exceptional recovery and
for explicit user actions. No polling loops.

## Scaling notes

- One C# Worker instance owns Python worker streams. The schema does not prevent more
  instances later (no connection state in PostgreSQL), but a future version must add stream
  ownership (e.g. sticky ownership + a shared event source) — multiple C# workers would each hold
  their own registry, and Web would need to fan out per instance.
- The orchestration API key and JWT signing key are deployment-wide configuration, so additional
  instances can be introduced without schema changes.

## Docker

`docker-compose.yml` (repository root) = PostgreSQL + Web + C# Worker + one local Python worker.
`docker-compose.dev.yml` = dev overrides. `docker-compose.gpu.yml` = NVIDIA overlay for Python workers.
`/media`, `/work`, `/models` volumes are declared now for future job payloads (paths and metadata only;
no large files over gRPC). Remote workers run only the Python worker and connect outbound.

`TRANSLATION_ROOT_DIR` (optional) seeds the first-run library root and, when set, is bind-mounted
into web/worker/python-worker at the same absolute path, so host library directories work
unchanged; library-path creation confines paths to that root and rejects paths the containers
cannot see.
## Dashboard, stats, logs, schedules, translated, offset

Six pages share the dashboard UI. Backend routes live in `DashboardController`, `StatsController`,
`LogsController`, `SchedulesController`, `TranslatedController`, `OffsetController`.

- Dashboard: poll JSON, upload step1/step2 (TMDB lookup), inspect, queue ops (cancel/requeue/hide/
  delete/delete-series, move-up/down/top, reorder), OCR queue ops, bulk cancel/delete, download,
  poster, retry-chunk/reset-chunk, and worker pause/resume for three independent runners
  (translation/whisper/OCR) via gRPC `SetTranslationRunnerPaused` / `SetComputeRunnerPaused`.
- Stats: page + subtitle-data/job-data/model-data/judge-data/poll. Chart.js UMD bundle copied to
  `wwwroot/lib/chartjs/chart.js` (static third-party asset, same as lib/flag-icons).
- Logs: page + 15s poll + export (txt/json/csv) with level/type/search filters and date bounds.
- Schedules: add/update/delete, `ScheduleConfigured` gate on the sidebar entry.
- Translated: paginated finished list with posters, export link, delete.
- Offset: client-side SRT offset editor; server only parses (file or library file), lists library
  media/SRT files, and rewrites a chosen SRT (with optional credit block).

JSON payloads keep the field names the page JS parses (`promptVersionId`, `chunkSizeTotal`,
`targetLangId`, `orderNumber`, `whisperTranscriptionStatus`), lowercase status strings via
`EnumText.Snake`, and "yyyy-MM-dd HH:mm:ss" UTC timestamps.

Deliberate deviations:

- The offset editor is the one place the Web process touches the media filesystem (list SRT files
  next to a library item, rewrite an edited SRT in place). The compose web service mounts
  `media:/media` for this; every other flow remains worker-only.
- Worker page and About page keep their existing sidebar entries; the six dashboard entries follow
  the standard sidebar order and gates (Dashboard and Translated are ungated; Offset requires
  `ScanLibraryPaths`; Schedules requires `ScheduleConfigured`).

Defects found during end-to-end validation (all fixed; kept here as a register):

1. `File(string, ...)` in MVC is the *virtual-path* overload — logs export, dashboard download, and
   the offset SRT download initially 500'd with a `VirtualFileResult` file-not-found. All return
   UTF-8 encoded bytes now.
2. Logs JSON export carries camelCase keys, lowercase level, and "yyyy-MM-dd HH:mm:ss" times /
   ISO timestamps (CSV level was lowercase-corrected too).
3. `/dashboard/worker/pause|resume` runs on top of the translation-runner gRPC RPC.
4. Bulk cancel/delete with empty arrays returns `{success:false, msg:"Nothing selected"}`.
5. Razor compile fixes in the new views: `CurrentUserContext` needs `@using BCookieSubs.Web.Services`;
   `<text>` blocks inside `@section Scripts` parse JS strings as markup — use conditional
   `<script>` elements instead; `@:` chains replaced with computed strings.

Validation performed (dev stack, docker compose): all six pages render; sidebar gates verified with
config flags toggled on/off; dashboard poll + all pause/resume endpoints ×3; upload step1/step2 e2e
(job created and executed by the runner); cancel/requeue/hide/move-series/move-up/move-down;
inspect; retry-chunk/reset-chunk with runner re-execution; reorder/whisper reorder/ocr reorder;
bulk (empty, completed-skip); download; poster (404 when no photo exists); stats page
+ all five JSON endpoints; logs page/poll/export ×3; schedules add/update/delete; offset
parse/library-media/library-srt-files/parse-library/save-to-library-path (credit block + shifted ids
verified on disk); translated page + delete.
