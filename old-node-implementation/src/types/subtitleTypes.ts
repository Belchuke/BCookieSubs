// Normalized subtitle representation shared across the translation pipeline.
// The pipeline (import → chunk → translate → reassemble → export) works on
// SubtitleRow[] regardless of the source format; format-specific adapters
// (srtSubtitleAdapter / assSubtitleAdapter) parse a raw file into rows and
// serialize rows back into the original format. This keeps the LLM prompt and
// chunking logic format-agnostic.

export type SubtitleFormat = "srt" | "ass" | "ssa"

export type SubtitleRow = {
  // Synthetic id "1".."N" assigned in file order. Matches the chunk's
  // srtIdFrom/srtIdTo range and the LLM <txtcnk id="…"> envelope.
  id: string
  startMs: number
  endMs: number
  // Translatable body: the SRT entry text or the ASS/SSA Dialogue Text field.
  text: string
  // Original body, unchanged through the pipeline. Export uses this for rows
  // that were never translated (e.g. a chunk that failed) and as a fallback.
  originalText: string
  format: SubtitleFormat
  meta: {
    // SRT: the original SRT-formatted timing strings, so we can rebuild with
    // the exact original timing rather than re-deriving it.
    startTime?: string
    endTime?: string
    // ASS/SSA: the index of this Dialogue line in the original file's line
    // array, and the exact text preceding the Text field
    // ("Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,")
    // so the translated line is rebuilt as prefix + translatedText, preserving
    // every other field byte-for-byte.
    lineIndex?: number
    prefix?: string
  }
}

// Minimal shape the serializers need from translated rows. The pipeline merges
// translated candidates into {id, text}[]; original timing/structure comes from
// re-parsing subtitle.originalText inside each adapter.
export type TranslatedRow = { id: string; text: string }