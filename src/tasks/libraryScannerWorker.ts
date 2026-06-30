// Library-scanner worker entry point — runs inside a worker_threads Worker so
// the scanner's recursive fs.readdirSync walk and synchronous better-sqlite3
// calls do NOT block the main Express event loop (this was the main UI killer).
//
// The worker opens its own DB connection via getDb(). Inbound messages:
//   - "shutdown": close the DB and exit.
//   - "rescan":   wake the scanner loop immediately and, if this path is the one
//                 currently scanning, abort it and restart from the beginning.
import { parentPort } from "worker_threads"
import { getDb } from "../setup"
import { libraryScannerMain, requestRescan } from "./libraryTask"

const db = getDb()

libraryScannerMain(db).catch((err) => {
  if (parentPort) parentPort.postMessage({ type: "fatal", error: String(err) })
})

parentPort?.on("message", (m: { type: string; id?: number }) => {
  if (m.type === "shutdown") {
    db.close()
    process.exit(0)
  }
  if (m.type === "rescan" && typeof m.id === "number") {
    requestRescan(m.id)
  }
})