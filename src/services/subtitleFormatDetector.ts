// Shared subtitle-extension helpers. Used by the format detector, library
// companion-file discovery, and the library-requests extension gates so all
// three agree on which files count as subtitles.
import { SubtitleFormat } from "../types/subtitleTypes"

// Text formats the pipeline parses/serializes natively (stored on
// subtitle.sourceFormat, which has a CHECK constraint of these three values).
const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa"] as const

// `.sub` and `.sup` are supported *input* formats but are always converted to
// SRT before they reach the stored-sourceFormat layer (see subSubtitleAdapter
// for text/VobSub .sub and pgsOcrService for .sup), so they are NOT part of
// SubtitleFormat / SUBTITLE_EXTENSIONS. They are, however, subtitle files for
// scanning/companion/listing purposes, so isSubtitleExtension() returns true
// for them.
const SUB_FILE_EXTENSIONS = [".sub", ".sup"] as const

export function subtitleExtensionOf(path: string): ".srt" | ".ass" | ".ssa" | null {
  const lower = path.toLowerCase()
  for (const ext of SUBTITLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext
  }
  return null
}

// Like subtitleExtensionOf but also recognises `.sub` / `.sup` — used where we
// surface the on-disk extension to the UI (e.g. the source-picker codec line)
// so a `.sub`/`.sup` file is shown as such, not silently folded to `.srt`.
export function subtitleFileExtensionOf(path: string): ".srt" | ".ass" | ".ssa" | ".sub" | ".sup" | null {
  const lower = path.toLowerCase()
  for (const ext of [...SUBTITLE_EXTENSIONS]) {
    if (lower.endsWith(ext)) return ext
  }
  return null
}

export function isSubFile(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith(".sub")
}

// `.sup` = PGS/HDMV bitmap subtitle (image-based, OCR'd via pgsOcrService).
export function isSupFile(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.endsWith(".sup")
}

export function isSubtitleExtension(path: string): boolean {
  return subtitleExtensionOf(path) !== null || isSubFile(path) || isSupFile(path)
}

// Detect a subtitle's operational format from its filename (preferred) and,
// when the extension is missing or unknown, a content sniff for ASS/SSA section
// headers. `.sub`/`.sup` map to "srt" because subSubtitleAdapter / pgsOcrService
// convert every .sub/.sup (text-parsed or OCR'd) into an SRT intermediate
// before it is stored — the stored sourceFormat stays one of srt/ass/ssa so the
// existing chunk/translate/export pipeline is untouched.
export function detectSubtitleFormat(filename: string, content?: string): SubtitleFormat {
  const ext = subtitleExtensionOf(filename)
  if (ext === ".srt") return "srt"
  if (ext === ".ass") return "ass"
  if (ext === ".ssa") return "ssa"
  if (isSubFile(filename) || isSupFile(filename)) return "srt"

  if (content) {
    const head = content.slice(0, 4096)
    if (/\[Script Info\]/i.test(head) || /\[Events\]/i.test(head) || /\[V4\+?\s*Styles\]/i.test(head)) {
      return "ass"
    }
  }
  return "srt"
}

// ─── Embedded image-subtitle codecs ──────────────────────────────────────────
// Embedded subtitle tracks whose payload is bitmap images, not text. VobSub /
// DVD subtitles extract as a .sub + .idx pair and are OCR'd (see
// vobSubOcrService). PGS/HDMV bitmap subtitles extract as a .sup and are OCR'd
// via pgsOcrService. Both are surfaced as image-based / OCR-required sources.
const VOBSUB_CODECS = new Set([
  "vobsub", // mkvmerge codec name
  "dvd_subtitle", // ffmpeg codec_name
])

const PGS_CODECS = new Set([
  "hdmv_pgs_subtitle", // ffmpeg codec_name
  "pgssub", // alternate codec id
  "hdmv_pgs", // alternate name
  "hdmv pgs", // mkvmerge -J `codec` display name for S_HDMV/PGS
])

export type ImageSubtitleKind = "vobsub" | "pgs" | null

export function imageSubtitleKindFromCodec(codec: string | null | undefined): ImageSubtitleKind {
  if (!codec) return null
  const c = codec.toLowerCase()
  if (VOBSUB_CODECS.has(c)) return "vobsub"
  if (PGS_CODECS.has(c)) return "pgs"
  return null
}

export function isImageSubtitleCodec(codec: string | null | undefined): boolean {
  return imageSubtitleKindFromCodec(codec) !== null
}

export function isVobSubCodec(codec: string | null | undefined): boolean {
  return imageSubtitleKindFromCodec(codec) === "vobsub"
}

export function isPgsCodec(codec: string | null | undefined): boolean {
  return imageSubtitleKindFromCodec(codec) === "pgs"
}