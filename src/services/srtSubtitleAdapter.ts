// SRT adapter: parses raw SRT into normalized SubtitleRow[] and serializes
// translated rows back into SRT, preserving the original per-entry timing.
// This is the format the pipeline has always used; it is extracted here so the
// rest of the pipeline can be format-agnostic (see subtitleAdapter.ts).
import { parseSrt, SrtEntry } from "./srtService"
import { SubtitleRow, TranslatedRow } from "../types/subtitleTypes"

export function parseSrtRows(raw: string): SubtitleRow[] {
  return parseSrt(raw).map((e) => ({
    id: e.id,
    startMs: e.startMs,
    endMs: e.endMs,
    text: e.text,
    originalText: e.text,
    format: "srt" as const,
    meta: { startTime: e.startTime, endTime: e.endTime },
  }))
}

// Rebuild SRT from translated rows. `rows` is the merged, ordered list of
// {id, text} (chunkIndex order, row order within each chunk). Each row's
// original timing is recovered by re-parsing `rawOriginal` so the output keeps
// the source timing exactly; only the text is swapped. Entries are renumbered
// 1..N to match the SRT convention (matches the prior inline builder).
export function serializeSrtFromRows(rawOriginal: string, rows: TranslatedRow[]): string {
  const originals = new Map<string, SrtEntry>()
  for (const e of parseSrt(rawOriginal)) originals.set(e.id, e)

  const out: string[] = []
  let counter = 0
  for (const row of rows) {
    const original = originals.get(row.id)
    // Skip rows whose id isn't in the original (e.g. a malformed LLM response)
    // rather than emitting a block with placeholder timing — matches the prior
    // inline builder's behavior.
    if (!original) continue
    counter += 1
    out.push(String(counter))
    out.push(`${original.startTime} --> ${original.endTime}`)
    out.push(row.text ?? "")
    out.push("")
  }
  return out.join("\n")
}