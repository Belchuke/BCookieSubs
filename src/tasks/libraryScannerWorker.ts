// Library-scanner worker entry point — runs inside a worker_threads Worker so
// the scanner's recursive fs.readdirSync walk and synchronous better-sqlite3
// calls do NOT block the main Express event loop (this was the main UI killer).
//
// The worker opens its own DB connection via getDb(). The scanner has no
// pause/resume control surface — the only inbound message is "shutdown".
import { parentPort } from "worker_threads"
import { getDb } from "../setup"
import { libraryScannerMain } from "./libraryTask"

const db = getDb()

libraryScannerMain(db).catch((err) => {
  if (parentPort) parentPort.postMessage({ type: "fatal", error: String(err) })
})

parentPort?.on("message", (m: { type: string }) => {
  if (m.type === "shutdown") {
    db.close()
    process.exit(0)
  }
})