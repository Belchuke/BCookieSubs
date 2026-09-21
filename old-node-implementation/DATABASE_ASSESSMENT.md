# DATABASE_ASSESSMENT.md

Diagnosis of the BCookieSubs database and translation pipeline. Every claim
below is either **measured against the production-derived database copy**
(`subtitles.db`, 14.41 GB, in the repo root) or **read directly from the
code/log mining** — hypotheses are labelled as such and listed with the exact
production checks that would confirm them.

## Scope and method

- Read-only inspection of the production-derived DB copy. Nothing was written
  to it: no VACUUM, no schema changes, no deletes. All experiments (diagnostic
  scripts, query plans) ran read-only.
- The DB copy is **torn** — `PRAGMA quick_check` reports "2nd reference to
  page" / overflow-list errors plus a tail of ~4,000 "never used" pages. This
  means the copy was taken mid-write without a checkpoint. **It does not prove
  the production database is corrupt**; a proper copy (SQLite `.backup` /
  `VACUUM INTO`, or a filesystem snapshot with the WAL) must be used next time
  (see Production checks). The torn regions are why `dbstat`, table COUNTs on
  `subtitleChunkCandidate`/`subtitle`, and some index scans failed here; every
  number that follows was measured with index-assisted queries that avoid the
  torn regions, or by LENGTH-based estimation.
- Code was read fully along the paths the DB touches: `setup.ts` (schema,
  PRAGMAs, migrations), the translation worker (`translateTask.ts`),
  repositories (subtitle, log, config), dashboard route + client `app.js`,
  OCR/Whisper/scanner workers, auth middleware, and export paths.

## TL;DR

- The 14.4 GB is **not** bloat of the "active" tables: ~13.2 GB is a small set
  of write-only or never-cleaned data classes (candidates + chunkTextRaw + judge
  inputs). Free space is only 2.5 MB (`freelist_count=609`) — VACUUM would
  reclaim almost nothing; deleting the dead data classes is what reclaims space.
- The app's SQLite configuration is fundamentally sound (WAL + NORMAL, one
  writer at a time, worker threads over better-sqlite3). Nothing observed
  requires PostgreSQL. **Recommendation: stay on SQLite.**
- The real problems were code: a never-called cleanup function, a greedy
  judge-JSON regex that re-tried identical candidates up to 14×, missing
  indexes on the largest tables, an unindexed retention DELETE on every worker
  tick, and a dashboard poll that shipped ~520 MB of unused text every 15 s.
  All fixed in this pass (see "What was changed").

## Part 1 — Proven database findings (measured)

**Configuration (PRAGMAs, live values from the copy):**

| Setting | Value | Verdict |
|---|---|---|
| journal_mode | wal | correct for this workload |
| page_size | 4096 | default, fine |
| page_count | 3,518,344 pages = 14.41 GB | |
| freelist_count | 609 pages (2.5 MB, 0.02%) | VACUUM would reclaim ~nothing |
| auto_vacuum | 0 (none) | fine given the fixes below |
| synchronous | 1 (NORMAL) | correct pairing with WAL |
| busy_timeout | 5000 ms | raised to 10000 ms in code |
| cache_size | -16000 (16 MB) | fine |

**File size accounting (measured via LENGTH sums over live rows; character
counts — bytes are higher for non-ASCII text):**

| Data class | Size | Read by any code? |
|---|---|---|
| `subtitleChunk.chunkTextRaw` | 6.2–6.6 GB | **No — write-only** (no SELECT anywhere) |
| `subtitleChunkCandidate.*` | ≈ 6.4 GB (residual) | **No — only the selected winner is read** |
| `judgeEvaluation.judgeInput` | 642–673 MB | diagnostics page only |
| `subtitleJob.translatedText` | 518–543 MB | yes — download/export/assembly (legit) |
| `judgeEvaluation.judgeReason` | 49–54 MB | diagnostics page |
| `libraryPathItemSubtitleSource.sourcesJson` | 44.7 MB | scanner |
| `log` text columns | ~17 MB | dashboard/logs page |
| All other tables | < 40 MB combined | |

`subtitleChunk` = 1,005,727 rows; `subtitleJob` = 1,501; `judgeEvaluation` =
164,980; `log` = 229,491 (span 2026-08-03 → 2026-09-21); `subtitle` = 752;
`mediaItem` = 1,554; `userSession` = 26 (25 expired). The candidate table is
unreadable in the torn copy (COUNT fails with SQLITE_CORRUPT), so its size is
the residual after accounting for everything measurable: ≈ 6.4 GB — consistent
with 4–6 candidates per chunk across 1,005,727 chunks, each carrying a full
prompt snapshot plus its translation.

**Indexes present in the production DB:** only 3 (auth tables:
`userRole.userId`, `rolePermission.roleId`, `libraryPathOcrJob.status`).
The fresh-DB schema defines 6 more (chunk: subtitleId/status; candidate:
modelId/chunkId/status/selected) but `createTables` runs only for brand-new
databases — existing DBs never got them. `log` never had an index on
`createdAt` in any schema version. The index-migration mechanism added in this
pass creates all of them on next app start (a one-time build over existing
rows; on millions of candidate rows this takes minutes and holds the write
lock while it runs — see Production checks).

## Part 2 — Proven code findings

1. **Candidate cleanup never ran.** `deleteUnneededCandidates` (subtitle
   repository) deletes non-selected completed candidates for one chunk —
   implemented, correct, and **called from zero places**. This is the single
   largest growth driver: every chunk permanently keeps 4–6 full translations
   plus their prompt snapshots. (Fixed: called after judge selection; failed /
   validation-failed candidates stay for diagnostics; a maintenance script
   deletes older leftovers with retention.)
2. **chunkTextRaw and promptTextSnapshot are write-only.** No SELECT reads
   them anywhere. chunkTextRaw accumulated 6+ GB of per-chunk JSON. (Fixed:
   no longer populated — the column stays NOT NULL and schema-compatible;
   maintenance clears existing content in place.)
3. **The judge parsed model output with a greedy regex**
   `content.match(/\{[\s\S]*\}/)` and `JSON.parse`'d the match. When a model
   appends anything after the JSON, the match spans the junk and parse fails —
   exactly the 569 logged "Unexpected non-whitespace character after JSON at
   position … (line 2 column 1)" events. Each failure was retried up to
   `maxRetriesPerChunk` (14) times against identical candidates. (Fixed: staged
   parser `src/services/judgeResponseParser.ts` — strict parse → fence strip →
   first balanced object (string-aware) → truncation repair → shape validation;
   format failures get a short repair instruction and a bounded retry budget
   (default 3, `JUDGE_FORMAT_RETRIES`); rejections are never re-judged.)
4. **"Judge rejected all candidates" regenerated the world.** On rejection the
   whole chunk was regenerated (all models × prompt versions × retries) and
   re-judged — 8,146 rejection events, 2,156 chunk failures, and whole jobs
   failing because one chunk's judge loop kept losing (e.g. job 1010: 1 of 266
   chunks). (Fixed: after the judge budget is exhausted — or it rejects — the
   chunk completes using the first structurally-valid candidate, with the
   fallback recorded in `judgeReason` and a warning log. Bounded, and the
   translation is not lost.)
5. **The dashboard poll shipped dead data.** `/dashboard/poll` returned every
   `subtitleJob` row including `translatedText` (a 518–543 MB text pool) plus
   full `mediaItem` rows every 15 s, and joined them in O(n×m) JS loops. No
   client reads `jobs` or `mediaItems` — `public/app.js` consumes only
   `subtitles` + `languageMap`. (Fixed: poll returns only what the queue render
   reads; `hasTranslation` is computed in SQL; map-based joins; timing/size
   instrumentation warns when a poll exceeds 250 ms or 200 KB.)
6. **The Translated page shipped translations it does not render** —
   `getFinishedSubtitlesPage` selected `translatedText` for the view that only
   renders download links. (Fixed: column dropped from the query and the type.)
7. **Log retention ran on every worker tick** — `deleteLogsJob` does a config
   read plus an unindexed `DELETE ... WHERE createdAt < ...` over 229k rows,
   several times per minute, in the same process that translates. (Fixed:
   throttled to hourly, and `idx_log_createdAt` turns the DELETE from a full
   scan into an index range scan — verified with EXPLAIN QUERY PLAN.)
8. **A worker crash stranded its chunk.** The `taskMain` loop caught errors and
   kept looping, but the claimed chunk stayed `status='running'` — unrecoverable
   until the next worker restart's stale sweep (up to the timeout+60s later).
   (Fixed: the loop's catch releases claimed chunks back to the queue
   immediately; the per-chunk claimed-set is also pruned when a chunk finishes,
   so pause-time release only touches in-flight chunks.)
9. **No backoff between retries.** Production logs show 5 consecutive
   immediate 300s-timeout retries against the same provider. (Fixed: 2 s →
   capped 30 s backoff before candidate retries after timeout/model errors.)
10. **No VACUUM/checkpoint code existed anywhere** — nothing to remove, and
    none was added to hot paths. WAL checkpointing was left to SQLite's
    auto-checkpoint (the copy's WAL was 0 B at rest, consistent with that).
11. **No transaction spans Ollama/model calls** — the DB is never locked by
    media work; each request is followed by short, separate writes. This
    suspicion from the brief is disproven for this codebase.

## Part 3 — Log evidence (production-derived, mined from the log table)

- **30 "database is locked" events over 7 weeks** (2026-08-03 → 2026-09-21):
  3 killed a translation worker tick (each recovered on the next tick, but the
  claimed chunk stayed running — finding 8), the rest came from the library
  scanner. This is a low rate, consistent with the missing log index (a long
  unindexed DELETE holding the write lock while other connections tried to
  write) — not with a fundamental SQLite concurrency problem.
- **8,146 "judge rejected all candidates"** (up to ~1,000/day) — each one
  triggered the regeneration loop of finding 4.
- **569 malformed-JSON judge failures**, all with the "(line 2 column 1)"
  fingerprint of trailing text after a valid JSON object — finding 3.
- **2,156 chunkFailed events**; retry chains of 5 consecutive immediate
  300 s timeouts (finding 9).
- Log level distribution: 217,717 info / 9,389 warning / 2,385 error.
- No `PRAGMA`, `VACUUM`, or schema-maintenance activity appears anywhere in
  the logs — the DB was never vacuumed, which matches the near-zero freelist.

## Part 4 — Production-only hypotheses (not provable from this copy)

These require checks against the live database/app (commands in Part 8):

1. **Production DB integrity.** The copy is torn; the live DB is presumed
   healthy (a corrupt primary would have surfaced as constant SQLITE_CORRUPT
   in the logs — there are none).
2. **Live WAL/checkpoint behavior under load.** The copy's WAL was 0 B at rest
   (auto-checkpoint working). Under sustained translation load the WAL can
   still grow between checkpoints; the dashboard instrumentation and
   `db:diagnose` will show it.
3. **Real candidate-table row count.** Unreadable in the torn copy; the ≈6.4 GB
   residual is an inference, not a COUNT. After the fixes + one maintenance
   run, the freed size is directly observable.
4. **Dashboard poll latency in production.** Now instrumented (>250 ms or
   >200 KB payload warns to the server console). Actual production latency was
   never measurable from here.
5. **Exact lock frequency at peak concurrency.** The log table only records
   what was logged; scanner-side lock events may be under-recorded.

## Part 5 — Recommendation: stay on SQLite

**Stay on SQLite.** The measured evidence does not support a PostgreSQL
migration, and none of the found problems are ones PostgreSQL would fix:

- The workload is single-writer, low-concurrency: one app process, five
  worker threads sharing WAL mode, occasional scanner/OCR/Whisper writes.
  SQLite in WAL mode handles exactly this shape; 30 lock errors in 7 weeks is
  the symptom of one unindexed hot-path DELETE (now indexed + throttled), not
  of a concurrency ceiling.
- The 14.4 GB is application-level data hygiene, not engine limitation:
  write-only columns and an uncalled cleanup function. Both are fixed in code;
  the reclaim happens via the maintenance script, not a different database.
- The retry storms were application logic (greedy judge parsing, regeneration
  on rejection), now bounded and distinguished by failure class.
- Migration cost is real: 14 GB of data to move, an entirely synchronous
  better-sqlite3 call style threaded through every repository and all five
  workers, plus re-verification of every preserved behavior (export, OCR,
  Whisper, library matching, permissions…).

**Conditions that would change the recommendation** (each is observable, and
each is checked by the production checks in Part 8):

- Sustained writer contention: repeated "database is locked" errors after the
  index fixes (watch the log for the phrase over a normal week).
- Multi-instance deployment: the app moved to more than one machine/process
  writing simultaneously (SQLite allows one writer host).
- Database size exceeding ~100 GB or single-table b-trees whose hot working
  set stops fitting the page cache.
- A feature genuinely needing concurrent writers or long interactive
  transactions (none exists today).

## Part 6 — What was changed (this pass)

| Area | Change |
|---|---|
| `src/setup.ts` | `busy_timeout` 5000 → 10000 on every connection; new `INDEX_MIGRATIONS` + `applyIndexMigrations()` so existing DBs get the 6 fresh-DB indexes plus `idx_log_createdAt` (idempotent `CREATE INDEX IF NOT EXISTS`, checked against `sqlite_master`) |
| `src/services/judgeResponseParser.ts` | NEW staged judge-JSON parser (strict → fence strip → first balanced object → truncation repair → shape validation) + `judgeRepairPrompt` |
| `src/tasks/translateTask.ts` | judge uses the staged parser; format-failure retry budget (3, `JUDGE_FORMAT_RETRIES`) with repair instruction; rejection is not re-judged; after the budget the chunk completes via the first structurally-valid candidate (recorded in `judgeReason` + warning log); `deleteUnneededCandidates` wired after selection; crash-catch releases claimed chunks; claimed set pruned per chunk; hourly log-cleanup throttle; backoff before timeout/model-error retries |
| `src/repositories/subtitleRepository.ts` | `chunkTextRaw` no longer populated (5 INSERT sites); `promptTextSnapshot` not stored (nullable); `getDashboardData` returns only `subtitles` + `languageMap` with SQL-side `hasTranslation` and map joins; `getFinishedSubtitlesPage` drops `translatedText` |
| `src/repositories/dbMaintenanceRepository.ts` | NEW: retention/batched maintenance functions (candidates, judge evaluations, chunkTextRaw, orphans, sessions) |
| `src/routes/dashboard.ts` | poll reshaped; slow-poll instrumentation (>250 ms / >200 KB) |
| `scripts/db-diagnose.js` | NEW read-only diagnostics (`npm run db:diagnose`) |
| `scripts/db-maintenance.js` | NEW batched maintenance + guarded, warning-gated VACUUM (`npm run db:maintenance`, `--vacuum --yes`, `--dry-run`) |
| `package.json` | `db:diagnose`, `db:maintenance` scripts |

Preserved functionality: translations, judge (with bounded budgets), model
roles, OCR, Whisper, library scanning/matching/schedules, users/roles/
permissions, dashboard, settings, statistics, subtitle export, logs, finished
subtitle history. `npm run build` passes with zero TypeScript errors.

**No automatic VACUUM was added anywhere**; `db:maintenance --vacuum` requires
the explicit flag + `--yes` and prints the disk/exclusivity warnings first.

## Part 7 — Conditional: phased PostgreSQL migration (not performed)

Not recommended today (Part 5). If a trigger condition appears, migrate in
this order — each phase is independently verifiable and reversible:

1. Run the production checks (Part 8) and one maintenance cycle first; migrate
   a clean, small database, not a 14 GB one.
2. Stand up PostgreSQL with WAL-friendly settings (`synchronous_commit=on`,
   sensible `max_connections`), and a migration-only schema mirror of the
   current tables/columns/indexes.
3. Add a thin data-access seam if needed: the repositories are already the
   single SQL surface, which makes the swap mechanical.
4. Choose an async client (pg) and wrap repository calls — better-sqlite3's
   synchronous style does not survive the move; budget for `await` propagation
   through repositories → services → routes.
5. One-time ETL: export SQLite rows to ndjson/CSV per table, bulk
   `COPY` into PostgreSQL, reapply sequences, then row-count + checksum
   verification per table.
6. Dual-write or shadow-read behind a feature flag while validating.
7. Move read paths first (dashboard, logs, history), then the translation
   worker writes, then OCR/Whisper/scanner.
8. Convert batched-delete maintenance scripts to PostgreSQL equivalents
   (batched `DELETE ... WHERE id IN (...)` or `ctid`-window loops).
9. Replace SQLite-specific SQL (`datetime('now', '-14 days')`,
   `PRAGMA`s, `IIF`/`TRIM` quirks) with PostgreSQL equivalents.
10. Re-run EXPLAIN-based index review on the new planner; keep the same
    logical indexes.
11. Cut over, keep the SQLite file as read-only archive, drop dual-write.

Items 3–8 are the effort concentration; a realistic estimate is a focused
multi-week project, dominated by async propagation, not by SQL translation.

## Part 8 — Production checks still required (exact commands)

Run these against the **live** server (they are all read-only unless stated):

```bash
# 1. Integrity of the LIVE database (safe online under WAL; or stop the app first)
sqlite3 subtitles.db "PRAGMA quick_check;"
# expect: ok   — if not ok, the copy process corrupted the file, not the app

# 2. Proper copy procedure for the next diagnostic export (while app is running)
sqlite3 subtitles.db ".backup '/path/to/backup/subtitles-$(date +%F).db'"
# or: sqlite3 subtitles.db "VACUUM INTO '/path/to/backup/subtitles-$(date +%F).db'"

# 3. Confirm the new indexes arrived on next app start, then re-check plans
sqlite3 subtitles.db "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%';"
sqlite3 subtitles.db "EXPLAIN QUERY PLAN DELETE FROM log WHERE createdAt < datetime('now','-30 days');"

# 4. First app start after this change: watch the one-time index build
#    (minutes on millions of candidate rows; writes pause while it runs)
npm run build && npm start
# then: npm run db:diagnose

# 5. Measure the reclaim (app stopped is cleanest; bounded batches are
#    safe to run while it's up, but expect interleaved progress)
npm run db:maintenance -- --dry-run     # preview counts
npm run db:maintenance                  # batched cleanup + checkpoint + optimize
# re-run db:diagnose afterwards; expected reclaim: ~10–13 GB of the 14.4 GB

# 6. Watch the judge after a few days of runtime
sqlite3 subtitles.db "SELECT message, COUNT(*) c FROM log WHERE message LIKE '%invalid JSON%' AND createdAt > datetime('now','-7 days');"
sqlite3 subtitles.db "SELECT message, COUNT(*) c FROM log WHERE message LIKE '%rejected all candidates%' AND createdAt > datetime('now','-7 days');"
sqlite3 subtitles.db "SELECT message, COUNT(*) c FROM log WHERE message LIKE '%Fallback:%' AND createdAt > datetime('now','-7 days');"

# 7. Watch for lock regressions after the fixes
sqlite3 subtitles.db "SELECT COUNT(*) FROM log WHERE message LIKE '%database is locked%' AND createdAt > datetime('now','-7 days');"

# 8. Watch the dashboard instrumentation
#    server console lines of the form: [dashboard] slow poll: Xms, payload YKB

# 9. Live WAL size under load (translate while checking)
ls -la subtitles.db-wal   # should stay bounded; TRUNCATE checkpoint at each maintenance
```

Optional retention tuning (defaults: candidates 14 d, judge evaluations 30 d):

```bash
npm run db:maintenance -- --candidate-days 7 --judge-days 14
```