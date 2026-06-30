// Dedicated OCR worker loop. Picks the next 'queued' libraryPathOcrJob, runs
// the extract+OCR+createSubtitleTask pipeline (prepareTranslationForItem) and on
// success DELETES the row (removes it from the queue); on failure marks it
// 'failed' for retry. Mirrors whisperTask.ts — own pause/resume state,
// independent of the translation worker, schedule-aware so OCR only runs inside
// the configured worker window.
import { parentPort } from "worker_threads"
import Database from "better-sqlite3"
import { createLog } from "../repositories/logRepository"
import { getShouldRunNowBySchedule } from "../repositories/scheduleRepository"
import { sleep } from "../repositories/shared"
import { IDLE_INTERVAL_MS, TASK_INTERVAL_MS } from "../constants/timer"
import {
  completeOcrJob,
  getNextOcrJob,
  markOcrJobFailed,
  markOcrJobProcessing,
} from "../repositories/ocrJobRepository"
import { prepareTranslationForItem, type TranslateSourceOverride } from "../services/libraryPathService"

let taskRunning = false
let currentScheduleId: number | null = null
let workerPaused = false

// Push paused-state changes to the main thread so the control bridge mirrors
// `workerPaused` without polling. No-op when not running inside a Worker.
function notifyPausedState(paused: boolean): void {
  if (parentPort) parentPort.postMessage({ type: "state", paused })
}

// OCR is not abortable mid-Tesseract, so there is no in-flight run to kill here
// (unlike whisper's preempt). Kept for bridge symmetry / future abort support.
export function cleanupRunningChunks(_db: Database.Database): void {
  /* no-op */
}

export function pauseWorker(db: Database.Database, actingUsername: string | null = null): void {
  workerPaused = true
  const who = actingUsername ?? "unknown user"
  createLog(db, "info", "workerState", "worker", null, `OCR worker paused by user: ${who}`, { username: actingUsername })
  console.log(`[ocr-worker] Worker paused by user: ${who}`)
  notifyPausedState(true)
}

export function resumeWorker(db?: Database.Database, actingUsername: string | null = null): void {
  workerPaused = false
  const who = actingUsername ?? "unknown user"
  if (db) {
    createLog(db, "info", "workerState", "worker", null, `OCR worker resumed by user: ${who}`, { username: actingUsername })
  }
  console.log(`[ocr-worker] Worker resumed by user: ${who}`)
  notifyPausedState(false)
}

export function isWorkerPaused(): boolean {
  return workerPaused
}

export async function ocrTaskMain(db: Database.Database): Promise<void> {
  createLog(db, "info", "workerState", "worker", null, "OCR worker started", {})
  console.log("[ocr-worker] OCR worker started")

  while (true) {
    try {
      await runOnce(db)
    } catch (err) {
      createLog(db, "error", "workerState", "worker", null, `OCR worker loop crashed: ${summarizeError(err)}`, {
        error: String(err),
      })
      console.error("[ocr-worker] Unexpected error:", err)
    }
    await sleep(TASK_INTERVAL_MS)
  }
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200)
  return String(err).slice(0, 200)
}

async function runOnce(db: Database.Database): Promise<void> {
  if (workerPaused) return

  const scheduleResult = getShouldRunNowBySchedule(db, currentScheduleId)
  currentScheduleId = scheduleResult.scheduleId

  if (!scheduleResult.shouldRun) {
    if (taskRunning) {
      taskRunning = false
      createLog(db, "info", "workerState", "worker", null, "OCR worker paused automatically: outside configured schedule window", {
        scheduleId: scheduleResult.scheduleId,
      })
      console.log("[ocr-worker] Paused — outside schedule window")
      notifyPausedState(true)
    }
    await sleep(IDLE_INTERVAL_MS - TASK_INTERVAL_MS)
    return
  }

  if (!taskRunning) {
    taskRunning = true
    createLog(db, "info", "workerState", "worker", null, "OCR worker resumed: inside configured schedule window", {
      scheduleId: scheduleResult.scheduleId,
      scheduleActive: scheduleResult.scheduleActive,
    })
    console.log("[ocr-worker] Active")
    notifyPausedState(false)
  }

  const job = getNextOcrJob(db)
  if (!job) return

  markOcrJobProcessing(db, job.id)
  let sourceOverride: TranslateSourceOverride
  try {
    sourceOverride = JSON.parse(job.sourceOverrideJson) as TranslateSourceOverride
  } catch {
    markOcrJobFailed(db, job.id, "Could not parse stored source override")
    return
  }

  try {
    const result = await prepareTranslationForItem(
      db,
      job.libraryPathItemId,
      !!job.resetStatus,
      job.userId,
      sourceOverride,
      job.sourceLanguageHint,
    )
    if (result.success) {
      completeOcrJob(db, job.id)
      createLog(db, "info", "libraryScanner", "libraryPathItem", job.libraryPathItemId, `OCR job ${job.id} completed; translation jobs created`, {
        ocrJobId: job.id,
      })
    } else {
      markOcrJobFailed(db, job.id, result.msg)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    markOcrJobFailed(db, job.id, msg)
    console.error(`[ocr-worker] OCR job ${job.id} failed:`, msg)
  }
}