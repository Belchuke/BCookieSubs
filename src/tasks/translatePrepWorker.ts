// Translate-prep worker entry point — runs inside a worker_threads Worker so
// the PGS/VobSub OCR + embedded-track extraction (mkvextract) invoked by the
// per-item Translate / re-add / season-batch flows do NOT block the main
// Express event loop (this was the UI killer for every browser while a PGS
// subtitle was being OCR'd).
//
// The worker opens its own DB connection via getDb() (same pattern as the
// library scanner worker). Inbound messages (mirrored by
// translatePrepWorkerBridge on the main thread):
//   - {type:"translateItem", id, itemId, resetStatus, userId, sourceOverride,
//      sourceLanguageHint}  -> {id, ok, result}
//   - {type:"translateBatch", id, items:[{itemId, resetStatus?, sourceOverride?,
//      sourceLanguageHint?}], userId}  -> {id, ok, results:[{itemId,success,msg}]}
//   - {type:"shutdown"}  -> close DB and exit.
//
// Handlers are serialized via a promise chain so concurrent requests don't
// overlap (better-sqlite3 is synchronous and OCR is CPU-bound; running them
// concurrently in one worker would just thrash).
import * as fs from "fs"
import { parentPort } from "worker_threads"
import { getDb } from "../setup"
import {
  prepareTranslationForItem,
  listSubtitleSourcesForVideo,
  type TranslateSourceOverride,
  type SubtitleSourceCandidate,
} from "../services/libraryPathService"
import { upsertItemSubtitleSources } from "../repositories/subtitleSourceCacheRepository"

const db = getDb()

type TranslateItemMsg = {
  type: "translateItem"
  id: string
  itemId: number
  resetStatus: boolean
  userId: number
  sourceOverride: TranslateSourceOverride | null
  sourceLanguageHint: string | null
}
type TranslateBatchMsg = {
  type: "translateBatch"
  id: string
  items: {
    itemId: number
    resetStatus?: boolean
    sourceOverride?: TranslateSourceOverride | null
    sourceLanguageHint?: string | null
  }[]
  userId: number
}
type ListSourcesMsg = {
  type: "listSources"
  id: string
  itemId: number
  videoFilePath: string
  sourceLangIso639: string
  sourceLangIso2b: string | null
  sourceLangName: string
}
type ShutdownMsg = { type: "shutdown" }
type Msg = TranslateItemMsg | TranslateBatchMsg | ListSourcesMsg | ShutdownMsg

// Serialize message handling: each message is appended to a promise chain so
// the next is only processed after the previous resolves. This keeps DB/OCR
// work from interleaving without dropping queued messages.
let chain: Promise<void> = Promise.resolve()

function handle(msg: Msg): void {
  if (msg.type === "shutdown") {
    db.close()
    process.exit(0)
    return
  }
  chain = chain
    .then(async () => {
      if (msg.type === "translateItem") {
        const result = await prepareTranslationForItem(
          db,
          msg.itemId,
          msg.resetStatus,
          msg.userId,
          msg.sourceOverride,
          msg.sourceLanguageHint,
        )
        parentPort?.postMessage({ id: msg.id, ok: true, result })
      } else if (msg.type === "translateBatch") {
        const results = []
        for (const it of msg.items) {
          const r = await prepareTranslationForItem(
            db,
            it.itemId,
            it.resetStatus ?? false,
            msg.userId,
            it.sourceOverride ?? null,
            it.sourceLanguageHint ?? null,
          )
          results.push({ itemId: it.itemId, success: r.success, msg: r.msg })
        }
        parentPort?.postMessage({ id: msg.id, ok: true, results })
      } else if (msg.type === "listSources") {
        // Computing picture counts for embedded image tracks requires a
        // mkvextract pass + parse; running it here keeps the extraction off the
        // Express event loop. The result is also written to the source cache so
        // the next picker open for this item reads from cache (no re-extract).
        const sources: SubtitleSourceCandidate[] = listSubtitleSourcesForVideo(
          msg.videoFilePath,
          msg.sourceLangIso639,
          msg.sourceLangIso2b,
          msg.sourceLangName,
        )
        try {
          const st = fs.statSync(msg.videoFilePath)
          upsertItemSubtitleSources(db, msg.itemId, sources, Math.floor(st.mtimeMs), st.size)
        } catch {
          /* file vanished / not statable — still return the computed sources */
        }
        parentPort?.postMessage({ id: msg.id, ok: true, sources })
      }
    })
    .catch((e) => {
      // Reply with an error so the main-thread bridge rejects/times out and the
      // request isn't left hanging; the chain stays usable for the next message.
      parentPort?.postMessage({ id: (msg as { id?: string }).id ?? "", ok: false, error: String(e).slice(0, 300) })
    })
}

parentPort?.on("message", (m: Msg) => handle(m))

console.log("[translate-prep-worker] Started")