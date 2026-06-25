import express from "express"
import cookieParser from "cookie-parser"
import path from "path"
import dotenv from "dotenv"
import { spawn, ChildProcess } from "node:child_process"
import { Worker } from "node:worker_threads"
import { getDb } from "./setup"
import { syncSecretsFromEnv } from "./repositories/movieDbRepository"
import { cleanupExtractTempDir } from "./services/libraryPathService"
import { cleanupWhisperTempDir } from "./services/whisperService"
import { getTranslateWorkerBridge } from "./tasks/translateWorkerBridge"
import { getWhisperWorkerBridge } from "./tasks/whisperWorkerBridge"
import { loadSession } from "./middleware/auth"
import { requireInternalToken } from "./middleware/internalAuth"
import { authRouter } from "./routes/auth"
import { dashboardRouter } from "./routes/dashboard"
import { modelsRouter } from "./routes/models"
import { promptsRouter } from "./routes/prompts"
import { usersRouter } from "./routes/users"
import { appconfigRouter } from "./routes/appconfig"
import { statsRouter } from "./routes/stats"
import { logsRouter } from "./routes/logs"
import { translatedRouter } from "./routes/translated"
import { schedulesRouter } from "./routes/schedules"
import { libraryPathsRouter } from "./routes/librarypaths"
import { libraryRequestsRouter } from "./routes/libraryrequests"
import { accountRouter } from "./routes/account"
import { offsetRouter } from "./routes/offset"
import { STARTUP_DELAY_MS } from "./constants/timer"

dotenv.config()

const OLLAMA_SPAWN_DISABLED = process.env.DISABLE_OLLAMA_SPAWN === "1" || process.env.DISABLE_OLLAMA_SPAWN === "true"

let ollamaProcess: ChildProcess | null = null
let retryCount = 0
const MAX_RETRIES = 5
let running = false
let stopping = false
let portConflictDetected = false

function runOllamaServe(): ChildProcess | null {
  if (OLLAMA_SPAWN_DISABLED) {
    if (!running) {
      console.log("[ollama] DISABLE_OLLAMA_SPAWN set — skipping in-process spawn; using external Ollama server")
      running = true
    }
    return null
  }
  if (ollamaProcess && !ollamaProcess.killed) return ollamaProcess

  const child = spawn("ollama", ["serve"], { stdio: ["ignore", "pipe", "pipe"] })
  ollamaProcess = child

  child.stdout?.on("data", (data) => process.stdout.write(`[ollama] ${data}`))
  child.stderr?.on("data", (data) => {
    const msg = data.toString()
    process.stderr.write(`[ollama] ${msg}`)
    if (msg.includes("address already in use")) {
      console.log("[ollama] appears to already be running on port 11434")
      portConflictDetected = true
      return
    }
  })

  child.on("spawn", () => {
    console.log("[ollama] serve started")
    retryCount = 0
    running = true
    portConflictDetected = false
  })

  child.on("error", (err) => {
    console.error("[ollama] failed to start:", err)
    ollamaProcess = null
    if (portConflictDetected) {
      console.log("[ollama] skipping retry — port already in use")
      running = true
      portConflictDetected = false
      return
    }
    if (!stopping && retryCount < MAX_RETRIES) {
      retryCount++
      console.log(`[ollama] retry ${retryCount}/${MAX_RETRIES} in 2s...`)
      setTimeout(() => runOllamaServe(), 2000)
    } else if (retryCount >= MAX_RETRIES) {
      console.error("[ollama] max retries reached, giving up")
    }
  })

  child.on("exit", (code, signal) => {
    console.log(`[ollama] exited (code=${code}, signal=${signal})`)
    ollamaProcess = null
    running = false
    if (portConflictDetected) {
      console.log("[ollama] skipping retry — port already in use")
      running = true
      portConflictDetected = false
      return
    }
    if (!stopping && retryCount < MAX_RETRIES) {
      retryCount++
      console.log(`[ollama] retry ${retryCount}/${MAX_RETRIES} in 2s...`)
      setTimeout(() => runOllamaServe(), 2000)
    } else if (retryCount >= MAX_RETRIES) {
      console.error("[ollama] max retries reached, giving up")
    }
  })

  return child
}

export function stopOllamaServe() {
  stopping = true
  ollamaProcess?.kill("SIGTERM")
}

// ── background workers (run in worker_threads so they don't block the UI) ──
let translateWorker: Worker | null = null
let libraryWorker: Worker | null = null
let whisperWorker: Worker | null = null
let shuttingDown = false

// Bounded respawn for the translate worker: max 3 restarts within 10 min so a
// broken ollama/DB doesn't get hammered forever. The scanner is idempotent and
// self-throttling, so it respawns freely. The whisper worker mirrors the
// translate worker's bounded respawn.
const TRANSLATE_RESPAWN_MAX = 3
const TRANSLATE_RESPAWN_WINDOW_MS = 10 * 60 * 1000
const translateRespawns: number[] = []
const WHISPER_RESPAWN_MAX = 3
const WHISPER_RESPAWN_WINDOW_MS = 10 * 60 * 1000
const whisperRespawns: number[] = []

function workerScriptPath(name: string): string {
  // __dirname is dist/ after tsc, so this resolves to dist/tasks/<name>.js
  return path.join(__dirname, "tasks", `${name}.js`)
}

function spawnTranslateWorker(): Worker {
  const w = new Worker(workerScriptPath("translateWorker"))
  translateWorker = w
  getTranslateWorkerBridge().setWorker(w)
  w.on("error", (err) => console.error("[translate-worker] error:", err))
  w.on("exit", (code) => {
    console.log(`[translate-worker] exited (code=${code})`)
    translateWorker = null
    if (shuttingDown) return
    // Drop respawns outside the rolling 10-min window.
    const now = Date.now()
    while (translateRespawns.length && now - translateRespawns[0] > TRANSLATE_RESPAWN_WINDOW_MS) {
      translateRespawns.shift()
    }
    if (translateRespawns.length >= TRANSLATE_RESPAWN_MAX) {
      console.error("[translate-worker] max restarts reached in 10 min — giving up; restart the process to resume")
      return
    }
    translateRespawns.push(now)
    console.log(`[translate-worker] restarting in 5s…`)
    setTimeout(() => {
      if (!shuttingDown) spawnTranslateWorker()
    }, 5000)
  })
  return w
}

function spawnLibraryWorker(): Worker {
  const w = new Worker(workerScriptPath("libraryScannerWorker"))
  libraryWorker = w
  w.on("error", (err) => console.error("[library-scanner-worker] error:", err))
  w.on("exit", (code) => {
    console.log(`[library-scanner-worker] exited (code=${code})`)
    libraryWorker = null
    if (shuttingDown) return
    console.log(`[library-scanner-worker] restarting in 5s…`)
    setTimeout(() => {
      if (!shuttingDown) spawnLibraryWorker()
    }, 5000)
  })
  return w
}

function spawnWhisperWorker(): Worker {
  const w = new Worker(workerScriptPath("whisperWorker"))
  whisperWorker = w
  getWhisperWorkerBridge().setWorker(w)
  w.on("error", (err) => console.error("[whisper-worker] error:", err))
  w.on("exit", (code) => {
    console.log(`[whisper-worker] exited (code=${code})`)
    whisperWorker = null
    if (shuttingDown) return
    const now = Date.now()
    while (whisperRespawns.length && now - whisperRespawns[0] > WHISPER_RESPAWN_WINDOW_MS) {
      whisperRespawns.shift()
    }
    if (whisperRespawns.length >= WHISPER_RESPAWN_MAX) {
      console.error("[whisper-worker] max restarts reached in 10 min — giving up; restart the process to resume")
      return
    }
    whisperRespawns.push(now)
    console.log(`[whisper-worker] restarting in 5s…`)
    setTimeout(() => {
      if (!shuttingDown) spawnWhisperWorker()
    }, 5000)
  })
  return w
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log("\nShutting down gracefully…")
  // Release any in-flight claimed chunks in the translate worker before it exits.
  try {
    await getTranslateWorkerBridge().cleanupRunningChunks()
  } catch (e) {
    console.error("[shutdown] cleanup error:", e)
  }
  try {
    await getWhisperWorkerBridge().cleanupRunningChunks()
  } catch (e) {
    console.error("[shutdown] whisper cleanup error:", e)
  }
  if (translateWorker) translateWorker.postMessage({ type: "shutdown" })
  if (libraryWorker) libraryWorker.postMessage({ type: "shutdown" })
  if (whisperWorker) whisperWorker.postMessage({ type: "shutdown" })
  await Promise.race([
    Promise.all([
      translateWorker ? translateWorker.terminate() : Promise.resolve(),
      libraryWorker ? libraryWorker.terminate() : Promise.resolve(),
      whisperWorker ? whisperWorker.terminate() : Promise.resolve(),
    ]),
    new Promise((r) => setTimeout(r, 5000)),
  ])
  cleanupExtractTempDir()
  cleanupWhisperTempDir()
  stopOllamaServe()
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4849

const db = getDb()
syncSecretsFromEnv(db)

const app = express()

app.locals.db = db

app.set("view engine", "ejs")
app.set("views", path.join(__dirname, "../views"))

app.use('/offset', express.json({ limit: '5mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(cookieParser())

app.use(express.static(path.join(__dirname, "../public")))

app.use(loadSession)

app.use("/", authRouter(db))
app.use("/dashboard", dashboardRouter(db))
app.use("/models", modelsRouter(db))
app.use("/prompts", promptsRouter(db))
app.use("/users", usersRouter(db))
app.use("/config", appconfigRouter(db))
app.use("/stats", statsRouter(db))
app.use("/logs", logsRouter(db))
app.use("/translated", translatedRouter(db))
app.use("/schedules", schedulesRouter(db))
app.use("/library-paths", libraryPathsRouter(db))
app.use("/library-requests", libraryRequestsRouter(db))
app.use("/account", accountRouter(db))
app.use("/offset", offsetRouter(db))

app.use(express.static(path.join(process.cwd(), "public")))
app.use("/media-photos", express.static(path.join(process.cwd(), "mediaItemPhotos")))
app.use("/static", express.static(path.join(process.cwd(), "node_modules", "@fortawesome", "fontawesome-free")))
app.use("/flag-icons", express.static(path.join(process.cwd(), "node_modules", "flag-icons")))

app.post("/aiOllama/window", (req, res) => {
  const user = res.locals.user
  if (!user) return res.status(401).json({ success: false, message: "Unauthorized" })
  if (!res.locals.can("canManageSettings"))
    return res.status(403).json({ success: false, message: "Permission denied" })

  const { start } = req.body as { start: boolean }
  if (start) {
    runOllamaServe()
    return res.json({ success: true, message: "Ollama serve started" })
  } else {
    stopOllamaServe()
    return res.json({ success: true, message: "Ollama serve stopped" })
  }
})

const internalRouter = express.Router()
internalRouter.use(requireInternalToken)
internalRouter.get("/healthz", (_req, res) => res.json({ ok: true }))
app.use("/internal", internalRouter)

app.listen(PORT, () => {
  console.log(`[server] BCookieSubs running on http://localhost:${PORT}`)
  if (!running) {
    runOllamaServe()
  }
})

console.log(`[startup] Waiting ${STARTUP_DELAY_MS / 1000}s for Ollama to start before launching workers…`)
setTimeout(() => {
  console.log("[startup] Starting background workers (worker_threads)")
  spawnTranslateWorker()
  spawnLibraryWorker()
  spawnWhisperWorker()
}, STARTUP_DELAY_MS)
