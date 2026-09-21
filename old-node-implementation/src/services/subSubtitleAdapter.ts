// .sub subtitle adapter — the entry point for importing/building SRT from .sub
// files. .sub is an ambiguous extension: it can be text-based (MicroDVD or
// SubViewer) or image-based (VobSub, paired with a .idx). This module detects
// which kind a given .sub is and converts it into SRT text (the intermediate
// normalized subtitle the translation pipeline consumes), recording whether the
// text came from parsing or OCR.
//
// Detection rules (see detectSubKind):
//   - A sibling .idx next to the .sub  -> VobSub (image-based, OCR required).
//   - Otherwise, sniff the content for MicroDVD / SubViewer headers -> text.
//   - If neither matches, the format is unsupported -> throw a clear error.
//
// Text parsing supports:
//   - MicroDVD : {startFrame}{endFrame}text  (frames -> ms via FPS)
//   - SubViewer: HH:MM:SS.cc,HH:MM:SS.cc then text lines
//
// FPS for MicroDVD: an embedded {1}{1}fps header wins; otherwise ffprobe the
// associated media file; otherwise an explicit override; otherwise a safe
// default of 23.976 (with a warning surfaced to the caller). We do NOT silently
// pick 25 — the project has no existing FPS convention, so 23.976 (the most
// common film rate) is the conservative default and the caller is told.
import * as fs from "fs"
import * as path from "path"
import { spawnSync } from "child_process"
import { SrtEntry, serializeSrt, msToSrtTime } from "./srtService"
import { ocrVobSubToSrt, VobSubOcrError } from "./vobSubOcrService"
import { FALLBACK_OCR_LANG } from "./subtitleOcrLanguageMapper"

export type SubKind = "vobsub" | "text-microdvd" | "text-subviewer" | "unsupported"

export type SubToSrtResult = {
  srt: string
  entries: SrtEntry[]
  // "parsed" for text .sub, "ocr" for VobSub image .sub.
  textOrigin: "ocr" | "parsed"
  originalSourceFormat: "sub"
  kind: SubKind
  // FPS used for MicroDVD (null for SubViewer/VobSub).
  fpsUsed: number | null
  // OCR-only diagnostics.
  ocrRows?: number
  emptyRows?: number
  // True when MicroDVD FPS could not be detected/overridden and the 23.976
  // default was assumed — surfaced as a warning by the caller.
  fpsAssumedDefault?: boolean
}

export class SubParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SubParseError"
  }
}

export const DEFAULT_MICRODVD_FPS = 23.976

// Build a well-formed SrtEntry (with SRT timing strings) from ms + text. The
// adapters produce entries from frame/timestamp math, then serializeSrt renders
// them; startTime/endTime are populated so the entries are reusable elsewhere.
function makeSrtEntry(id: number, startMs: number, endMs: number, text: string): SrtEntry {
  const safeEnd = endMs > startMs ? endMs : startMs + 1000
  return {
    id: String(id),
    startMs,
    endMs: safeEnd,
    startTime: msToSrtTime(startMs),
    endTime: msToSrtTime(safeEnd),
    text,
  }
}

// Given /path/movie.sub, return /path/movie.idx if it exists, else null.
export function findSiblingIdx(subPath: string): string | null {
  const idx = subPath.replace(/\.sub$/i, ".idx")
  try {
    if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx
  } catch {
    /* ignore */
  }
  return null
}

// Detect the .sub kind from the sibling .idx (VobSub) or a content sniff.
export function detectSubKind(subPath: string, content?: string): SubKind {
  if (findSiblingIdx(subPath)) return "vobsub"
  const raw = content ?? safeReadHead(subPath)
  if (raw == null) return "unsupported"
  const firstLines = raw.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 5).join("\n")
  if (/^\{\d+\}\{\d+\}/.test(firstLines.trim())) return "text-microdvd"
  // SubViewer timing line: HH:MM:SS.cc,HH:MM:SS.cc
  if (/^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3},\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/m.test(firstLines)) {
    return "text-subviewer"
  }
  return "unsupported"
}

function safeReadHead(subPath: string): string | null {
  try {
    const fd = fs.openSync(subPath, "r")
    const buf = Buffer.alloc(4096)
    const n = fs.readSync(fd, buf, 0, 4096, 0)
    fs.closeSync(fd)
    return buf.slice(0, n).toString("utf-8")
  } catch {
    return null
  }
}

// Parse a fraction like "24000/1001" -> number. Returns null on garbage.
function parseFrameRate(rate: string | null | undefined): number | null {
  if (!rate) return null
  const m = rate.trim().match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
  if (!m) {
    const n = parseFloat(rate)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const num = parseFloat(m[1])
  const den = parseFloat(m[2])
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return num / den
}

// Probe the video's frame rate with ffprobe. Tries r_frame_rate (container
// timing base) then avg_frame_rate. Returns null if ffprobe is missing or the
// rate can't be determined.
export function detectMediaFps(videoPath: string | null | undefined): number | null {
  if (!videoPath) return null
  try {
    const r = spawnSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0", videoPath],
      { encoding: "utf-8", timeout: 15_000 },
    )
    if (r.status !== 0 || r.error || !r.stdout) return null
    const data = JSON.parse(r.stdout) as { streams?: any[] }
    const stream = data.streams?.[0]
    if (!stream) return null
    return parseFrameRate(stream.r_frame_rate) ?? parseFrameRate(stream.avg_frame_rate)
  } catch {
    return null
  }
}

// MicroDVD: {startFrame}{endFrame}text. The first event is often a metadata
// header like {1}{1}23.976 (the FPS) or {DEFAULT}{}{...}; those are skipped.
function parseMicroDvd(raw: string, fps: number): SrtEntry[] {
  const entries: SrtEntry[] = []
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/)
    if (!m) continue
    const startFrame = parseInt(m[1], 10)
    const endFrame = parseInt(m[2], 10)
    let text = m[3] ?? ""
    // {DEFAULT}{}{...} global style header — not a subtitle event.
    if (/^\{DEFAULT\}/i.test(line)) continue
    // {1}{1}NN — common FPS header; not a subtitle.
    if (startFrame === 1 && endFrame === 1) continue
    if (text.trim() === "") continue
    // MicroDVD uses | for line breaks; normalise to SRT \n.
    text = text.replace(/\|/g, "\n")
    const startMs = Math.round((startFrame / fps) * 1000)
    const endMs = Math.round((endFrame / fps) * 1000)
    entries.push(makeSrtEntry(entries.length + 1, startMs, endMs, text))
  }
  return entries
}

// SubViewer: a timing line "HH:MM:SS.cc,HH:MM:SS.cc" followed by one or more
// text lines until a blank line. Optional [INFORMATION]/[SUBTITLE] headers are
// skipped.
function subviewerTimeToMs(ts: string): number | null {
  const m = ts.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  const frac = parseInt(m[4].padEnd(3, "0"), 10)
  return h * 3_600_000 + mm * 60_000 + s * 1000 + frac
}

function parseSubViewer(raw: string): SrtEntry[] {
  const entries: SrtEntry[] = []
  const lines = raw.split(/\r?\n/)
  let i = 0
  // Skip [INFORMATION] / [SUBTITLE] / [COLF] header blocks until the first
  // timing line is reached.
  while (i < lines.length && !/^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3},/.test(lines[i].trim())) {
    i++
  }
  while (i < lines.length) {
    const timeLine = lines[i].trim()
    const tm = timeLine.match(/^(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}),(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})$/)
    if (!tm) {
      i++
      continue
    }
    const startMs = subviewerTimeToMs(tm[1])
    const endMs = subviewerTimeToMs(tm[2])
    i++
    const textLines: string[] = []
    while (i < lines.length && lines[i].trim() !== "" && !/^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3},/.test(lines[i].trim())) {
      textLines.push(lines[i])
      i++
    }
    // Skip the blank separator.
    while (i < lines.length && lines[i].trim() === "") i++
    if (startMs == null || endMs == null) continue
    const text = textLines.join("\n").replace(/\[br\]/gi, "\n").trim()
    if (text === "") continue
    entries.push(makeSrtEntry(entries.length + 1, startMs, endMs, text))
  }
  return entries
}

export type ConvertSubOptions = {
  // Associated media file (companion video) for FPS detection (MicroDVD).
  videoPath?: string | null
  // Explicit FPS override (e.g. from a UI selector). Wins over ffprobe+default.
  fpsOverride?: number | null
  // OCR language for VobSub. If omitted, derived from sourceLangHints.
  ocrLang?: string | null
  sourceLangHints?: (string | null | undefined)[]
  shouldAbort?: () => boolean
  onProgress?: (done: number, total: number) => void
}

// Top-level: convert any supported .sub into SRT text + normalized entries.
// Throws SubParseError (text) or VobSubOcrError/Tesseract* (OCR) on failure.
export function convertSubToSrt(subPath: string, opts: ConvertSubOptions = {}): SubToSrtResult {
  if (!fs.existsSync(subPath)) throw new SubParseError(`.sub file not found: ${subPath}`)

  const kind = detectSubKind(subPath)

  if (kind === "vobsub") {
    const idx = findSiblingIdx(subPath)!
    const ocr = ocrVobSubToSrt(subPath, idx, {
      ocrLang: opts.ocrLang ?? undefined,
      sourceLangHints: opts.sourceLangHints,
      shouldAbort: opts.shouldAbort,
      onProgress: opts.onProgress,
    })
    return {
      srt: ocr.srt,
      entries: ocr.entries,
      textOrigin: "ocr",
      originalSourceFormat: "sub",
      kind,
      fpsUsed: null,
      ocrRows: ocr.ocrRows,
      emptyRows: ocr.emptyRows,
    }
  }

  // Text-based .sub
  let raw: string
  try {
    raw = fs.readFileSync(subPath, "utf-8")
  } catch (e) {
    throw new SubParseError(`Could not read .sub file: ${String(e).slice(0, 160)}`)
  }

  const detected = detectSubKind(subPath, raw)
  if (detected === "unsupported") {
    throw new SubParseError(
      `Unsupported .sub format: not VobSub (no .idx), MicroDVD, or SubViewer. Cannot parse "${path.basename(subPath)}".`,
    )
  }

  if (detected === "text-subviewer") {
    const entries = parseSubViewer(raw)
    if (entries.length === 0) throw new SubParseError("SubViewer .sub parsed but contained no subtitle rows")
    return {
      srt: serializeSrt(entries),
      entries,
      textOrigin: "parsed",
      originalSourceFormat: "sub",
      kind: "text-subviewer",
      fpsUsed: null,
    }
  }

  // MicroDVD — needs FPS.
  let fps = opts.fpsOverride ?? null
  if (fps == null) fps = detectMediaFps(opts.videoPath ?? null)
  const fpsFromDefault = fps == null
  if (fps == null) fps = DEFAULT_MICRODVD_FPS
  const entries = parseMicroDvd(raw, fps)
  if (entries.length === 0) throw new SubParseError("MicroDVD .sub parsed but contained no subtitle rows")

  return {
    srt: serializeSrt(entries),
    entries,
    textOrigin: "parsed",
    originalSourceFormat: "sub",
    kind: "text-microdvd",
    fpsUsed: fps,
    fpsAssumedDefault: fpsFromDefault,
  }
}