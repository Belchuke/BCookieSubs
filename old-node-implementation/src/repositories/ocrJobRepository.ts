// Background OCR queue — see src/setup.ts: libraryPathOcrJob.
//
// When an image-based subtitle track (PGS/VobSub) is queued for translation
// from the Library Requests page, the work is enqueued here instead of run
// synchronously behind a blocking HTTP request. The dedicated OCR worker
// (src/tasks/ocrWorker.ts) picks the next 'queued' row, runs the
// extract+OCR+createSubtitleTask pipeline (via prepareTranslationForItem), and
// on success DELETES the row (removes itself from the queue); on failure the row
// stays as 'failed' for retry.
//
// Mirrors the whisper-queue functions in subtitleRepository.ts.
import type Database from "better-sqlite3"
import type { TranslateSourceOverride } from "../services/libraryPathService"

export type DBOcrJob = {
  id: number
  libraryPathItemId: number
  userId: number
  name: string | null
  sourceOverrideJson: string
  sourceLanguageHint: string | null
  resetStatus: number
  status: "queued" | "processing" | "failed"
  progress: number
  errorMessage: string | null
  orderNumber: number
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export type OcrJobDashboardRow = {
  id: number
  libraryPathItemId: number
  name: string | null
  status: "queued" | "processing" | "failed"
  progress: number
  errorMessage: string | null
  orderNumber: number
  createdAt: string
  startedAt: string | null
  // mediaItem enrichment (nullable when the item has no matched mediaItem)
  mediaItemId: number | null
  mediaItemTitle: string | null
  mediaItemPhotoPath: string | null
  mediaItemType: string | null
  season: number | null
  episode: number | null
}

// Append a new OCR job at the end of the queue. Returns the inserted id.
export function enqueueOcrJob(
  db: Database.Database,
  input: {
    libraryPathItemId: number
    userId: number
    name: string | null
    // null = use the item's default subtitle source (season-batch flow, where no
    // specific track was picked). The worker passes it straight through to
    // prepareTranslationForItem.
    sourceOverride: TranslateSourceOverride | null
    sourceLanguageHint: string | null
    resetStatus: boolean
  },
): number {
  const orderRow = db
    .prepare("SELECT COALESCE(MAX(orderNumber), 0) + 1 AS nextOrd FROM libraryPathOcrJob")
    .get() as { nextOrd: number }
  const info = db
    .prepare(
      `INSERT INTO libraryPathOcrJob
         (libraryPathItemId, userId, name, sourceOverrideJson, sourceLanguageHint, resetStatus, status, orderNumber)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(
      input.libraryPathItemId,
      input.userId,
      input.name,
      JSON.stringify(input.sourceOverride),
      input.sourceLanguageHint,
      input.resetStatus ? 1 : 0,
      orderRow.nextOrd,
    )
  return Number(info.lastInsertRowid)
}

// Pick the next 'queued' OCR job (lowest orderNumber, then id). Returns null when
// the queue is empty. The worker claims it via markOcrJobProcessing.
export function getNextOcrJob(db: Database.Database): DBOcrJob | null {
  const row = db
    .prepare(`SELECT * FROM libraryPathOcrJob WHERE status = 'queued' ORDER BY orderNumber ASC, id ASC LIMIT 1`)
    .get() as DBOcrJob | undefined
  return row ?? null
}

export function markOcrJobProcessing(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE libraryPathOcrJob SET status = 'processing', progress = 0, startedAt = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(id)
}

export function setOcrJobProgress(db: Database.Database, id: number, progress: number): void {
  db.prepare(`UPDATE libraryPathOcrJob SET progress = ? WHERE id = ? AND status = 'processing'`).run(
    Math.max(0, Math.min(100, Math.round(progress))),
    id,
  )
}

// On success: delete the row so it removes itself from the queue.
export function completeOcrJob(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM libraryPathOcrJob WHERE id = ?`).run(id)
}

// On failure: keep the row as 'failed' with the error so it can be retried.
export function markOcrJobFailed(db: Database.Database, id: number, errorMessage: string): void {
  db.prepare(
    `UPDATE libraryPathOcrJob SET status = 'failed', errorMessage = ?, progress = 0, finishedAt = CURRENT_TIMESTAMP WHERE id = ?`,
  ).run(String(errorMessage).slice(0, 500), id)
}

// List all OCR jobs still visible on the dashboard (queued + processing + failed),
// enriched with the matched mediaItem for title/poster/season/episode.
export function getOcrJobsForDashboard(db: Database.Database): OcrJobDashboardRow[] {
  return db
    .prepare(
      `SELECT j.id, j.libraryPathItemId, j.name, j.status, j.progress, j.errorMessage, j.orderNumber,
              j.createdAt, j.startedAt,
              i.mediaItemId, m.title AS mediaItemTitle, m.mediaItemPhotoPath, m.type AS mediaItemType,
              i.season, i.episode
       FROM libraryPathOcrJob j
       LEFT JOIN libraryPathItem i ON i.id = j.libraryPathItemId
       LEFT JOIN mediaItem m ON m.id = i.mediaItemId
       WHERE j.status IN ('queued', 'processing', 'failed')
       ORDER BY j.status = 'processing' DESC, j.orderNumber ASC, j.id ASC`,
    )
    .all() as OcrJobDashboardRow[]
}

// Swap an OCR job's orderNumber with its neighbor. Only 'queued' jobs are
// movable — a 'processing' job is mid-OCR and shouldn't jump the queue.
export function moveOcrJob(
  db: Database.Database,
  id: number,
  direction: "up" | "down",
): void {
  const jobs = db
    .prepare(`SELECT id, orderNumber FROM libraryPathOcrJob WHERE status = 'queued' ORDER BY orderNumber ASC, id ASC`)
    .all() as { id: number; orderNumber: number }[]
  const idx = jobs.findIndex((j) => j.id === id)
  if (idx === -1) return
  const swapIdx = direction === "up" ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= jobs.length) return
  const a = jobs[idx]
  const b = jobs[swapIdx]
  const upd = db.prepare(`UPDATE libraryPathOcrJob SET orderNumber = ? WHERE id = ?`)
  const run = db.transaction(() => {
    upd.run(b.orderNumber, a.id)
    upd.run(a.orderNumber, b.id)
  })
  run()
}

export function reorderOcrJobs(db: Database.Database, orderedIds: number[]): void {
  const stmt = db.prepare(`UPDATE libraryPathOcrJob SET orderNumber = ? WHERE id = ?`)
  const run = db.transaction(() => orderedIds.forEach((id, idx) => stmt.run((idx + 1) * 10, id)))
  run()
}

export function deleteOcrJob(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM libraryPathOcrJob WHERE id = ?`).run(id)
}

// Reset a failed OCR job back to 'queued' so the worker retries it.
export function retryOcrJob(db: Database.Database, id: number): void {
  db.prepare(
    `UPDATE libraryPathOcrJob SET status = 'queued', errorMessage = NULL, progress = 0, finishedAt = NULL WHERE id = ? AND status = 'failed'`,
  ).run(id)
}