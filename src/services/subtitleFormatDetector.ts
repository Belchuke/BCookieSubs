// Shared subtitle-extension helpers. Used by the format detector, library
// companion-file discovery, and the library-requests extension gates so all
// three agree on which files count as subtitles.
import { SubtitleFormat } from "../types/subtitleTypes"

const SUBTITLE_EXTENSIONS = [".srt", ".ass", ".ssa"] as const

export function subtitleExtensionOf(path: string): ".srt" | ".ass" | ".ssa" | null {
  const lower = path.toLowerCase()
  for (const ext of SUBTITLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext
  }
  return null
}

export function isSubtitleExtension(path: string): boolean {
  return subtitleExtensionOf(path) !== null
}

// Detect a subtitle's format from its filename (preferred) and, when the
// extension is missing or unknown, a content sniff for ASS/SSA section headers.
// SSA is treated like ASS internally for parsing; the original extension
// decides whether export writes `.ssa` vs `.ass`.
export function detectSubtitleFormat(filename: string, content?: string): SubtitleFormat {
  const ext = subtitleExtensionOf(filename)
  if (ext === ".srt") return "srt"
  if (ext === ".ass") return "ass"
  if (ext === ".ssa") return "ssa"

  if (content) {
    const head = content.slice(0, 4096)
    if (/\[Script Info\]/i.test(head) || /\[Events\]/i.test(head) || /\[V4\+?\s*Styles\]/i.test(head)) {
      return "ass"
    }
  }
  return "srt"
}