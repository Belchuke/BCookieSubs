// Dedicated Whisper worker loop. Runs only when `whisperRunAsSeparateTask` is
// enabled — otherwise it idles and the translation worker (translateTask.ts)
// owns whisper transcription. Both loops re-read the config every tick, so
// toggling the setting takes effect without a restart.
//
// Owns its own worker state (pause/resume) independent of the translation
// worker, so Whisper can be paused/resumed without affecting translation.
import { parentPort } from "worker_threads"
import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import { createLog } from "../repositories/logRepository"
import { getShouldRunNowBySchedule } from "../repositories/scheduleRepository"
import { sleep } from "../repositories/shared"
import { getNextWhisperSubtitleForTranscription } from "../repositories/subtitleRepository"
import { IDLE_INTERVAL_MS, TASK_INTERVAL_MS } from "../constants/timer"
import { transcribeSubtitleAndCreateJobs } from "./whisperProcessing"
import { createWhisperRunHandle, WhisperRunHandle } from "../services/whisperService"

let taskRunning = false
let currentScheduleId: number | null = null
let workerPaused = false

// The active transcription run (if any). Owned by runOnce for the duration of one
// transcribeSubtitleAndCreateJobs call so pause/preempt can kill the whisper-cli
// process immediately instead of waiting for it to finish.
let currentRunHandle: WhisperRunHandle | null = null
let currentSubtitleId: number | null = null

// Push paused-state changes to the main thread so the control bridge can
// mirror `workerPaused` without polling. No-op when not running inside a Worker.
function notifyPausedState(paused: boolean): void {
  if (parentPort) parentPort.postMessage({ type: "state", paused })
}

export function cleanupRunningChunks(_db: Database.Database): void {
  // Whisper claims no chunks; nothing to release. Kept for bridge symmetry.
}

// Kill the in-progress whisper-cli so Stop/preempt takes effect now. Returns
// false when nothing is running. The abort flows: runWhisperCli resolves
// aborted → transcribeMediaWithWhisper returns the aborted variant →
// transcribeSubtitleAndCreateJobs saves the checkpoint and returns.
function abortCurrentRun(_reason: "pause" | "preempt"): boolean {
  if (!currentRunHandle) return false
  currentRunHandle.abort()
  return true
}

export function pauseWorker(db: Database.Database, actingUsername: string | null = null): void {
  workerPaused = true
  const who = actingUsername ?? "unknown user"
  createLog(db, "info", "worker", null, `Whisper worker paused by user: ${who}`, { username: actingUsername })
  console.log(`[whisper-worker] Worker paused by user: ${who}`)
  // Actually stop the in-progress transcription: kill whisper-cli and save its
  // checkpoint so resume continues from the same second.
  abortCurrentRun("pause")
  notifyPausedState(true)
}

// "Change which one to whisper at the current time": if a different subtitle is
// now at the top of the whisper queue, kill the in-progress run (saving its
// checkpoint) so the loop picks up the new top on the next tick. workerPaused is
// untouched. Returns whether a switch will happen.
export function preemptWhisper(db: Database.Database): { willSwitch: boolean } {
  if (!currentSubtitleId) return { willSwitch: false }
  const next = getNextWhisperSubtitleForTranscription(db)
  if (!next || next.id === currentSubtitleId) return { willSwitch: false }
  createLog(db, "info", "worker", null, "Whisper worker preempted: switching to a higher-priority subtitle", {
    fromSubtitleId: currentSubtitleId,
    toSubtitleId: next.id,
  })
  abortCurrentRun("preempt")
  return { willSwitch: true }
}

export function resumeWorker(db?: Database.Database, actingUsername: string | null = null): void {
  workerPaused = false
  const who = actingUsername ?? "unknown user"
  if (db) {
    createLog(db, "info", "worker", null, `Whisper worker resumed by user: ${who}`, { username: actingUsername })
  }
  console.log(`[whisper-worker] Worker resumed by user: ${who}`)
  notifyPausedState(false)
}

export function isWorkerPaused(): boolean {
  return workerPaused
}

export async function whisperTaskMain(db: Database.Database): Promise<void> {
  createLog(db, "info", "worker", null, "Whisper worker started", {})
  console.log("[whisper-worker] Whisper worker started")

  while (true) {
    try {
      await runOnce(db)
    } catch (err) {
      createLog(db, "error", "worker", null, `Whisper worker loop crashed: ${summarizeError(err)}`, {
        error: String(err),
      })
      console.error("[whisper-worker] Unexpected error:", err)
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

  const config = getConfig(db)

  // Idle unless this worker owns whisper. The translation worker handles it
  // when the setting is off.
  if (config.whisperRunAsSeparateTask !== 1) {
    if (taskRunning) {
      taskRunning = false
      notifyPausedState(false)
    }
    await sleep(IDLE_INTERVAL_MS - TASK_INTERVAL_MS)
    return
  }

  const scheduleResult = getShouldRunNowBySchedule(db, currentScheduleId)
  currentScheduleId = scheduleResult.scheduleId

  if (!scheduleResult.shouldRun) {
    if (taskRunning) {
      taskRunning = false
      createLog(db, "info", "worker", null, "Whisper worker paused automatically: outside configured schedule window", {
        scheduleId: scheduleResult.scheduleId,
      })
      console.log("[whisper-worker] Paused — outside schedule window")
      notifyPausedState(true)
    }
    await sleep(IDLE_INTERVAL_MS - TASK_INTERVAL_MS)
    return
  }

  if (!taskRunning) {
    taskRunning = true
    createLog(db, "info", "worker", null, "Whisper worker resumed: inside configured schedule window", {
      scheduleId: scheduleResult.scheduleId,
      scheduleActive: scheduleResult.scheduleActive,
    })
    console.log("[whisper-worker] Active")
    notifyPausedState(false)
  }

  const whisperSubtitle = getNextWhisperSubtitleForTranscription(db)
  if (whisperSubtitle) {
    const handle = createWhisperRunHandle()
    currentRunHandle = handle
    currentSubtitleId = whisperSubtitle.id
    try {
      await transcribeSubtitleAndCreateJobs(db, whisperSubtitle, () => workerPaused, handle)
    } finally {
      currentRunHandle = null
      currentSubtitleId = null
    }
  }
}