// Main-thread control bridge for the dedicated library-scanner worker. Mirrors
// the whisper/translate bridges in shape but is far simpler: rescan is
// fire-and-forget — no reply, no pending Map, no timeout. The route just needs
// to nudge the worker to (a) wake its interruptible tick immediately and
// (b) abort an in-flight scan of the same path and restart it.
//
// Singleton: instantiate via getLibraryWorkerBridge(). index.ts calls
// setWorker(worker) once after spawning the worker (and again on respawn).
import { Worker } from "worker_threads"

class LibraryWorkerBridge {
  private worker: Worker | null = null

  setWorker(worker: Worker): void {
    this.worker = worker
  }

  /** Fire-and-forget: tell the worker to rescan library path `id` now. */
  requestRescan(id: number): void {
    if (!this.worker) return // worker not spawned yet / respawning — DB flip still makes it due next tick
    this.worker.postMessage({ type: "rescan", id })
  }
}

let _bridge: LibraryWorkerBridge | null = null

export function getLibraryWorkerBridge(): LibraryWorkerBridge {
  if (!_bridge) _bridge = new LibraryWorkerBridge()
  return _bridge
}