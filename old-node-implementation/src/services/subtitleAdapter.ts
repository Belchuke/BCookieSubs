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
// ASS/SSA. Override tags and vector-drawing data are stripped from the text
// handed to the model and replaced with opaque ⟨ASk⟩ placeholder tokens (see
// assTextExtractor.ts), so this preamble tells the model to treat those tokens
// as untouchable and to translate only the surrounding readable text. Empty for
// SRT (no change to the existing prompt flow).
export function formatAwareChunkPreamble(format: SubtitleFormat): string {
  if (format !== "ass" && format !== "ssa") return ""
  return [
    "These subtitle entries are ASS/SSA Dialogue Text fields where every styling/position override tag and vector-drawing command has been replaced by a placeholder token of the form ⟨AS1⟩, ⟨AS2⟩, etc.",
    "Treat every ⟨ASk⟩ placeholder as untouchable: copy it character-for-character into your output, in the same position relative to the surrounding text. Never translate, rename, reorder, split, merge, add, or drop a placeholder.",
    "Preserve \\N (and \\n) line-break markers exactly.",
    "Translate only the human-readable dialogue text around the placeholders; the placeholders themselves carry no meaning and must pass through unchanged.",
    "Keep each entry on a single logical line, matching the input.",
  ].join(" ")
}