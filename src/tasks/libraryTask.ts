import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import { createLog } from "../repositories/logRepository"
import {
  getLibraryPathById,
  getLibraryPathsDueForScan,
  getLibraryPathsStuckInScanning,
  setLibraryPathState,
} from "../repositories/libraryPathRepository"
import { scanLibraryPath } from "../services/libraryPathService"
import {
  LIBRARY_SCAN_INTERVAL_MINUTES,
  LIBRARY_SCAN_TICK_MS,
  STUCK_SCAN_THRESHOLD_MINUTES,
} from "../constants/timer"
import { sleep } from "../repositories/shared"

export async function libraryScannerMain(db: Database.Database): Promise<void> {
  console.log("[library-scanner] Started")

  while (true) {
    try {
      await runScannerOnce(db)
    } catch (e) {
      createLog(db, "error", "libraryScanner", null, `Library scanner loop crashed: ${String(e).slice(0, 200)}`, {
        error: String(e),
      })
      console.error("[library-scanner] Unexpected error:", e)
    }
    await sleep(LIBRARY_SCAN_TICK_MS)
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
      "libraryScanner",
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

  const duePaths = getLibraryPathsDueForScan(db, LIBRARY_SCAN_INTERVAL_MINUTES)

  for (const lp of duePaths) {
    const fresh = getLibraryPathById(db, lp.id)
    if (!fresh || !fresh.enabled) continue
    if (fresh.state === "scanning") continue

    setLibraryPathState(db, lp.id, "scanning", true)
    try {
      await scanLibraryPath(db, lp)
    } catch (e) {
      createLog(
        db,
        "error",
        "libraryScanner",
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
      continue
    }
    setLibraryPathState(db, lp.id, "idle")
  }
}
