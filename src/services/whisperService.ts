import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn, type ChildProcess } from "child_process"
import axios from "axios"
import Database from "better-sqlite3"
import { createLog } from "../repositories/logRepository"
import { getConfig } from "../repositories/configRepository"
import { msToSrtTime, parseSrt, SrtEntry, serializeSrt } from "./srtService"

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

function convertToWav(inputPath: string, outputPath: string, startMs = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["-nostats", "-loglevel", "error", "-y"]
    // Seek-trim from startMs (used by resume: only the tail past the checkpoint is transcribed).
    // Placed before -i for a fast+accurate seek, then re-encoded to 16 kHz mono as usual.
    if (startMs > 0) args.push("-ss", String(startMs / 1000))
    args.push("-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outputPath)
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
  // Returned when the run was aborted (Stop/preempt): the caller persists the captured segments
  // as a checkpoint and returns without finalizing. `ms` is the end-time of the last fully
  // streamed segment — the point resume seek-trims from.
  | { success: false; aborted: true; checkpoint: { entries: SrtEntry[]; ms: number } }

export type WhisperSegment = { startMs: number; endMs: number; text: string }

// Streaming parser for whisper-cli's stdout. Each finished segment is printed as
// `[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text\n` with fflush per segment, so we capture segments
// incrementally rather than waiting for the .srt file (which whisper-cli only writes once, at the
// very end). A segment is only "committed" once the NEXT header arrives — that guarantees it was
// fully flushed. The in-progress `current` segment (no following header yet) is dropped on abort,
// so the checkpoint never contains a half-streamed line; it gets re-transcribed on resume.
//
// Each character is sliced out of the buffer exactly once, so total work is O(n) over the whole
// transcription (not O(n^2) despite re-running the regex per chunk).
class SegmentSink {
  private buffer = ""
  private segments: WhisperSegment[] = []
  private current: WhisperSegment | null = null

  feed(text: string): void {
    this.buffer += text
    // Non-global regex: find the first unprocessed header, handle it, then loop again on the
    // remainder. lastIndex is irrelevant for a non-global regex.
    const headerRe = /\[(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})\]/
    let m: RegExpExecArray | null
    while ((m = headerRe.exec(this.buffer)) !== null) {
      const before = this.buffer.slice(0, m.index)
      if (this.current) {
        this.current.text += before
        this.segments.push(this.current)
      }
      // Text before the very first header is the whisper banner — discard it.
      this.current = {
        startMs: tsToMs(m[1], m[2], m[3], m[4]),
        endMs: tsToMs(m[5], m[6], m[7], m[8]),
        text: "",
      }
      this.buffer = this.buffer.slice(m.index + m[0].length)
    }
    // Remaining buffer is the in-progress segment's text-so-far; it stays uncommitted until the
    // next header arrives (or the stream ends — but on abort we drop it regardless).
  }

  getSegments(): WhisperSegment[] {
    return this.segments.map((s) => ({ ...s }))
  }

  get lastEndMs(): number {
    if (this.segments.length > 0) return this.segments[this.segments.length - 1].endMs
    return this.current?.endMs ?? 0
  }
}

function tsToMs(h: string, m: string, s: string, ms: string): number {
  return (
    parseInt(h, 10) * 3600000 +
    parseInt(m, 10) * 60000 +
    parseInt(s, 10) * 1000 +
    parseInt(ms.padEnd(3, "0"), 10)
  )
}

// Handle owned by the worker for the duration of one transcription. `abort()` kills the running
// whisper-cli so Stop/preempt take effect immediately instead of waiting for the process to
// finish. The sink accumulates the checkpoint.
export type WhisperRunHandle = {
  aborted: boolean
  proc: ChildProcess | null
  sink: SegmentSink
  abort: () => void
}

export function createWhisperRunHandle(): WhisperRunHandle {
  const handle: WhisperRunHandle = {
    aborted: false,
    proc: null,
    sink: new SegmentSink(),
    abort: () => {
      if (handle.aborted) return
      handle.aborted = true
      const proc = handle.proc
      if (proc) {
        try {
          proc.kill("SIGTERM")
        } catch {
          /* already gone */
        }
        // Force-kill fallback in case whisper-cli doesn't honor SIGTERM promptly.
        setTimeout(() => {
          try {
            proc.kill("SIGKILL")
          } catch {
            /* already exited */
          }
        }, 2000).unref()
      }
    },
  }
  return handle
}

export async function transcribeMediaWithWhisper(
  db: Database.Database,
  mediaPath: string,
  mediaItemId: number,
  overrideModel?: string,
  onProgress?: WhisperTranscriptionProgress,
  displayName?: string,
  opts?: { handle?: WhisperRunHandle | null; resumeMs?: number; fullDurationMs?: number; resumeEntries?: SrtEntry[] },
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

  const handle = opts?.handle ?? null
  const resumeMs = Math.max(0, Math.round(opts?.resumeMs ?? 0))
  const fullDurationMs = Math.max(0, Math.round(opts?.fullDurationMs ?? 0))
  const resumeEntries = opts?.resumeEntries ?? []
  const abortedResult = (): WhisperTranscriptionResult => ({
    success: false,
    aborted: true,
    checkpoint: { entries: resumeEntries, ms: resumeMs },
  })

  const mediaBasename = path.basename(mediaPath)
  const tempDir = getWhisperTempDir()
  const tempMediaPath = path.join(tempDir, `${Date.now()}-${mediaBasename}`)
  const wavMediaPath = `${tempMediaPath}.wav`
  const expectedSrtPath = `${wavMediaPath}.srt`
  // Resume runs whisper-cli on the seek-trimmed tail; it gets its own wav/srt paths.
  const partWavPath = resumeMs > 0 ? `${tempMediaPath}.part.wav` : null
  const partSrtPath = partWavPath ? `${partWavPath}.srt` : null

  createLog(db, "info", "whisper", mediaItemId, `Whisper transcription queued for media item ${mediaItemId}`, {
    model,
    mediaBasename,
    useCuda,
    resumeMs,
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
      resumeMs,
    })

    createLog(db, "info", "whisper", mediaItemId, `Converting media to WAV for Whisper`, { mediaBasename, resumeMs })
    // Fresh run converts the whole media; resume converts only the tail past the checkpoint.
    if (resumeMs > 0 && partWavPath) {
      await convertToWav(tempMediaPath, partWavPath, resumeMs)
    } else {
      await convertToWav(tempMediaPath, wavMediaPath)
    }
    if (handle?.aborted) return abortedResult()

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
    if (handle?.aborted) return abortedResult()

    const flags = ["-osrt", "-pp", "-sow", "true", "-ml", String(timestampsLength), useCuda ? undefined : "-ng"].filter(
      (f): f is string => f !== undefined,
    )

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

    if (resumeMs > 0 && partWavPath && partSrtPath) {
      // ---- Resume: transcribe only the tail past the checkpoint, then merge. ----
      const partDurationMs = getWavDurationMs(partWavPath)
      // Map the tail-relative progress whisper-cli reports onto the whole-media scale.
      const partOnProgress: WhisperTranscriptionProgress = (p, posMs, durMs) => {
        const overallPos = resumeMs + posMs
        const overallDur = fullDurationMs || resumeMs + durMs
        const overallPct = overallDur > 0 ? Math.floor((overallPos / overallDur) * 100) : p
        onProgressWithLog(overallPct, overallPos, overallDur)
      }

      const command = [cliPath, ...flags, "-l", "auto", "-m", modelPath, "-f", partWavPath]
      createLog(db, "info", "whisper", mediaItemId, `Running whisper-cli (resume from ${resumeMs}ms)`, {
        command: command.map(escapeShellArg).join(" "),
      })

      // Fresh sink for the tail so the in-progress `current` of the original run
      // doesn't bleed into the new checkpoint if this run is itself aborted.
      const partSink = new SegmentSink()
      const runResult = await runWhisperCli(command, partDurationMs, partOnProgress, handle, partSink)
      if (handle?.aborted || runResult.aborted) {
        const partEntries = segmentsToEntries(partSink.getSegments(), resumeMs)
        const checkpointMs = resumeMs + partSink.lastEndMs
        createLog(
          db,
          "info",
          "whisper",
          mediaItemId,
          `Whisper transcription paused during resume at ${checkpointMs}ms; will resume from there`,
          { resumeMs, checkpointMs, tailSegments: partEntries.length },
        )
        // New checkpoint = the already-complete prefix + the tail's committed segments.
        return {
          success: false,
          aborted: true,
          checkpoint: { entries: [...resumeEntries, ...partEntries], ms: checkpointMs },
        }
      }

      // Tail produced no speech (e.g. closing silence) — the prefix is the whole thing.
      let partEntries: SrtEntry[] = []
      if (fs.existsSync(partSrtPath)) {
        partEntries = parseSrt(fs.readFileSync(partSrtPath, "utf-8")).map((e) => offsetEntry(e, resumeMs))
      }
      const merged = deduplicateSrtEntries([...resumeEntries, ...partEntries])
      return { success: true, entries: merged, rawSrt: serializeSrt(merged), model }
    }

    // ---- Fresh run. ----
    const wavDurationMs = getWavDurationMs(wavMediaPath)
    const command = [cliPath, ...flags, "-l", "auto", "-m", modelPath, "-f", wavMediaPath]
    createLog(db, "info", "whisper", mediaItemId, `Running whisper-cli`, {
      command: command.map(escapeShellArg).join(" "),
    })

    const runResult = await runWhisperCli(command, wavDurationMs, onProgressWithLog, handle)
    if (handle?.aborted || runResult.aborted) {
      const entries = segmentsToEntries(handle ? handle.sink.getSegments() : [])
      const checkpointMs = handle ? handle.sink.lastEndMs : 0
      createLog(
        db,
        "info",
        "whisper",
        mediaItemId,
        `Whisper transcription paused at ${checkpointMs}ms; will resume from there`,
        { checkpointMs, segments: entries.length },
      )
      return { success: false, aborted: true, checkpoint: { entries, ms: checkpointMs } }
    }

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
    if (partWavPath) safeUnlink(partWavPath)
    if (partSrtPath) safeUnlink(partSrtPath)
  }
}

// Convert captured stdout segments into SrtEntry rows, optionally shifted by an offset (resume:
// tail timestamps are relative to the part start, so they're offset by the checkpoint ms).
function segmentsToEntries(segments: WhisperSegment[], offsetMs = 0): SrtEntry[] {
  return segments.map((s, i) => {
    const startMs = Math.max(0, s.startMs + offsetMs)
    const endMs = Math.max(startMs + 1, s.endMs + offsetMs)
    return {
      id: String(i + 1),
      startMs,
      endMs,
      startTime: msToSrtTime(startMs),
      endTime: msToSrtTime(endMs),
      text: s.text,
    }
  })
}

function offsetEntry(entry: SrtEntry, offsetMs: number): SrtEntry {
  if (offsetMs === 0) return entry
  const startMs = Math.max(0, entry.startMs + offsetMs)
  const endMs = Math.max(startMs + 1, entry.endMs + offsetMs)
  return {
    ...entry,
    startMs,
    endMs,
    startTime: msToSrtTime(startMs),
    endTime: msToSrtTime(endMs),
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
  handle?: WhisperRunHandle | null,
  sink?: SegmentSink,
): Promise<{ aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (handle) handle.proc = proc
    const segmentSink = sink ?? handle?.sink ?? null

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
      // Capture streamed segments for the checkpoint (used only on abort).
      if (segmentSink) segmentSink.feed(text)
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
      if (handle?.aborted) {
        // Stop/preempt killed the process. Resolve as aborted so the caller can
        // persist the checkpoint; do NOT reject (that would read as a failure)
        // and do NOT read the .srt file (it was never written).
        resolve({ aborted: true })
        return
      }
      if (code === 0) {
        // whisper-cli exits 0 on success. Do NOT scan stdout for "error:" —
        // stdout IS the transcription text, which legitimately contains words
        // like "error:" in dialogue. That heuristic caused successful 99%
        // transcriptions to be falsely rejected (and then the SRT deleted in
        // the finally block, losing hours of work). The downstream SRT file
        // existence + parse checks validate that real output was produced.
        resolve({ aborted: false })
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
