# Workers

How external compute workers (Python) work in BCookieSubs.

## Concepts

| Concept | Lives in | Notes |
|---|---|---|
| Worker registration | PostgreSQL `worker_nodes` | name, machine identifier, version, capabilities, allowed capabilities, hardware, concurrency, timestamps |
| Enrollment | PostgreSQL `worker_enrollments` | one-time token, hash-only storage, 24 h expiry, consumed/revoked state |
| Worker credential | PostgreSQL `worker_credentials` | SHA-256 hash of the worker secret; revocable |
| Live connection | C# Worker memory | `WorkerConnectionRegistry`; never persisted |
| Effective state | computed | `f(durable row, live connection)` |

## Enrollment flow

1. **Workers → Add Worker** creates an enrollment. The plaintext token (`bcsen_…`) is shown once;
   only its SHA-256 hash is stored. Default expiry: 24 h.
2. `scripts/setup-worker.sh` (or plain Python) connects to the gateway and sends `EnrollRequest`
   (token, name, machine identifier, version, capabilities, max concurrency, hardware).
3. The server validates hash/expiry/single-use in a transaction that also creates the worker row and
   credential, then returns `worker_id` and the worker secret (`bcsk_…`) **exactly once**.
4. The worker persists the credential to `/data/identity.json` (mode 0600) and reconnects without
   re-enrollment forever after.

Failure modes (unknown, expired, revoked, already-used token) all return the same message.

### Bootstrap token for deployment-local workers

The compose stack ships one Python worker whose enrollment should not require a UI round-trip on a
fresh install or after wiping its data volume. When `WORKER_BOOTSTRAP_TOKEN` is set in `.env`
(e.g. `openssl rand -hex 24`), the gateway accepts it as an alternative to a single-use code
(`Worker__BootstrapToken`, same trust domain as the JWT signing key, constant-time compared, never
stored in the database). The compose Python worker sends it automatically; enrollment then happens
at container creation. `LOCAL_WORKER_ENROLLMENT_TOKEN` (a minted one-time code) still takes
precedence, and leaving `WORKER_BOOTSTRAP_TOKEN` unset restores code-only enrollment. Wiping the
worker data volume re-enrolls under a new machine identifier, creating a new node — remove the
stale one in the Workers UI.

## Authentication

- Every connection authenticates with `worker_id` + worker secret. The server hashes the presented
  secret and compares it in constant time with the stored hash of an active (non-revoked) credential.
- On success the server mints a short-lived JWT (HS256, claims `worker_id`, `worker_name`) for the
  session/future integrations. The JWT is an addition, not the primary stream credential.
- Credentials are never logged; enrollment/secret plaintexts are never stored server-side.

## Capabilities

Reported (`WORKER_CAPABILITIES=whisper,ocr,vision`) vs **allowed** (administrator-controlled). At
enrollment, allowed defaults to everything reported; administrators trim per worker in the UI.
Scheduling (compute jobs) uses the intersection of reported ∩ allowed.

## Engines

- **whisper** — faster-whisper (CTranslate2). Standard faster-whisper model names,
  timestamps-length option, CUDA flag and resume-checkpoint semantics. Models download to
  `WORKER_MODELS_DIR`
  (`/models` volume) on first use, driven by the `WhisperModel` setting.
- **ocr** — PGS (`.sup`) and VobSub (`.sub`/`.idx`) via ffmpeg burn + Tesseract (psm 6).
  Language packs must cover the requested OCR language (`tesseract-ocr-<lang>` in the image).
- **vision** — reserved for future ML workloads; no engine yet.

## Concurrency

Workers report `MaxConcurrency`; heartbeats carry `ActiveJobs`. Compute-job dispatch enforces
`ActiveJobs < MaxConcurrency` before claiming.

## Heartbeat

- Default interval 10 s (server may change it via `ConfigUpdate`).
- Heartbeats update the live registry every beat; `LastSeenAt` is persisted to PostgreSQL at most
  every 30 s per worker (and on connect/disconnect immediately).
- A connection with no heartbeat for 45 s is torn down by the gateway monitor.

## Reconnect

The Python worker reconnects forever with bounded exponential backoff (1 s → 30 s cap + jitter),
across server restarts, network failures and container restarts. A previously enrolled worker
authenticates with its stored identity; no re-enrollment. If the same worker somehow opens a second
stream, the older one is terminated ("superseded").

## Disable / Drain / Resume / Remove

| Action | Durable effect | Live effect |
|---|---|---|
| Disable | `Enabled=false` | stream closed immediately ("worker disabled") |
| Drain | `Draining=true` | `DrainCommand` + `ConfigUpdate(draining)`; worker reports not-ready |
| Resume | `Draining=false` | `ResumeCommand` + `ConfigUpdate(draining=false)` |
| Remove | credentials revoked, row deleted | stream closed; re-auth impossible |

All of these are pushed from Web → Worker via `NotifyWorkerChanged` the moment they happen.

## Eligibility

A worker is eligible for a task only when **all** of these hold:

1. `Enabled = true`
2. required capability reported **and** allowed
3. live gateway stream present
4. heartbeat recent
5. reports ready and not draining
6. `ActiveJobs < MaxConcurrency`

Live connection state is the gate; a stale `LastSeenAt` never is.

## TLS note

On the local Docker network the gateway runs plaintext (`WORKER_INSECURE=1`). For remote workers over
untrusted networks, put the gateway behind TLS (reverse proxy or the gateway's HTTPS endpoint) and set
`WORKER_INSECURE=0`.