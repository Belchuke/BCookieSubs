// Whisper-worker entry point — runs inside a worker_threads Worker so Whisper
// transcription (ffmpeg + whisper-cli + synchronous better-sqlite3 progress
// writes) runs in parallel with the translation worker, not on the main
// Express event loop and not blocking translation.
//
// The worker opens its own DB connection via getDb() (WAL mode allows the main
// process, the translation worker, and this worker to read/write the same file
// concurrently). Control messages (pause/resume/cleanup/queryPaused/shutdown)
// arrive on parentPort and dispatch to the control functions in whisperTask.ts.
import { parentPort } from "worker_threads"
import { getDb } from "../setup"
import { whisperTaskMain, cleanupRunningChunks, pauseWorker, resumeWorker, isWorkerPaused, preemptWhisper } from "./whisperTask"

const db = getDb()

function reply(id: string | null, result: unknown, ok = true): void {
  if (id && parentPort) parentPort.postMessage({ id, ok, result })
}

// Fire-and-forget: whisperTaskMain is an infinite loop with its own per-iteration
// try/catch; this catch only fires if whisperTaskMain itself rejects (safety net).
whisperTaskMain(db).catch((err) => {
  if (parentPort) parentPort.postMessage({ type: "fatal", error: String(err) })
})

parentPort?.on("message", (m: { id?: string; type: string; actingUsername?: string | null }) => {
  try {
    switch (m.type) {
      case "shutdown":
        db.close()
        process.exit(0)
        break
      case "pause":
        pauseWorker(db, m.actingUsername ?? null)
        reply(m.id ?? null, { paused: true })
        break
      case "resume":
        resumeWorker(db, m.actingUsername ?? null)
        reply(m.id ?? null, { paused: false })
        break
      case "cleanup":
        cleanupRunningChunks(db)
        reply(m.id ?? null, {})
        break
      case "preempt":
        reply(m.id ?? null, preemptWhisper(db))
        break
      case "queryPaused":
        reply(m.id ?? null, { paused: isWorkerPaused() })
        break
      default:
        reply(m.id ?? null, { error: `Unknown message type: ${m.type}` }, false)
    }
  } catch (e) {
    reply(m.id ?? null, { error: e instanceof Error ? e.message : String(e) }, false)
  }
})