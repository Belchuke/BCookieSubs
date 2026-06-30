// Main-thread bridge for the translate-prep worker.
//
// The per-item Translate / re-add / season-batch flows previously ran PGS/VobSub
// OCR + embedded-track extraction inline in the Express route handler
// (autoTranslateItem). That is long, synchronous, CPU-heavy work, and because
// Node is single-threaded it blocked the event loop and froze every browser's
// /poll requests. This bridge sends that work to a dedicated worker_threads
// Worker (src/tasks/translatePrepWorker.ts) over a request/id pattern and awaits
// the reply — the main thread stays free while the OCR runs off-thread.
//
// Singleton: instantiate via getTranslatePrepWorkerBridge(). index.ts calls
// setWorker(worker) once after spawning the worker (and again on respawn).
import { Worker } from "worker_threads"
import { randomUUID } from "crypto"
import type { TranslateSourceOverride, SubtitleSourceCandidate } from "../services/libraryPathService"

type Resolve = (value: unknown) => void
type Reject = (reason: unknown) => void

type TranslateResult = { success: boolean; msg: string }
type BatchResult = { itemId: number; success: boolean; msg: string }

type BatchItem = {
  itemId: number
  resetStatus?: boolean
  sourceOverride?: TranslateSourceOverride | null
  sourceLanguageHint?: string | null
}

class TranslatePrepWorkerBridge {
  private worker: Worker | null = null
  private pending = new Map<string, { resolve: Resolve; reject: Reject }>()

  setWorker(worker: Worker): void {
    this.worker = worker
    worker.on("message", (m: { id?: string; ok?: boolean; result?: unknown; error?: string }) => {
      if (!m.id || !this.pending.has(m.id)) return
      const entry = this.pending.get(m.id)!
      this.pending.delete(m.id)
      if (m.ok !== false) entry.resolve(m.result)
      else entry.reject(m.error ?? "translate-prep worker error")
    })
  }

  private send(msg: Record<string, unknown>, timeoutMs = 30 * 60 * 1000): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error("translate-prep worker not initialized"))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, ...msg })
      // PGS OCR of a long movie can run for many minutes; the safety timeout
      // is a backstop so a missing reply never wedges a request forever.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error("translate-prep worker request timed out"))
        }
      }, timeoutMs)
    })
  }

  async translateItem(
    itemId: number,
    resetStatus: boolean,
    userId: number,
    sourceOverride?: TranslateSourceOverride | null,
    sourceLanguageHint?: string | null,
  ): Promise<TranslateResult> {
    try {
      return (await this.send({
        type: "translateItem",
        itemId,
        resetStatus,
        userId,
        sourceOverride: sourceOverride ?? null,
        sourceLanguageHint: sourceLanguageHint ?? null,
      })) as TranslateResult
    } catch (e) {
      return { success: false, msg: e instanceof Error ? e.message : "Failed to queue translation" }
    }
  }

  async translateBatch(items: BatchItem[], userId: number): Promise<BatchResult[]> {
    try {
      return (await this.send({ type: "translateBatch", items, userId })) as BatchResult[]
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to queue translation"
      return items.map((it) => ({ itemId: it.itemId, success: false, msg }))
    }
  }

  // List subtitle sources for a video (with real picture counts for image
  // tracks). Offloaded to the worker because computing embedded picture counts
  // runs a mkvextract pass + parse, which would otherwise block the event loop.
  // The worker also writes the result to the source cache (keyed by itemId) so
  // subsequent opens read from cache. Returns null if the worker is unavailable
  // so callers can fall back to a sync, count-less
  // listSubtitleSourcesForVideo(..., { withPictureCounts: false }).
  async listSubtitleSources(
    itemId: number,
    videoFilePath: string,
    sourceLangIso639: string,
    sourceLangIso2b: string | null,
    sourceLangName: string,
  ): Promise<SubtitleSourceCandidate[] | null> {
    try {
      return (await this.send({
        type: "listSources",
        itemId,
        videoFilePath,
        sourceLangIso639,
        sourceLangIso2b,
        sourceLangName,
      })) as SubtitleSourceCandidate[]
    } catch {
      return null
    }
  }

  async terminate(): Promise<void> {
    if (this.worker) await this.worker.terminate().catch(() => {})
  }
}

let _bridge: TranslatePrepWorkerBridge | null = null

export function getTranslatePrepWorkerBridge(): TranslatePrepWorkerBridge {
  if (!_bridge) _bridge = new TranslatePrepWorkerBridge()
  return _bridge
}