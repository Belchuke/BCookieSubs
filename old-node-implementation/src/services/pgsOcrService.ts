// PGS / HDMV bitmap subtitle (.sup) OCR pipeline.
//
// PGS (Presentation Graphic Stream, a.k.a. HDMV PGS) is the image-based
// subtitle format used on Blu-ray: each subtitle event is a palette-mapped
// bitmap composited onto the video at a given time. Like VobSub there is no
// text to translate directly, so to feed PGS into the existing translation
// pipeline we OCR each subtitle image with Tesseract and build a normal SRT.
//
// This service handles both embedded PGS tracks (extracted from an MKV with
// `mkvextract` to a .sup) and standalone Blu-ray .sup files sitting next to
// the media. Both arrive as the same SUP byte format.
//
// Approach:
//   1. Parse the .sup for the canvas size and per-event start timestamps by
//      walking the PES packets ("PG" sync + PTS + DTS + segment table) and
//      collecting Presentation Composition Segments that mark a new display
//      epoch with at least one composition object (= one subtitle line).
//   2. Burn the .sup subtitle stream onto a solid black canvas with ffmpeg
//      (pgssub demuxer), preserving original timestamps with -copyts so the
//      burned video's timeline matches the .sup PTS timeline. ffmpeg handles
//      PGS palette/RLE decode + compositing, so we never reimplement the
//      bitmap format ourselves. Burning the small .sup (not the multi-GB MKV)
//      keeps this fast (~10-15s for a 24-min episode).
//   3. Grab one PNG frame per event at its midpoint (subtitle guaranteed
//      visible there) from the burned video.
//   4. OCR each PNG with Tesseract, using a language derived from the source
//      language (see subtitleOcrLanguageMapper).
//   5. Build SrtEntry[] from the .sup timing + OCR text and serialize to SRT.
//
// All intermediate files live in a per-job temp dir under the OS temp folder,
// never in the media/Jellyfin folder, and are removed in a finally block. The
// caller's original .sup (user-provided external file) is NOT deleted.
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

export type PgsOcrResult = {
  srt: string
  entries: SrtEntry[]
  ocrRows: number
  emptyRows: number
}

export class PgsOcrError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PgsOcrError"
  }
}

// PGS segment types (Blu-ray HDMV PGS).
const SEG_PCS = 0x16 // Presentation Composition Segment
// const SEG_WDS = 0x17 // Window Definition Segment
// const SEG_PDS = 0x14 // Palette Definition Segment
// const SEG_ODS = 0x15 // Object Definition Segment
const SEG_END = 0x80 // End of Display Set
const COMPOSITION_STATE_EPOCH_START = 0x80

// Parsed .sup metadata. `events` carry start/end timestamps in ms, in order.
type PgsSup = {
  width: number
  height: number
  events: { startMs: number; endMs: number }[]
}

// Read a big-endian uint32 at offset.
function readU32BE(buf: Buffer, off: number): number {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]
}
function readU16BE(buf: Buffer, off: number): number {
  return (buf[off] << 8) | buf[off + 1]
}

// Parse a PGS .sup file (mkvextract SUP / Blu-ray .sup) into canvas size +
// per-event start/end times. Each "event" is one displayed subtitle line: a
// Presentation Composition Segment that starts a new epoch with ≥1 object.
// The end is the PTS of the next PCS (the following clear/update), or a 2s
// tail for the final event.
export function parsePgsSup(supPath: string): PgsSup {
  let raw: Buffer
  try {
    raw = fs.readFileSync(supPath)
  } catch (e) {
    throw new PgsOcrError(`Could not read PGS .sup file: ${String(e).slice(0, 160)}`)
  }

  let width = 0
  let height = 0
  // PCS records in order: (pts_ms, composition_state, object_count)
  const pcs: { ptsMs: number; state: number; objects: number }[] = []

  // SUP layout per PES packet: "PG"(2) + PTS(4 BE, 90kHz) + DTS(4 BE) +
  // segment_type(1) + segment_length(2 BE) + segment_data(length). A PES packet
  // may contain multiple segments back-to-back, and a display set ends with an
  // 0x80 (END) segment. We walk sequentially using segment lengths.
  let i = 0
  while (i + 13 <= raw.length) {
    if (raw[i] !== 0x50 || raw[i + 1] !== 0x47) {
      // Not a PES sync — resync one byte forward (tolerates stray padding).
      i += 1
      continue
    }
    const ptsTicks = readU32BE(raw, i + 2) // 90kHz units
    const segType = raw[i + 10]
    const segLen = readU16BE(raw, i + 11)
    const segStart = i + 13
    if (segStart + segLen > raw.length) break
    const seg = raw.subarray(segStart, segStart + segLen)

    if (segType === SEG_PCS && seg.length >= 11) {
      const w = readU16BE(seg, 0)
      const h = readU16BE(seg, 2)
      if (w > 0 && h > 0) {
        width = w
        height = h
      }
      const state = seg[7] // composition_state
      const objectCount = seg[10] // number of composition objects
      pcs.push({ ptsMs: Math.floor(ptsTicks / 90), state, objects: objectCount })
    }

    // Advance past this PES packet. PGS PES packets are self-contained: after
    // the segment table there is no trailing payload, so the next packet begins
    // right after the segment data. The END segment (0x80) closes a display set.
    i = segStart + segLen
    if (segType === SEG_END) {
      // Most writers emit one segment per PES packet; the next "PG" sync follows
      // immediately. The loop's sync check handles any gap.
    }
  }

  if (width === 0 || height === 0) {
    throw new PgsOcrError("PGS .sup is missing the presentation composition header — file may be malformed or empty")
  }

  // Build start/end pairs from epoch-start PCS that carry an object.
  const events: { startMs: number; endMs: number }[] = []
  for (let k = 0; k < pcs.length; k++) {
    const p = pcs[k]
    if (p.state !== COMPOSITION_STATE_EPOCH_START || p.objects === 0) continue
    const start = p.ptsMs
    let end = start + 2000
    for (let j = k + 1; j < pcs.length; j++) {
      const next = pcs[j].ptsMs
      if (next > start) {
        end = next
        break
      }
    }
    if (end <= start) end = start + 1000
    events.push({ startMs: start, endMs: end })
  }

  if (events.length === 0) {
    throw new PgsOcrError("PGS .sup contains no subtitle display events — file may be malformed or empty")
  }

  return { width, height, events }
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

export type PgsOcrOptions = {
  ocrLang?: string
  sourceLangHints?: (string | null | undefined)[]
  // Override the canvas (rarely needed; defaults from .sup PCS).
  width?: number
  height?: number
  onProgress?: (done: number, total: number) => void
  shouldAbort?: () => boolean
}

// OCR a PGS .sup into an SRT string + normalized entries. Throws PgsOcrError /
// TesseractUnavailableError / TesseractLangMissingError on setup failures so
// the caller can mark the job failed with a clear reason.
export function ocrPgsToSrt(supPath: string, opts: PgsOcrOptions = {}): PgsOcrResult {
  if (!fs.existsSync(supPath)) throw new PgsOcrError(`PGS .sup file not found: ${supPath}`)

  const ocrLang = opts.ocrLang
    ? opts.ocrLang
    : resolveOcrLang(...(opts.sourceLangHints ?? []))
  // Fail fast on missing tesseract / language data before doing any rendering.
  assertOcrReady(ocrLang)

  const parsed = parsePgsSup(supPath)
  const width = opts.width ?? parsed.width
  const height = opts.height ?? parsed.height
  const pairs = parsed.events

  const totalDurationSec = Math.ceil((pairs[pairs.length - 1].endMs + 1000) / 1000)
  const fps = 10 // 100ms granularity; subtitles last well over that.

  // Per-job temp dir under the OS temp folder — never in the media folder.
  const tmpRoot = path.join(os.tmpdir(), `bcookiesubs-pgs-ocr-${process.pid}-${Date.now()}`)
  fs.mkdirSync(tmpRoot, { recursive: true })
  const burnedVideo = path.join(tmpRoot, "burned.mkv")
  const framesDir = path.join(tmpRoot, "frames")
  fs.mkdirSync(framesDir, { recursive: true })

  try {
    // 1) Burn the PGS subtitle stream onto a black canvas for the full
    //    duration, preserving original timestamps (-copyts) so the burned
    //    timeline matches the .sup PTS timeline and event midpoints line up.
    const burn = runFfmpeg(
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-copyts", "-fflags", "+genpts",
        "-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}`,
        "-i", supPath,
        "-filter_complex", "[0:v][1:s]overlay=0:0",
        "-t", String(totalDurationSec),
        "-an",
        "-c:v", "ffv1", // lossless, frame-accurate seeking for the grabs
        burnedVideo,
      ],
      600_000, // full-episode burn can take ~15-30s; allow generous headroom
      "ffmpeg burn PGS",
    )
    if (!burn.ok) {
      throw new PgsOcrError(
        `Failed to render PGS subtitle images with ffmpeg. ${burn.err}. Ensure ffmpeg was built with PGS (pgssub) demuxer support and that the .sup is valid.`,
      )
    }

    // 2) Grab + OCR one frame per event at its midpoint (subtitle guaranteed
    //    visible there).
    const entries: SrtEntry[] = []
    let emptyRows = 0
    for (let i = 0; i < pairs.length; i++) {
      if (opts.shouldAbort?.()) break
      const { startMs, endMs } = pairs[i]
      const midSec = ((startMs + endMs) / 2) / 1000
      const framePath = path.join(framesDir, `f_${String(i).padStart(6, "0")}.png`)

      const grab = runFfmpeg(
        [
          "-y", "-hide_banner", "-loglevel", "error",
          "-ss", midSec.toFixed(3),
          "-i", burnedVideo,
          "-frames:v", "1",
          "-q:v", "2",
          framePath,
        ],
        30_000,
        "ffmpeg frame grab",
      )
      if (!grab.ok || !fs.existsSync(framePath)) {
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
      throw new PgsOcrError(
        `PGS OCR produced no text rows (0/${pairs.length} events recognised). Check the Tesseract language pack (${ocrLang}) and the subtitle image quality.`,
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
export { TesseractUnavailableError, TesseractLangMissingError, FALLBACK_OCR_LANG }