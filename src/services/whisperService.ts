import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"
import axios from "axios"
import Database from "better-sqlite3"
import { createLog } from "../repositories/logRepository"
import { getConfig } from "../repositories/configRepository"
import { parseSrt, SrtEntry, serializeSrt } from "./srtService"

let whisperCliPathCache: string | null = null

const WHISPER_CPP_PATH = path.join(process.cwd(), "node_modules", "nodejs-whisper", "cpp", "whisper.cpp")

// Direct download source for ggml Whisper models. This mirrors the URL the
// Dockerfile uses to preload the default model, and the same source
// nodejs-whisper's download-ggml-model.sh pulls from. We download directly
// instead of calling nodejs-whisper's autoDownloadModel because that helper
// shells out with `cd` + a relative `./download-ggml-model.sh` (which breaks
// when the cwd isn't the models dir) and then tries to rebuild whisper.cpp
// from source via cmake at runtime — neither of which belongs in a container.
const WHISPER_MODEL_DOWNLOAD_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"

const WHISPER_MODELS = [
  "tiny",
  "tiny.en",
  "base",
  "base.en",
  "small",
  "small.en",
  "medium",
  "medium.en",
  "large-v1",
  "large",
  "large-v3-turbo",
] as const

const MODEL_FILE_NAMES: Record<string, string> = {
  tiny: "ggml-tiny.bin",
  "tiny.en": "ggml-tiny.en.bin",
  base: "ggml-base.bin",
  "base.en": "ggml-base.en.bin",
  small: "ggml-small.bin",
  "small.en": "ggml-small.en.bin",
  medium: "ggml-medium.bin",
  "medium.en": "ggml-medium.en.bin",
  "large-v1": "ggml-large-v1.bin",
  large: "ggml-large.bin",
  "large-v3-turbo": "ggml-large-v3-turbo.bin",
}

export type WhisperModelName = (typeof WHISPER_MODELS)[number]

export function getWhisperModels(): WhisperModelName[] {
  return [...WHISPER_MODELS]
}

function validateWhisperModel(model: string): WhisperModelName {
  if (WHISPER_MODELS.includes(model as WhisperModelName)) return model as WhisperModelName
  return "large-v3-turbo"
}

function validateTimestampsLength(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 80
  return Math.min(500, Math.max(1, Math.floor(value)))
}

export function isWhisperGpuAvailable(): boolean {
  return process.env.WHISPER_GPU_AVAILABLE === "1" || process.env.WHISPER_GPU_AVAILABLE === "true"
}

function findWhisperCliPath(): string | null {
  if (whisperCliPathCache) return whisperCliPathCache

  const execName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
  const candidates = [
    path.join(WHISPER_CPP_PATH, "build", "bin", execName),
    path.join(WHISPER_CPP_PATH, "build", "bin", "Release", execName),
    path.join(WHISPER_CPP_PATH, "build", "bin", "Debug", execName),
    path.join(WHISPER_CPP_PATH, "build", execName),
    path.join(WHISPER_CPP_PATH, execName),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      whisperCliPathCache = candidate
      return candidate
    }
  }
  return null
}

let whisperTempDir: string | null = null

function getWhisperTempDir(): string {
  if (!whisperTempDir) {
    whisperTempDir = path.join(os.tmpdir(), `bcookiesubs-whisper-${process.pid}`)
    try {
      fs.mkdirSync(whisperTempDir, { recursive: true })
    } catch {}
  }
  return whisperTempDir
}

export function cleanupWhisperTempDir(): void {
  if (!whisperTempDir) return
  try {
    fs.rmSync(whisperTempDir, { recursive: true, force: true })
  } catch {}
  whisperTempDir = null
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch {}
}

function getWhisperModelPath(model: WhisperModelName, modelRootPath?: string): string {
  const modelFile = MODEL_FILE_NAMES[model]
  if (!modelFile) throw new Error(`Unknown Whisper model: ${model}`)
  if (modelRootPath) {
    return path.join(modelRootPath, modelFile)
  }
  return path.join(WHISPER_CPP_PATH, "models", modelFile)
}

// Stream ggml-<model>.bin directly from HuggingFace into targetDir, writing to
// a .part file first and renaming on success so a partial download never leaves
// a half-written model that the next run would mistake for a complete one.
async function downloadWhisperModel(model: WhisperModelName, targetDir: string): Promise<void> {
  const modelFile = MODEL_FILE_NAMES[model]
  if (!modelFile) throw new Error(`Unknown Whisper model: ${model}`)
  const targetPath = path.join(targetDir, modelFile)
  const tmpPath = `${targetPath}.part`
  const url = `${WHISPER_MODEL_DOWNLOAD_BASE}/${modelFile}`

  safeUnlink(tmpPath)
  const res = await axios.get(url, {
    responseType: "stream",
    maxRedirects: 10,
    // Models are multi-GB; apply no overall timeout — rely on socket inactivity.
    timeout: 0,
  })
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} downloading ${modelFile} from ${url}`)
  }

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(tmpPath)
    const fail = (err: unknown): void => {
      file.destroy()
      safeUnlink(tmpPath)
      reject(err)
    }
    res.data.pipe(file)
    file.on("finish", () => {
      file.close((closeErr) => {
        if (closeErr) return fail(closeErr)
        fs.rename(tmpPath, targetPath, (renameErr) => {
          if (renameErr) return fail(renameErr)
          resolve()
        })
      })
    })
    file.on("error", fail)
    res.data.on("error", fail)
  })
}

function escapeShellArg(arg: string): string {
  if (process.platform === "win32") {
    return `"${arg.replace(/"/g, '\\"')}"`
  }
  return `"${arg}"`
}

function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-nostats",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ]
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve()
      } else {
        reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(0, 200)}`))
      }
    })
    proc.on("error", (err) => reject(err))
  })
}

export type WhisperTranscriptionProgress = (progress: number, positionMs: number, durationMs: number) => void

export type WhisperTranscriptionResult =
  | {
      success: true
      entries: SrtEntry[]
      rawSrt: string
      model: string
    }
  | { success: false; error: string }

export async function transcribeMediaWithWhisper(
  db: Database.Database,
  mediaPath: string,
  mediaItemId: number,
  overrideModel?: string,
  onProgress?: WhisperTranscriptionProgress,
  displayName?: string,
): Promise<WhisperTranscriptionResult> {
  const config = getConfig(db)
  const model = validateWhisperModel(overrideModel || config.whisperModel || "large-v3-turbo")
  const timestampsLength = validateTimestampsLength(config.whisperTimestampsLength ?? 80)
  const useCuda = isWhisperGpuAvailable() && config.whisperUseCuda === 1
  const modelRootPathRaw =
    (config.whisperModelRootPath || process.env.WHISPER_MODEL_ROOT_PATH || "").trim() || undefined
  if (modelRootPathRaw) {
    try {
      fs.mkdirSync(modelRootPathRaw, { recursive: true })
    } catch {}
  }

  const mediaBasename = path.basename(mediaPath)
  const tempDir = getWhisperTempDir()
  const tempMediaPath = path.join(tempDir, `${Date.now()}-${mediaBasename}`)
  const wavMediaPath = `${tempMediaPath}.wav`
  const expectedSrtPath = `${wavMediaPath}.srt`

  createLog(db, "info", "whisper", mediaItemId, `Whisper transcription queued for media item ${mediaItemId}`, {
    model,
    mediaBasename,
    useCuda,
  })

  try {
    fs.copyFileSync(mediaPath, tempMediaPath)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    createLog(db, "error", "whisper", mediaItemId, `Failed to copy media for Whisper: ${msg.slice(0, 200)}`, {
      mediaBasename,
    })
    return { success: false, error: `Failed to copy media file: ${msg.slice(0, 200)}` }
  }

  try {
    createLog(db, "info", "whisper", mediaItemId, `Whisper transcription started using model ${model}`, {
      mediaBasename,
      timestampsLength,
      useCuda,
    })

    createLog(db, "info", "whisper", mediaItemId, `Converting media to WAV for Whisper`, { mediaBasename })
    await convertToWav(tempMediaPath, wavMediaPath)

    // Total audio length, used to drive a reliable progress percentage by
    // comparing it against the latest segment timestamp whisper-cli streams out.
    const wavDurationMs = getWavDurationMs(wavMediaPath)

    const cliPath = findWhisperCliPath()
    if (!cliPath) {
      throw new Error("whisper-cli executable not found; please run the setup script to build whisper.cpp")
    }
    createLog(db, "info", "whisper", mediaItemId, `Using whisper-cli at ${cliPath}`, {})

    const modelPath = getWhisperModelPath(model, modelRootPathRaw)
    if (!fs.existsSync(modelPath)) {
      createLog(db, "info", "whisper", mediaItemId, `Whisper model ${model} not found; downloading`, { modelPath })
      const downloadDir = modelRootPathRaw || path.join(WHISPER_CPP_PATH, "models")
      await downloadWhisperModel(model, downloadDir)
      if (!fs.existsSync(modelPath)) {
        throw new Error(`Whisper model file not found at ${modelPath} after download`)
      }
      createLog(db, "info", "whisper", mediaItemId, `Whisper model ${model} downloaded`, { modelPath })
    }

    const flags = ["-osrt", "-pp", "-sow", "true", "-ml", String(timestampsLength), useCuda ? undefined : "-ng"].filter(
      (f): f is string => f !== undefined,
    )

    const command = [cliPath, ...flags, "-l", "auto", "-m", modelPath, "-f", wavMediaPath]

    createLog(db, "info", "whisper", mediaItemId, `Running whisper-cli`, {
      command: command.map(escapeShellArg).join(" "),
    })

    // Emit a progress log for every 15 minutes of audio transcribed, e.g.
    // "Whispered 15 min for The Matrix". positionMs is the latest transcribed
    // segment's end time, so this tracks transcribed-audio time, not wall-clock.
    const LOG_INTERVAL_MS = 15 * 60 * 1000
    const name = displayName || path.basename(mediaPath)
    let lastLoggedMark = 0
    const onProgressWithLog: WhisperTranscriptionProgress = (progress, positionMs, durationMs) => {
      const mark = Math.floor(positionMs / LOG_INTERVAL_MS)
      if (mark > lastLoggedMark) {
        lastLoggedMark = mark
        const minutes = mark * 15
        createLog(db, "info", "whisper", mediaItemId, `Whispered ${minutes} min for ${name}`, {
          mediaBasename,
          positionMs,
          durationMs,
        })
      }
      onProgress?.(progress, positionMs, durationMs)
    }

    await runWhisperCli(command, wavDurationMs, onProgressWithLog)

    if (!fs.existsSync(expectedSrtPath)) {
      throw new Error("Whisper finished but no SRT file was generated")
    }

    const rawSrt = fs.readFileSync(expectedSrtPath, "utf-8")
    const parsedEntries = parseSrt(rawSrt)

    if (parsedEntries.length === 0) {
      throw new Error("Whisper generated an empty or unparseable SRT")
    }

    const entries = deduplicateSrtEntries(parsedEntries)
    const dedupedCount = parsedEntries.length - entries.length
    if (dedupedCount > 0) {
      createLog(
        db,
        "info",
        "whisper",
        mediaItemId,
        `Grouped ${dedupedCount} repeated Whisper subtitle line(s) into extended-duration entries`,
        { originalLines: parsedEntries.length, finalLines: entries.length },
      )
    }

    createLog(db, "info", "whisper", mediaItemId, `Whisper transcription completed for media item ${mediaItemId}`, {
      model,
      lineCount: entries.length,
    })

    return { success: true, entries, rawSrt, model }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const sanitized = msg.slice(0, 200)
    createLog(
      db,
      "error",
      "whisper",
      mediaItemId,
      `Whisper transcription failed for media item ${mediaItemId}: ${sanitized}`,
      {
        model,
        mediaBasename,
        error: sanitized,
      },
    )
    if (sanitized.toLowerCase().includes("download") || sanitized.toLowerCase().includes("ggml")) {
      createLog(db, "error", "whisper", null, `Whisper model download failed: ${model}`, { model })
    }
    return { success: false, error: sanitized }
  } finally {
    safeUnlink(tempMediaPath)
    safeUnlink(wavMediaPath)
    safeUnlink(expectedSrtPath)
  }
}

// Derive the audio length from the generated WAV. ffmpeg writes it as 16 kHz,
// mono, signed-16-bit PCM (see convertToWav) → 16000 * 2 * 1 = 32000 bytes/sec.
// The 44-byte canonical WAV header is subtracted. Returns 0 when unreadable.
function getWavDurationMs(wavPath: string): number {
  try {
    const bytes = fs.statSync(wavPath).size
    const dataBytes = Math.max(0, bytes - 44)
    return Math.round((dataBytes / 32000) * 1000)
  } catch {
    return 0
  }
}

function runWhisperCli(
  command: string[],
  wavDurationMs: number,
  onProgress?: WhisperTranscriptionProgress,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    let lastProgress = -1
    let latestEndMs = 0

    const emit = (p: number): void => {
      const clamped = Math.max(0, Math.min(99, p))
      if (clamped !== lastProgress) {
        lastProgress = clamped
        onProgress?.(clamped, latestEndMs, wavDurationMs)
      }
    }

    const handleChunk = (text: string): void => {
      // Primary signal: whisper-cli streams each finished segment as
      // `[hh:mm:ss.mmm --> hh:mm:ss.mmm] text`. Progress = latest end / total.
      if (wavDurationMs > 0) {
        const endMs = parseLatestSegmentEndMs(text)
        if (endMs !== null && endMs > latestEndMs) {
          latestEndMs = endMs
          emit(Math.floor((latestEndMs / wavDurationMs) * 100))
        }
      } else {
        // Fallback for builds that print an explicit `progress = N%`.
        parseProgressChunk(text, emit)
      }
    }

    proc.stdout?.on("data", (chunk) => {
      handleChunk(chunk.toString())
    })

    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString()
      stderr += text
      handleChunk(text)
    })

    proc.on("close", (code) => {
      if (code === 0) {
        // whisper-cli exits 0 on success. Do NOT scan stdout for "error:" —
        // stdout IS the transcription text, which legitimately contains words
        // like "error:" in dialogue. That heuristic caused successful 99%
        // transcriptions to be falsely rejected (and then the SRT deleted in
        // the finally block, losing hours of work). The downstream SRT file
        // existence + parse checks validate that real output was produced.
        resolve()
      } else {
        reject(new Error(stderr || `whisper-cli exited with code ${code}`))
      }
    })

    proc.on("error", (err) => reject(err))
  })
}

function parseProgressChunk(text: string, callback: (progress: number) => void): void {
  const regex = /progress\s*=\s*(\d+)%/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    callback(parseInt(match[1], 10))
  }
}

// Returns the end-timestamp (ms) of the last `[start --> end]` segment in the
// text chunk, or null if none is present.
function parseLatestSegmentEndMs(text: string): number | null {
  const regex = /-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g
  let match: RegExpExecArray | null
  let latest: number | null = null
  while ((match = regex.exec(text)) !== null) {
    const h = parseInt(match[1], 10)
    const m = parseInt(match[2], 10)
    const s = parseInt(match[3], 10)
    const ms = parseInt(match[4], 10)
    latest = h * 3600000 + m * 60000 + s * 1000 + ms
  }
  return latest
}

export function buildWhisperSubtitleName(mediaTitle: string, model: string): string {
  const safeTitle = mediaTitle.replace(/[/\\:*?"<>|]/g, " ").trim() || "Whisper subtitle"
  return `[Whisper] ${safeTitle} (${model})`
}

export function deduplicateSrtEntries(entries: SrtEntry[]): SrtEntry[] {
  if (entries.length === 0) return []

  const result: SrtEntry[] = []
  let runStart = 0
  let runText = entries[0].text

  for (let i = 1; i <= entries.length; i++) {
    const atEnd = i === entries.length
    const sameAsRun = !atEnd && entries[i].text === runText

    if (!sameAsRun) {
      const runLength = i - runStart
      if (runLength > 3) {
        const first = entries[runStart]
        const last = entries[i - 1]
        result.push({
          ...first,
          endMs: last.endMs,
          endTime: last.endTime,
          text: runText,
        })
      } else {
        for (let j = runStart; j < i; j++) {
          result.push(entries[j])
        }
      }

      if (!atEnd) {
        runStart = i
        runText = entries[i].text
      }
    }
  }

  return result.map((e, idx) => ({ ...e, id: String(idx + 1) }))
}

export { serializeSrt, parseSrt }
