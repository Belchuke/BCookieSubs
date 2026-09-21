// Main-thread control bridge for the translate worker.
//
// Replaces direct imports of pauseWorker/resumeWorker/isWorkerPaused/
// cleanupRunningChunks on the main thread. Routes control calls to the worker
// over postMessage (request/id pattern) and mirrors the worker's `paused`
// state so isWorkerPaused() can stay SYNCHRONOUS — the dashboard render and
// /dashboard/poll handlers read it inline and must not become async.
//
// Singleton: instantiate via getTranslateWorkerBridge(). index.ts calls
// setWorker(worker) once after spawning the worker (and again on respawn).
import { Worker } from "worker_threads"
import { randomUUID } from "crypto"

type Resolve = (value: unknown) => void
type Reject = (reason: unknown) => void

type StateListener = (paused: boolean) => void

class TranslateWorkerBridge {
  private worker: Worker | null = null
  private pending = new Map<string, { resolve: Resolve; reject: Reject }>()
  // Mirrored paused state — seeded by queryPaused on setWorker and kept fresh
  // by "state" pushes + pause/resume responses from the worker.
  private paused = false
  private stateListeners: StateListener[] = []

  setWorker(worker: Worker): void {
    this.worker = worker
    worker.on("message", (m: { id?: string; ok?: boolean; result?: unknown; type?: string; paused?: boolean }) => {
      // Request/response replies
      if (m.id && this.pending.has(m.id)) {
        const entry = this.pending.get(m.id)!
        this.pending.delete(m.id)
        if (m.ok !== false) entry.resolve(m.result ?? {})
        else entry.reject((m.result as { error?: string })?.error ?? "worker error")
        return
      }
      // Unsolicited state push from the worker
      if (m.type === "state" && typeof m.paused === "boolean") {
        this.setPaused(m.paused)
      }
    })

    // Seed the mirror from the worker's actual current state.
    this.queryPaused().catch(() => {})
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    for (const cb of this.stateListeners) {
      try {
        cb(paused)
      } catch {
        /* ignore listener errors */
      }
    }
  }

  private send(msg: Record<string, unknown>): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error("translate worker not initialized"))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, ...msg })
      // Safety timeout so a missing reply never wedges a request indefinitely.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error("translate worker request timed out"))
        }
      }, 10000)
    })
  }

  private async queryPaused(): Promise<void> {
    try {
      const result = (await this.send({ type: "queryPaused" })) as { paused?: boolean }
      if (typeof result.paused === "boolean") this.setPaused(result.paused)
    } catch {
      /* worker may not be ready yet; mirror stays at default false */
    }
  }

  /** Synchronous — returns the mirrored paused state. Safe to call from render/poll handlers. */
  isWorkerPaused(): boolean {
    return this.paused
  }

  async pauseWorker(actingUsername: string | null = null): Promise<void> {
    const result = (await this.send({ type: "pause", actingUsername })) as { paused?: boolean }
    if (typeof result.paused === "boolean") this.setPaused(result.paused)
  }

  async resumeWorker(actingUsername: string | null = null): Promise<void> {
    const result = (await this.send({ type: "resume", actingUsername })) as { paused?: boolean }
    if (typeof result.paused === "boolean") this.setPaused(result.paused)
  }

  async cleanupRunningChunks(): Promise<void> {
    await this.send({ type: "cleanup" })
  }

  async terminate(): Promise<void> {
    if (this.worker) await this.worker.terminate().catch(() => {})
  }

  /** Optional hook for callers that want to react to paused-state changes. */
  onStateChange(cb: StateListener): void {
    this.stateListeners.push(cb)
  }
}

let _bridge: TranslateWorkerBridge | null = null

export function getTranslateWorkerBridge(): TranslateWorkerBridge {
  if (!_bridge) _bridge = new TranslateWorkerBridge()
  return _bridge
}