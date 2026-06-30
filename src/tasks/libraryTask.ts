import { EventEmitter } from "events"
import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import { createLog } from "../repositories/logRepository"
import {
  getLibraryPathById,
  getLibraryPathsDueForScanByMode,
  getLibraryPathsStuckInScanning,
  recordScanDuration,
  setLibraryPathState,
} from "../repositories/libraryPathRepository"
import { ScanAbortedError, scanLibraryPath } from "../services/libraryPathService"
import {
  LIBRARY_SCAN_TICK_MS,
  STUCK_SCAN_THRESHOLD_MINUTES,
} from "../constants/timer"

// --- Rescan control (main-thread -> worker is via libraryWorkerBridge) -------
//
// The worker loop is `while(true){ runScannerOnce(); interruptibleSleep(tick) }`.
// requestRescan(id) does two things:
//   1. adds `id` to pendingRescan so the next runScannerOnce picks it up even if
//      the wake emit is lost (it fires while a scan, not the sleep, is running);
//   2. if `id` is the path currently being scanned, sets abortCurrent so the
//      in-flight scanLibraryPath throws ScanAbortedError at its next checkpoint
//      and the inner loop restarts it from the beginning immediately;
//   3. emits "wake" to break the interruptibleSleep so an idle worker starts
//      within ~1s instead of waiting out the 15s tick.
const wake = new EventEmitter()
const pendingRescan = new Set<number>()
let currentlyScanningId: number | null = null
let abortCurrent = false

/** Called from the worker's `parentPort` message handler on `{type:"rescan",id}`. */
export function requestRescan(id: number): void {
  pendingRescan.add(id)
  if (currentlyScanningId === id) abortCurrent = true
  wake.emit("wake")
}

/** sleep() that is resolved early when `wake` emits (on a rescan request). */
function interruptibleSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    wake.once("wake", () => {
      clearTimeout(t)
      resolve()
    })
  })
}

export async function libraryScannerMain(db: Database.Database): Promise<void> {
  console.log("[library-scanner] Started")

  while (true) {
    try {
      await runScannerOnce(db)
    } catch (e) {
      createLog(db, "error", "scanFailed", "libraryScanner", null, `Library scanner loop crashed: ${String(e).slice(0, 200)}`, {
        error: String(e),
      })
      console.error("[library-scanner] Unexpected error:", e)
    }
    await interruptibleSleep(LIBRARY_SCAN_TICK_MS)
  }
}

async function runScannerOnce(db: Database.Database): Promise<void> {
  const config = getConfig(db)
  if (!config.scanLibraryPaths) return

  const stuckPaths = getLibraryPathsStuckInScanning(db)
  for (const lp of stuckPaths) {
    setLibraryPathState(db, lp.id, "error")
    createLog(
      db,
      "error",
      "scanFailed", "libraryScanner",
      lp.id,
      `Library path "${lp.name}" scan stuck for more than ${STUCK_SCAN_THRESHOLD_MINUTES} minutes — marked as error`,
      {
        name: lp.name,
        lastRunAt: lp.lastRunAt,
        thresholdMinutes: STUCK_SCAN_THRESHOLD_MINUTES,
      },
    )
    console.warn(
      `[library-scanner] Path "${lp.name}" stuck in scanning > ${STUCK_SCAN_THRESHOLD_MINUTES}min — marked error`,
    )
  }

  // Outer loop: re-collect until nothing is due. This catches rescan requests
  // that arrived mid-scan (their wake emit had no sleep-listener to break) —
  // pendingRescan captures them and we re-run without waiting for the next tick.
  while (true) {
    const duePaths = getLibraryPathsDueForScanByMode(db)
    // Pull in any pending rescan requests that aren't already due (e.g. a path
    // whose lastRunAt is recent but the user explicitly asked to rescan now).
    for (const id of pendingRescan) {
      if (duePaths.some((p) => p.id === id)) continue
      const lp = getLibraryPathById(db, id)
      if (lp && lp.enabled) duePaths.push(lp)
    }
    if (duePaths.length === 0) break

    for (const lp of duePaths) {
      // Inner loop: re-scan this path if its own rescan aborted it, so a rescan
      // of the currently-scanning path stops the in-flight scan and restarts
      // from the beginning immediately (no error state, no duration recorded).
      while (true) {
        const fresh = getLibraryPathById(db, lp.id)
        if (!fresh || !fresh.enabled) {
          pendingRescan.delete(lp.id)
          break
        }
        if (fresh.state === "scanning") {
          // Another iteration of this same path is somehow already scanning —
          // leave it; the abort/restart path below handles rescan. Drop the
          // pending flag so we don't loop forever.
          pendingRescan.delete(lp.id)
          break
        }

        // Whether this scan is the path's first (initial) one — read before the
        // scan runs, because scanLibraryPath flips initialScanCompleted to 1
        // part way through. Drives the initial-vs-subsequent duration buckets.
        const wasInitial = !fresh.initialScanCompleted

        abortCurrent = false
        currentlyScanningId = lp.id
        setLibraryPathState(db, lp.id, "scanning", true)
        const startedAt = Date.now()
        try {
          await scanLibraryPath(db, fresh, () => abortCurrent)
        } catch (e) {
          currentlyScanningId = null
          if (e instanceof ScanAbortedError) {
            // Rescan of this path while it was scanning: stop here, set idle,
            // and loop to restart from the beginning immediately. This is NOT a
            // failure — no error state, no scanFailed log, no duration recorded.
            setLibraryPathState(db, lp.id, "idle")
            createLog(
              db,
              "info",
              "scanAborted", "libraryScanner",
              lp.id,
              `Scan of library path "${lp.name}" aborted by rescan — restarting from the beginning`,
              { name: lp.name, path: lp.path },
            )
            pendingRescan.delete(lp.id)
            continue
          }
          createLog(
            db,
            "error",
            "scanFailed", "libraryScanner",
            lp.id,
            `Scan failed for library path "${lp.name}": ${String(e).slice(0, 200)}`,
            {
              name: lp.name,
              path: lp.path,
              error: String(e),
            },
          )
          console.error(`[library-scanner] Scan error for "${lp.name}":`, e)
          setLibraryPathState(db, lp.id, "error")
          pendingRescan.delete(lp.id)
          break
        }
        currentlyScanningId = null
        const durationMs = Date.now() - startedAt
        recordScanDuration(db, lp.id, durationMs, wasInitial)
        setLibraryPathState(db, lp.id, "idle")
        pendingRescan.delete(lp.id)
        break
      }
    }

    // If a rescan arrived for another path while we were scanning, loop to
    // process it now instead of sleeping.
    if (pendingRescan.size === 0) break
  }
}