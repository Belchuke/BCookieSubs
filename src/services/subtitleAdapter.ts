// Format-agnostic entry points the pipeline calls instead of SrtParser2.
// Dispatches on the subtitle's sourceFormat to the per-format adapters so the
// import/chunk/translate/reassemble/export code stays single-path.
import { SubtitleRow, TranslatedRow, SubtitleFormat } from "../types/subtitleTypes"
import { parseSrtRows, serializeSrtFromRows } from "./srtSubtitleAdapter"
import { parseAssRows, serializeAssFromRows } from "./assSubtitleAdapter"

export function parseSubtitleRows(raw: string, format: SubtitleFormat): SubtitleRow[] {
  if (format === "ass" || format === "ssa") return parseAssRows(raw, format)
  return parseSrtRows(raw)
}

// `rows` is the merged, ordered list of translated {id, text} across all chunks.
// The original file structure is recovered from `rawOriginal` (subtitle.originalText).
export function serializeSubtitle(
  rawOriginal: string,
  rows: TranslatedRow[],
  format: SubtitleFormat,
): string {
  if (format === "ass" || format === "ssa") return serializeAssFromRows(rawOriginal, rows, format)
  return serializeSrtFromRows(rawOriginal, rows)
}

// Extra instructions appended before the chunk envelope when the source is
// ASS/SSA, telling the model to preserve override tags and line breaks exactly
// and translate only the readable dialogue text. Empty for SRT (no change to
// the existing prompt flow).
export function formatAwareChunkPreamble(format: SubtitleFormat): string {
  if (format !== "ass" && format !== "ssa") return ""
  return [
    "These subtitle entries are ASS/SSA Dialogue Text fields.",
    "Preserve ALL ASS override tags exactly as written, including {\\an8}, {\\i1}, {\\b1}, {\\pos(x,y)}, {\\fad(...)}, and any other {...} tags — keep them in their original positions within each line.",
    "Preserve \\N (and \\n) line-break markers exactly.",
    "Translate only the human-readable dialogue text; do not translate, reorder, remove, or add override tags or structural markup.",
    "Keep each entry on a single logical line, matching the input.",
  ].join(" ")
}