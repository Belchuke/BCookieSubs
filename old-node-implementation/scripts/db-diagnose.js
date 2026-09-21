#!/usr/bin/env node
// Read-only database diagnostics for BCookieSubs (npm run db:diagnose).
//
// Prints integrity, pragma configuration, per-table row counts and on-disk
// text sizes, index inventory, orphan/retention checks and query plans.
// Opens the database READONLY so it is always safe to run against production
// data. Findings and the reasoning behind them live in DATABASE_ASSESSMENT.md.

const fs = require("fs")
const path = require("path")
const Database = require("better-sqlite3")

// Same resolution as src/setup.ts: DBPATH env or ./subtitles.db
const DB = process.env.DBPATH || "subtitles.db"

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

function tryRun(label, fn) {
  try {
    return fn()
  } catch (e) {
    console.log(`${label}: ERROR ${String(e.message).slice(0, 160)}`)
    return null
  }
}

const db = new Database(DB, { readonly: true })

// --- integrity -------------------------------------------------------------
section("Integrity")
tryRun("quick_check", () => {
  const rows = db.pragma("quick_check")
  const problems = rows.map((r) => Object.values(r)[0])
  if (problems.length === 1 && problems[0] === "ok") {
    console.log("quick_check: ok")
  } else {
    for (const p of problems.slice(0, 20)) console.log(`  problem: ${p}`)
    console.log(`  total problems: ${problems.length}`)
  }
})

// --- file sizes / pragmas --------------------------------------------------
section("File sizes")
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    const st = fs.statSync(DB + suffix)
    console.log(`${path.basename(DB + suffix)}: ${fmtBytes(st.size)}`)
  } catch {
    /* sidecar may not exist */
  }
}

section("Pragmas")
for (const p of [
  "page_size",
  "page_count",
  "freelist_count",
  "auto_vacuum",
  "journal_mode",
  "synchronous",
  "busy_timeout",
  "cache_size",
  "user_version",
]) {
  tryRun(p, () => console.log(`${p} = ${db.pragma(p, { simple: true })}`))
}
tryRun("wal_checkpoint stats", () => {
  const r = db.pragma("wal_checkpoint(PASSIVE)")
  console.log(`wal_checkpoint(PASSIVE): ${JSON.stringify(r)}`)
})

// --- table inventory -------------------------------------------------------
section("Tables, row counts, text size estimates")
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
  .all()
  .map((r) => r.name)
for (const t of tables) {
  tryRun(`count(${t})`, () => {
    const n = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
    if (n === 0) {
      console.log(`${t}: 0 rows`)
      return
    }
    // LENGTH sums over the largest text columns — cheap enough for a report,
    // far cheaper than dbstat on big tables.
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
    const textCols = cols.filter((c) => /TEXT|BLOB/i.test(c.type)).slice(0, 4)
    let sizeNote = ""
    for (const c of textCols) {
      const sum = db.prepare(`SELECT SUM(LENGTH("${c.name}")) s FROM "${t}"`).get().s
      if (sum > 1024 * 1024) sizeNote += ` ${c.name}=${fmtBytes(sum)}`
    }
    console.log(`${t}: ${n.toLocaleString()} rows${sizeNote ? " |" + sizeNote : ""}`)
  })
}

// --- indexes ---------------------------------------------------------------
section("Indexes")
tryRun("index list", () => {
  const idx = db
    .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`)
    .all()
  for (const i of idx) console.log(`${i.tbl_name} → ${i.name}`)
  const missing = []
  const wanted = [
    "idx_log_createdAt",
    "idx_subtitleChunk_status",
    "idx_subtitleChunkCandidate_chunkId",
  ]
  const names = new Set(idx.map((i) => i.name))
  for (const w of wanted) if (!names.has(w)) missing.push(w)
  if (missing.length > 0) {
    console.log(`MISSING (created on next app start via index migrations): ${missing.join(", ")}`)
  }
})

// --- query plans -----------------------------------------------------------
section("Query plans (EXPLAIN QUERY PLAN)")
const plans = [
  ["dashboard chunk counts", `SELECT subtitleJobId, COUNT(*) FROM subtitleChunk GROUP BY subtitleJobId`],
  ["finished page", `SELECT sj.id FROM subtitleJob sj WHERE sj.status IN ('completed','failed') AND sj.deletedAt IS NULL ORDER BY COALESCE(sj.finishedAt, sj.updatedAt) DESC LIMIT 20`],
  ["log retention delete", `SELECT id FROM log WHERE createdAt < datetime('now', '-30 days') ORDER BY id LIMIT 10`],
  ["chunk claim", `SELECT id FROM subtitleChunk WHERE status = 'queued' ORDER BY id LIMIT 10`],
]
for (const [name, sql] of plans) {
  tryRun(`plan: ${name}`, () => {
    for (const row of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()) {
      console.log(`${name}: ${Object.values(row).join(" | ")}`)
    }
  })
}

// --- cleanup opportunities -------------------------------------------------
section("Cleanup opportunities (measured, read-only)")
tryRun("write-only candidates", () => {
  const total = db.prepare(`SELECT COUNT(*) c FROM subtitleChunkCandidate`).get().c
  const selected = db.prepare(`SELECT COUNT(*) c FROM subtitleChunkCandidate WHERE selected = 1`).get().c
  console.log(`subtitleChunkCandidate rows: ${total.toLocaleString()} (selected winners: ${selected.toLocaleString()})`)
  const old = db
    .prepare(`SELECT COUNT(*) c FROM subtitleChunkCandidate WHERE selected = 0 AND status = 'completed' AND updatedAt < datetime('now', '-14 days')`)
    .get().c
  console.log(`  deletable now (non-selected completed, older than 14d): ${old.toLocaleString()}`)
})
tryRun("judge evaluations", () => {
  const n = db.prepare(`SELECT COUNT(*) c FROM judgeEvaluation`).get().c
  const old = db.prepare(`SELECT COUNT(*) c FROM judgeEvaluation WHERE createdAt < datetime('now', '-30 days')`).get().c
  console.log(`judgeEvaluation rows: ${n.toLocaleString()} (older than 30d: ${old.toLocaleString()})`)
})
tryRun("chunkTextRaw mass", () => {
  const sum = db.prepare(`SELECT SUM(LENGTH(chunkTextRaw)) s FROM subtitleChunk`).get().s
  console.log(`chunkTextRaw total: ${fmtBytes(sum)} (write-only; clearable in place via db:maintenance)`)
})
tryRun("log table", () => {
  const n = db.prepare(`SELECT COUNT(*) c FROM log`).get().c
  const oldest = db.prepare(`SELECT MIN(createdAt) m FROM log`).get().m
  const newest = db.prepare(`SELECT MAX(createdAt) m FROM log`).get().m
  console.log(`log rows: ${n.toLocaleString()} spanning ${oldest} .. ${newest}`)
})
tryRun("expired sessions", () => {
  const n = db.prepare(`SELECT COUNT(*) c FROM userSession WHERE expiresAt < ?`).get(new Date().toISOString()).c
  console.log(`expired userSession rows: ${n}`)
})

db.close()
console.log("\nDone (read-only — nothing was modified).")