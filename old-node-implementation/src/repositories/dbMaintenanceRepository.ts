// Database maintenance operations (see DATABASE_ASSESSMENT.md).
//
// The production DB grows unbounded because three write-only data classes are
// never cleaned: non-selected candidate translations (dominant share of the
// ~6.4 GB unaccounted mass), full prompt snapshots inside those rows, and
// judge evaluations (673 MB of judgeInput). chunkTextRaw adds another 6.6 GB
// of write-only dead weight. None of these are read anywhere in the app; the
// only consumer of candidates is the judge during selection, and the winner
// is flagged selected=1 and kept.
//
// Every function here batches by primary key so no single statement holds the
// write lock for minutes on a 14 GB database, and checkpoints the WAL between
// batches so it does not grow past what a PASSIVE checkpoint can give back.
// They are wired into `npm run db:maintenance` (scripts/db-maintenance.js) and
// never run automatically — cleanup and VACUUM require an explicit command.

import Database from "better-sqlite3"

export type MaintenanceReport = {
  candidatesDeleted: number
  chunksCleared: number
  judgeEvaluationsDeleted: number
  orphanCandidatesDeleted: number
  sessionsDeleted: number
  batches: number
}

const defaultReport: MaintenanceReport = {
  candidatesDeleted: 0,
  chunksCleared: 0,
  judgeEvaluationsDeleted: 0,
  orphanCandidatesDeleted: 0,
  sessionsDeleted: 0,
  batches: 0,
}

// Delete non-selected, terminal candidates older than the cutoff. The selected
// winner (selected=1) and recent rows (still useful for the judge / diagnostics
// within the retention window) are kept. Failed candidates are kept too — they
// carry errorMessage diagnostics, not dead translation text.
export const cleanupExpiredCandidates = (
  db: Database.Database,
  opts: { olderThanDays?: number; batchSize?: number } = {},
): number => {
  const olderThanDays = opts.olderThanDays ?? 14
  const batchSize = opts.batchSize ?? 5000
  let deleted = 0
  let lastId = 0
  for (;;) {
    const ids = db
      .prepare(
        `SELECT id FROM subtitleChunkCandidate
         WHERE selected = 0
           AND status = 'completed'
           AND updatedAt < datetime('now', ?)
         ORDER BY id LIMIT ?`,
      )
      .all(`-${olderThanDays} days`, batchSize) as { id: number }[]
    if (ids.length === 0) break
    db.prepare(`DELETE FROM subtitleChunkCandidate WHERE id IN (${ids.map(() => "?").join(",")})`)
      .run(...ids.map((r) => r.id))
    deleted += ids.length
    lastId = ids[ids.length - 1].id
    db.pragma("wal_checkpoint(PASSIVE)")
  }
  return deleted
}

// Zero out chunkTextRaw in place (the column is NOT NULL, schema untouched).
// Batches by chunk id and checkpoints between batches.
export const clearChunkTextRawContent = (
  db: Database.Database,
  opts: { batchSize?: number } = {},
): number => {
  const batchSize = opts.batchSize ?? 20000
  let cleared = 0
  let lastId = 0
  for (;;) {
    const ids = db
      .prepare(
        `SELECT id FROM subtitleChunk
         WHERE LENGTH(chunkTextRaw) > 0 AND id > ? ORDER BY id LIMIT ?`,
      )
      .all(lastId, batchSize) as { id: number }[]
    if (ids.length === 0) break
    db.prepare(`UPDATE subtitleChunk SET chunkTextRaw = '' WHERE id IN (${ids.map(() => "?").join(",")})`)
      .run(...ids.map((r) => r.id))
    cleared += ids.length
    lastId = ids[ids.length - 1].id
    db.pragma("wal_checkpoint(PASSIVE)")
  }
  return cleared
}

// Delete judge evaluations older than the cutoff. judgeInput (673 MB) and
// judgeReason (54 MB) are the columns that matter; retention is age-based
// because getJudgeEvaluations (prompt stats page) reads only recent history.
export const cleanupJudgeEvaluations = (
  db: Database.Database,
  opts: { olderThanDays?: number; batchSize?: number } = {},
): number => {
  const olderThanDays = opts.olderThanDays ?? 30
  const batchSize = opts.batchSize ?? 5000
  let deleted = 0
  let lastId = 0
  for (;;) {
    const ids = db
      .prepare(
        `SELECT id FROM judgeEvaluation
         WHERE createdAt < datetime('now', ?)
         ORDER BY id LIMIT ?`,
      )
      .all(`-${olderThanDays} days`, batchSize) as { id: number }[]
    if (ids.length === 0) break
    db.prepare(`DELETE FROM judgeEvaluation WHERE id IN (${ids.map(() => "?").join(",")})`)
      .run(...ids.map((r) => r.id))
    deleted += ids.length
    lastId = ids[ids.length - 1].id
    db.pragma("wal_checkpoint(PASSIVE)")
  }
  return deleted
}

// Delete candidates whose chunk row is gone (chunks are deleted with their
// job — soft-deleted jobs keep their chunks, so orphans here are rare; kept
// for correctness after manual deletes/maintenance).
export const deleteOrphanCandidates = (db: Database.Database): number => {
  const result = db
    .prepare(
      `DELETE FROM subtitleChunkCandidate WHERE NOT EXISTS
       (SELECT 1 FROM subtitleChunk sc WHERE sc.id = subtitleChunkCandidate.subtitleChunkId)`,
    )
    .run()
  return result.changes
}

// Expired sessions are already treated as invalid by the auth middleware;
// this just reclaims the rows.
export const cleanupExpiredSessions = (db: Database.Database): number => {
  const result = db
    .prepare(`DELETE FROM userSession WHERE expiresAt < ?`)
    .run(new Date().toISOString())
  return result.changes
}

// Run all maintenance in dependency order. `vacuum` and `checkpoint` are
// exposed for the script; VACUUM rewrites the database file (needs free disk
// space equal to DB size and exclusive access) and is only ever triggered by
// `npm run db:maintenance -- --vacuum --yes`.
export const runDbMaintenance = (
  db: Database.Database,
  opts: { candidateDays?: number; judgeDays?: number; vacuum?: boolean } = {},
): MaintenanceReport => {
  const report = { ...defaultReport }

  report.candidatesDeleted = cleanupExpiredCandidates(db, { olderThanDays: opts.candidateDays })
  report.judgeEvaluationsDeleted = cleanupJudgeEvaluations(db, { olderThanDays: opts.judgeDays })
  report.chunksCleared = clearChunkTextRawContent(db)
  report.orphanCandidatesDeleted = deleteOrphanCandidates(db)
  report.sessionsDeleted = cleanupExpiredSessions(db)
  report.batches = Math.ceil(report.candidatesDeleted / 5000) + Math.ceil(report.chunksCleared / 20000) + Math.ceil(report.judgeEvaluationsDeleted / 5000)
  db.pragma("wal_checkpoint(TRUNCATE)")
  db.pragma("optimize")
  if (opts.vacuum) {
    db.exec("VACUUM")
  }
  return report
}