// Translate-worker entry point — runs inside a worker_threads Worker so the
// translation loop (LLM requests + synchronous better-sqlite3 writes + whisper
// progress writes) does NOT block the main Express event loop.
//
// The worker opens its own DB connection via getDb() (WAL mode allows the main
// process and this worker to read/write the same file concurrently). Control
// messages (pause/resume/cleanup/queryPaused/shutdown) arrive on parentPort and
// are dispatched to the existing control functions in translateTask.ts, which
// own the module-level worker state. Replies use a request/id pattern.
import { parentPort } from "worker_threads"
import { getDb } from "../setup"
import {
  taskMain,
  cleanupRunningChunks,
  pauseWorker,
  resumeWorker,
  isWorkerPaused,
} from "./translateTask"

const db = getDb()

function reply(id: string | null, result: unknown, ok = true): void {
  if (id && parentPort) parentPort.postMessage({ id, ok, result })
}

// Fire-and-forget: taskMain is an infinite loop with its own per-iteration
// try/catch; this catch only fires if taskMain itself rejects (safety net).
taskMain(db).catch((err) => {
  if (parentPort) parentPort.postMessage({ type: "fatal", error: String(err) })
})

parentPort?.on("message", (m: { id?: string; type: string; actingUsername?: string | null }) => {
  try {
    switch (m.type) {
      case "shutdown":
        // Release any in-flight claimed chunks back to the queue so nothing is
        // stranded in "running" state, then exit.
        cleanupRunningChunks(db)
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