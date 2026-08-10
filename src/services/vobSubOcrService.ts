// VobSub (.sub + .idx) OCR pipeline.
//
// VobSub `.sub` files are image-based: each subtitle event is a small bitmap
// (RLE-encoded inside MPEG PES packets) and the sibling `.idx` file carries the
// timing, canvas size, palette and language metadata. There is no text to
// translate directly, so to feed VobSub into the existing translation pipeline
// we OCR each subtitle image with Tesseract and build a normal SRT (the
// "intermediate normalized text subtitle" called for by the project task).
//
// Approach (Option A from the task notes — ffmpeg renders images, Tesseract
// OCRs them):
//   1. Parse the .idx for the canvas size and per-event start timestamps.
//   2. Burn the VobSub subtitle stream onto a solid black canvas with ffmpeg
//      (reading the .idx via ffmpeg's vobsub demuxer), writing a PNG image
//      sequence (one file per frame) for the full duration. PNG (not ffv1) at a
//      low fps keeps the encode fast for mostly-black frames; the burn timeout
//      scales with content length so a long track can't hit a fixed deadline.
//   3. Pick one PNG per event by time index (the frame at floor(midpoint*fps),
//      which always lands inside the event since events are clamped to >=1s) —
//      no per-event ffmpeg seek calls.
//   4. OCR each PNG with Tesseract, using a language derived from the source
//      language (see subtitleOcrLanguageMapper).
//   5. Build SrtEntry[] from the .idx timing + OCR text and serialize to SRT.
//
// All intermediate files live in a per-job temp dir under the OS temp folder,
// never in the media/Jellyfin folder, and are removed in a finally block. The
// caller's original .sub/.idx (user-provided external files) are NOT deleted.
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import { SrtEntry, serializeSrt, msToSrtTime } from "./srtService"
import {
  assertOcrReady,
  ocrImageFile,
  cleanSubtitleOcrText,
  TesseractUnavailableError,
  TesseractLangMissingError,
} from "./tesseractOcrService"
import { resolveOcrLang, FALLBACK_OCR_LANG } from "./subtitleOcrLanguageMapper"

export type VobSubOcrResult = {
  srt: string
  entries: SrtEntry[]
  ocrRows: number
  emptyRows: number
}

export class VobSubOcrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VobSubOcrError"
  }
}

// Parsed .idx metadata. `events` are start timestamps in ms, in file order.
type VobSubIdx = {
  width: number
  height: number
  events: { startMs: number }[]
}

function parseIdxTimestampMs(line: string): number | null {
  // .idx lines: "timestamp: 00:01:23:456" or "timestamp: 00:01:23.456"
  const m = line.match(/timestamp:\s*(\d+):(\d{2}):(\d{2})[:.](\d{1,3})/i)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  const ms = parseInt(m[4].padEnd(3, "0"), 10)
  return h * 3_600_000 + mm * 60_000 + s * 1000 + ms
}

export function parseVobSubIdx(idxPath: string): VobSubIdx {
  let raw: string
  try {
    raw = fs.readFileSync(idxPath, "utf-8")
  } catch (e) {
    throw new VobSubOcrError(`Could not read VobSub .idx file: ${String(e).slice(0, 160)}`)
  }

  let width = 720
  let height = 480
  const sizeMatch = raw.match(/size:\s*(\d+)x(\d+)/i)
  if (sizeMatch) {
    width = parseInt(sizeMatch[1], 10)
    height = parseInt(sizeMatch[2], 10)
  }

  const events: { startMs: number }[] = []
  for (const line of raw.split(/\r?\n/)) {
    const ms = parseIdxTimestampMs(line)
    if (ms !== null) events.push({ startMs: ms })
  }

  if (events.length === 0) {
    throw new VobSubOcrError("VobSub .idx contains no subtitle timestamps — file may be malformed or empty")
  }

  return { width, height, events }
}

// Compute an end time for each event. The .idx only records start times, so the
// end is the next event's start; the last event gets a 2s tail. Overlapping or
// zero-length events are clamped to a 1s minimum so the SRT is valid.
function buildStartEndPairs(events: { startMs: number }[]): { startMs: number; endMs: number }[] {
  const out: { startMs: number; endMs: number }[] = []
  for (let i = 0; i < events.length; i++) {
    const start = events[i].startMs
    const next = events[i + 1]?.startMs
    let end = next != null && next > start ? next : start + 2000
    if (end <= start) end = start + 1000
    out.push({ startMs: start, endMs: end })
  }
  return out
}

function runFfmpeg(args: string[], timeoutMs: number, label: string): { ok: boolean; err: string } {
  try {
    const r = spawnSync("ffmpeg", args, { encoding: "utf-8", timeout: timeoutMs })
    if (r.status === 0 && !r.error) return { ok: true, err: "" }
    const reason = (r.stderr || r.error?.message || "").split(/\r?\n/).find((l) => l.trim())?.slice(0, 200) || "ffmpeg exited non-zero"
    return { ok: false, err: `${label}: ${reason}` }
  } catch (e) {
    return { ok: false, err: `${label}: ${String(e).slice(0, 160)}` }
  }
}

function ffprobeAvailable(): boolean {
  const r = spawnSync("ffprobe", ["-version"], { encoding: "utf-8", timeout: 8_000 })
  return r.status === 0 && !r.error
}

export type VobSubOcrOptions = {
  ocrLang?: string
  // Source language hint(s) used to derive the Tesseract language when ocrLang
  // is not explicitly set. Track language is usually the best signal.
  sourceLangHints?: (string | null | undefined)[]
  // Override the canvas (rarely needed; defaults from .idx).
  width?: number
  height?: number
  // Progress callback: (done, total). Not async; fire-and-forget logging.
  onProgress?: (done: number, total: number) => void
  // Allow the caller to abort between images. When it returns true, OCR stops
  // early and whatever has been produced so far is returned.
  shouldAbort?: () => boolean
}

// OCR a VobSub .sub + .idx pair into an SRT string + normalized entries.
// Throws VobSubOcrError / TesseractUnavailableError / TesseractLangMissingError
// on setup failures so the caller can mark the job failed with a clear reason.
export function ocrVobSubToSrt(subPath: string, idxPath: string, opts: VobSubOcrOptions = {}): VobSubOcrResult {
  if (!fs.existsSync(subPath)) throw new VobSubOcrError(`VobSub .sub file not found: ${subPath}`)
  if (!fs.existsSync(idxPath)) throw new VobSubOcrError(`VobSub .idx file not found: ${idxPath}`)

  const ocrLang = opts.ocrLang
    ? opts.ocrLang
    : resolveOcrLang(...(opts.sourceLangHints ?? []))
  // Fail fast on missing tesseract / language data before doing any rendering.
  assertOcrReady(ocrLang)

  const parsed = parseVobSubIdx(idxPath)
  const width = opts.width ?? parsed.width
  const height = opts.height ?? parsed.height
  const pairs = buildStartEndPairs(parsed.events)

  // 2 fps is plenty for OCR: a frame every 500ms, and events are clamped to
  // >=1s, so the frame at floor(midpoint*fps) always lands inside the event.
  // Low fps keeps the rendered frame count (and the burn's runtime/file count)
  // small relative to the movie length.
  const fps = 2
  const totalDurationSec = Math.ceil((pairs[pairs.length - 1].endMs + 1000) / 1000)

  // Per-job temp dir under the OS temp folder — never in the media folder.
  const tmpRoot = path.join(os.tmpdir(), `bcookiesubs-vobsub-ocr-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpRoot, { recursive: true })
  const framesDir = path.join(tmpRoot, "frames")
  fs.mkdirSync(framesDir, { recursive: true })

  // Burn timeout scales with content length so a long movie can't hit a fixed
  // deadline (the original 5-min cap timed out with ETIMEDOUT on long tracks).
  // 3s of render budget per second of video is generous for a 2fps PNG encode.
  const burnTimeoutMs = Math.max(300_000, totalDurationSec * 3000)

  try {
    // 1) Burn the VobSub subtitle stream onto a black canvas for the full
    //    duration, writing a PNG image sequence (one file per frame). ffmpeg
    //    reads VobSub via the .idx (vobsub demuxer) and the overlay renders each
    //    image subtitle with its own palette/alpha. PNG (not ffv1) encodes the
    //    mostly-black frames fast, and an image sequence lets us pick frames by
    //    index — no per-event ffmpeg seek calls.
    const burn = runFfmpeg(
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}`,
        "-i", idxPath,
        "-filter_complex", "[0:v][1:s]overlay=0:0",
        "-t", String(totalDurationSec),
        "-an",
        path.join(framesDir, "f_%06d.png"),
      ],
      burnTimeoutMs,
      "ffmpeg burn VobSub",
    )
    if (!burn.ok) {
      throw new VobSubOcrError(
        `Failed to render VobSub subtitle images with ffmpeg. ${burn.err}. Ensure ffmpeg supports the vobsub demuxer and that the .idx/.sub pair is valid.`,
      )
    }

    // 2) Pick + OCR one frame per event at its midpoint (subtitle guaranteed
    //    visible there). Frames are pre-rendered, so this is just a file lookup
    //    by time index + a Tesseract call — no ffmpeg per event.
    const allFrames = fs.readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort()
    if (allFrames.length === 0) {
      throw new VobSubOcrError(
        "ffmpeg produced no rendered frames. Ensure ffmpeg supports the vobsub demuxer and that the .idx/.sub pair is valid.",
      )
    }
    const entries: SrtEntry[] = []
    let emptyRows = 0
    for (let i = 0; i < pairs.length; i++) {
      if (opts.shouldAbort?.()) break
      const { startMs, endMs } = pairs[i]
      const midSec = ((startMs + endMs) / 2) / 1000
      // floor (not round) biases toward the event start, so the chosen frame is
      // always within [start, midpoint] — never the next event's boundary.
      const fi = Math.min(allFrames.length - 1, Math.max(0, Math.floor(midSec * fps)))
      const framePath = path.join(framesDir, allFrames[fi])
      if (!fs.existsSync(framePath)) {
        // One bad frame shouldn't kill the whole OCR; record empty and continue.
        emptyRows++
        continue
      }

      let text = ""
      try {
        // psm 6 = "Assume a single uniform block of text" — suits a subtitle
        // line on a solid black background.
        text = cleanSubtitleOcrText(ocrImageFile(framePath, { lang: ocrLang, psm: 6 }))
      } catch {
        emptyRows++
        continue
      }
      if (!text) {
        emptyRows++
        continue
      }

      entries.push({
        id: String(entries.length + 1),
        startMs,
        endMs,
        startTime: msToSrtTime(startMs),
        endTime: msToSrtTime(endMs),
        text,
      })
      opts.onProgress?.(entries.length, pairs.length)
    }

    if (entries.length === 0) {
      throw new VobSubOcrError(
        `VobSub OCR produced no text rows (0/${pairs.length} events recognised). Check the Tesseract language pack (${ocrLang}) and the subtitle image quality.`,
      )
    }

    const srt = serializeSrt(entries)
    return { srt, entries, ocrRows: entries.length, emptyRows }
  } finally {
    // Always clean the temp dir, even on failure/abort — never leak OCR files.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

// Re-exported so callers can surface a single clear error without importing the
// tesseract service directly.
export { TesseractUnavailableError, TesseractLangMissingError, FALLBACK_OCR_LANG, ffprobeAvailable }