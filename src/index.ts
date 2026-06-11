import express from "express"
import cookieParser from "cookie-parser"
import path from "path"
import dotenv from "dotenv"
import { spawn, ChildProcess } from "node:child_process"
import { getDb } from "./setup"
import { syncSecretsFromEnv } from "./repositories/movieDbRepository"
import { taskMain, cleanupRunningChunks } from "./tasks/translateTask"
import { cleanupExtractTempDir } from "./services/libraryPathService"
import { libraryScannerMain } from "./tasks/libraryTask"
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

process.on("SIGINT", () => {
  console.log("\nShutting down gracefully…")
  cleanupRunningChunks(db)
  cleanupExtractTempDir()
  stopOllamaServe()
  process.exit(0)
})

process.on("SIGTERM", () => {
  cleanupRunningChunks(db)
  cleanupExtractTempDir()
  stopOllamaServe()
  process.exit(0)
})

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
  console.log("[startup] Starting background workers")

  taskMain(db).catch((err) => {
    console.error("[worker] Fatal error:", err)
  })

  libraryScannerMain(db).catch((err) => {
    console.error("[library-scanner] Fatal error:", err)
  })
}, STARTUP_DELAY_MS)
