#!/usr/bin/env node
// Database maintenance for BCookieSubs (npm run db:maintenance).
//
// Default run: batched cleanup of write-only data the app never reads
// (non-selected candidate translations, prompt snapshots, judge
// evaluations, chunkTextRaw, expired sessions, orphan candidates), then a WAL
// truncate checkpoint and PRAGMA optimize. Batches are id-bounded so no single
// statement holds the write lock for minutes; PASSIVE checkpoints between
// batches keep the WAL bounded.
//
// VACUUM is NEVER automatic: it rewrites the database file, needs free disk
// space equal to the database size, and requires the app (main + workers)
// stopped. It only runs with `npm run db:maintenance -- --vacuum --yes`.

const fs = require("fs")
const Database = require("better-sqlite3")

const DB = process.env.DBPATH || "subtitles.db"
const args = process.argv.slice(2)
const wantVacuum = args.includes("--vacuum")
const confirmed = args.includes("--yes")
const dryRun = args.includes("--dry-run")
function optArg(name) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}
const candidateDays = Number(optArg("--candidate-days")) || 14
const judgeDays = Number(optArg("--judge-days")) || 30

function fmtBytes(n) {
  if (n === null || n === undefined) return "?"
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB"
  if (n >= 1024 * 1024) return (n / 1024 ** 2).toFixed(1) + " MB"
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB"
  return `${n} B`
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return null
  }
}

const db = new Database(DB, { readonly: dryRun })

// PRAGMAs mirror getDb() so maintenance writes the way the app writes
// (WAL + NORMAL sync, 10s busy timeout). Wrapped: --dry-run opens readonly,
// where the journal_mode switch is not permitted.
try {
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 10000")
} catch {
  /* dry-run: connection is readonly */
}

section("Before")
const beforeMain = fileSize(DB)
const beforeWal = fileSize(DB + "-wal")
console.log(`main: ${fmtBytes(beforeMain)}  wal: ${fmtBytes(beforeWal)}`)

function countWhere(table, cond) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${cond}`).get().c
}

if (dryRun) {
  section("Dry run (no writes)")
  // Guarded so the report completes even on a partially unreadable database
  // (e.g. a torn file copy — see DATABASE_ASSESSMENT.md).
  const showCount = (label, table, cond) => {
    try {
      console.log(`${label}: ${countWhere(table, cond).toLocaleString()}`)
    } catch (e) {
      console.log(`${label}: ERROR ${String(e.message).slice(0, 120)}`)
    }
  }
  showCount(
    "candidates deletable",
    "subtitleChunkCandidate",
    `selected = 0 AND status = 'completed' AND updatedAt < datetime('now', '-${candidateDays} days')`,
  )
  showCount("judge evaluations deletable", "judgeEvaluation", `createdAt < datetime('now', '-${judgeDays} days')`)
  showCount("chunks with chunkTextRaw content", "subtitleChunk", "LENGTH(chunkTextRaw) > 0")
  showCount(
    "orphan candidates",
    "subtitleChunkCandidate",
    "NOT EXISTS (SELECT 1 FROM subtitleChunk sc WHERE sc.id = subtitleChunkCandidate.subtitleChunkId)",
  )
  db.close()
  console.log("\nDry run complete — nothing was modified.")
  process.exit(0)
}

section("Running cleanup")
let batches = 0

// Batched helper: select ids in id-ascending windows, apply a per-batch SQL
// statement, checkpoint the WAL between batches.
function batchLoop(label, selectSql, apply) {
  let total = 0
  let lastId = 0
  for (;;) {
    const ids = db.prepare(selectSql(lastId)).all()
    if (ids.length === 0) break
    apply(ids)
    db.pragma("wal_checkpoint(PASSIVE)")
    total += ids.length
    lastId = ids[ids.length - 1].id
    batches++
    if (batches % 10 === 0) console.log(`  ${label}: ${total.toLocaleString()} so far`)
  }
  console.log(`${label}: ${total.toLocaleString()} total`)
  return total
}

const candidatesDeleted = batchLoop(
  "non-selected candidates",
  (lastId) =>
    `SELECT id FROM subtitleChunkCandidate
     WHERE selected = 0 AND status = 'completed'
       AND updatedAt < datetime('now', '-${candidateDays} days') AND id > ${lastId}
     ORDER BY id LIMIT 5000`,
  (ids) => {
    const ph = ids.map(() => "?").join(",")
    db.prepare(`DELETE FROM subtitleChunkCandidate WHERE id IN (${ph})`).run(...ids)
  },
)

const judgeDeleted = batchLoop(
  "judge evaluations",
  (lastId) =>
    `SELECT id FROM judgeEvaluation
     WHERE createdAt < datetime('now', '-${judgeDays} days') AND id > ${lastId}
     ORDER BY id LIMIT 5000`,
  (ids) => {
    const ph = ids.map(() => "?").join(",")
    db.prepare(`DELETE FROM judgeEvaluation WHERE id IN (${ph})`).run(...ids)
  },
)

const chunksCleared = batchLoop(
  "chunkTextRaw cleared",
  (lastId) =>
    `SELECT id FROM subtitleChunk
     WHERE LENGTH(chunkTextRaw) > 0 AND id > ${lastId}
     ORDER BY id LIMIT 20000`,
  (ids) => {
    const ph = ids.map(() => "?").join(",")
    db.prepare(`UPDATE subtitleChunk SET chunkTextRaw = '' WHERE id IN (${ph})`).run(...ids)
  },
)

const orphansDeleted = db
  .prepare(
    `DELETE FROM subtitleChunkCandidate WHERE NOT EXISTS
     (SELECT 1 FROM subtitleChunk sc WHERE sc.id = subtitleChunkCandidate.subtitleChunkId)`,
  )
  .run().changes

const sessionsDeleted = db.prepare(`DELETE FROM userSession WHERE expiresAt < ?`).run(new Date().toISOString()).changes

section("Result")
console.log(`non-selected candidates deleted: ${candidatesDeleted.toLocaleString()}`)
console.log(`judge evaluations deleted: ${judgeDeleted.toLocaleString()}`)
console.log(`chunks cleared of chunkTextRaw: ${chunksCleared.toLocaleString()}`)
console.log(`orphan candidates deleted: ${orphansDeleted.toLocaleString()}`)
console.log(`expired sessions deleted: ${sessionsDeleted.toLocaleString()}`)
console.log(`batches: ${batches}`)

section("Checkpoint + optimize")
db.pragma("wal_checkpoint(TRUNCATE)")
db.pragma("optimize")

if (wantVacuum) {
  section("VACUUM")
  console.log("VACUUM rewrites the entire database file:")
  console.log("  - needs free disk space >= current DB size (14 GB+ in production)")
  console.log("  - needs the app (main + all worker threads) stopped — exclusive access")
  console.log("  - can take a long time on a database this size")
  console.log("  - only run it when disk stays high after cleanup, or SQLite recommends it")
  if (!confirmed) {
    console.log("\nRefusing to run VACUUM without --yes.")
    db.close()
    process.exit(1)
  }
  const t0 = Date.now()
  db.exec("VACUUM")
  console.log(`VACUUM done in ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`)
}

section("After")
const afterMain = fileSize(DB)
const afterWal = fileSize(DB + "-wal")
console.log(`main: ${fmtBytes(afterMain)}  wal: ${fmtBytes(afterWal)}`)
if (beforeMain && afterMain) {
  console.log(`main size change: ${(afterMain - beforeMain) / 1024 ** 3 >= 0 ? "+" : ""}${((afterMain - beforeMain) / 1024 ** 3).toFixed(2)} GB`)
}

db.close()
console.log("\nDone.")