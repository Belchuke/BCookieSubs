// Main-thread control bridge for the dedicated OCR worker. Mirrors
// whisperWorkerBridge.ts: routes pause/resume/cleanup to the worker over
// postMessage (request/id pattern) and mirrors the worker's `paused` state so
// isWorkerPaused() stays SYNCHRONOUS for the dashboard render + /dashboard/poll.
//
// Singleton: instantiate via getOcrWorkerBridge(). index.ts calls setWorker(worker)
// once after spawning the worker (and again on respawn).
import { Worker } from "worker_threads"
import { randomUUID } from "crypto"

type Resolve = (value: unknown) => void
type Reject = (reason: unknown) => void

type StateListener = (paused: boolean) => void

class OcrWorkerBridge {
  private worker: Worker | null = null
  private pending = new Map<string, { resolve: Resolve; reject: Reject }>()
  private paused = false
  private stateListeners: StateListener[] = []

  setWorker(worker: Worker): void {
    this.worker = worker
    worker.on("message", (m: { id?: string; ok?: boolean; result?: unknown; type?: string; paused?: boolean }) => {
      if (m.id && this.pending.has(m.id)) {
        const entry = this.pending.get(m.id)!
        this.pending.delete(m.id)
        if (m.ok !== false) entry.resolve(m.result ?? {})
        else entry.reject((m.result as { error?: string })?.error ?? "worker error")
        return
      }
      if (m.type === "state" && typeof m.paused === "boolean") {
        this.setPaused(m.paused)
      }
    })

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
    if (!this.worker) return Promise.reject(new Error("ocr worker not initialized"))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, ...msg })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error("ocr worker request timed out"))
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

  /** Synchronous — returns the mirrored paused state. */
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

  onStateChange(cb: StateListener): void {
    this.stateListeners.push(cb)
  }
}

let _bridge: OcrWorkerBridge | null = null

export function getOcrWorkerBridge(): OcrWorkerBridge {
  if (!_bridge) _bridge = new OcrWorkerBridge()
  return _bridge
}