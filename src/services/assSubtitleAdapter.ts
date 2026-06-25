// ASS/SSA adapter. ASS and SSA share the same Events/Format/Dialogue syntax
// (the only real difference is the styles-section header, [V4+ Styles] vs
// [V4 Styles], which we don't need to interpret for translation). Both are
// parsed the same way and serialized the same way.
//
// Preservation strategy: the raw original file is the source of truth. Parsing
// extracts only the translatable Dialogue `Text` fields into normalized rows;
// every other line (Script Info, Styles, fonts, margins, Comments, blank lines)
// is left untouched. On export we re-parse the original to recover each
// Dialogue line's position and exact prefix (everything before the Text field),
// then swap in the translated Text — so only the Text field changes and the
// rest of the file is byte-for-byte identical.
import { SubtitleRow, TranslatedRow, SubtitleFormat } from "../types/subtitleTypes"

// Standard ASS Events field order, used when a file omits its Format: line.
const DEFAULT_ASS_FIELDS = [
  "Layer",
  "Start",
  "End",
  "Style",
  "Name",
  "MarginL",
  "MarginR",
  "MarginV",
  "Effect",
  "Text",
]

// ASS timestamps are H:MM:SS.cc (centiseconds, 2 decimal places). Hours are
// not zero-padded in the spec; minutes/seconds are.
export function assTimeToMs(ts: string): number {
  const m = ts.trim().match(/^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$/)
  if (!m) return 0
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  const cs = parseInt(m[4].padEnd(2, "0"), 10)
  return h * 3600000 + mm * 60000 + s * 1000 + cs * 10
}

export function msToAssTime(ms: number): string {
  if (ms < 0) ms = 0
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const cs = Math.floor((ms % 1000) / 10)
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`
}

// Detect the original line ending so serialization reproduces it exactly.
function detectEol(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n"
}

// Index of the n-th comma (1-based) in s, or -1 if there are fewer than n commas.
function findNthComma(s: string, n: number): number {
  let seen = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 44 /* "," */) {
      seen++
      if (seen === n) return i
    }
  }
  return -1
}

function sectionHeader(line: string): string | null {
  const m = line.match(/^\s*\[([^\]]+)\]\s*$/)
  return m ? m[1].toLowerCase() : null
}

export function parseAssRows(raw: string, format: SubtitleFormat): SubtitleRow[] {
  const eol = detectEol(raw)
  const lines = raw.split(eol)

  let inEvents = false
  let fields: string[] | null = null
  let textFieldIndex = -1
  let startFieldIndex = -1
  let endFieldIndex = -1

  const rows: SubtitleRow[] = []
  let counter = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const header = sectionHeader(line)
    if (header !== null) {
      inEvents = header === "events"
      // Re-resolve the Format once we (re)enter Events; cleared until seen.
      if (inEvents) {
        fields = null
        textFieldIndex = -1
        startFieldIndex = -1
        endFieldIndex = -1
      }
      continue
    }

    if (!inEvents) continue

    // Format: line defines the field order for Dialogue lines in this section.
    if (/^\s*Format\s*:/i.test(line)) {
      fields = line
        .replace(/^\s*Format\s*:/i, "")
        .split(",")
        .map((f) => f.trim())
      textFieldIndex = fields.indexOf("Text")
      if (textFieldIndex === -1) textFieldIndex = fields.length - 1
      startFieldIndex = fields.indexOf("Start")
      endFieldIndex = fields.indexOf("End")
      continue
    }

    // Only Dialogue events are translated; Comment events are left as-is.
    if (!/^\s*Dialogue\s*:/i.test(line)) continue
    if (fields === null) {
      // No Format line seen yet in this Events section — assume standard order.
      fields = DEFAULT_ASS_FIELDS.slice()
      textFieldIndex = fields.length - 1
      startFieldIndex = 1
      endFieldIndex = 2
    }

    // Isolate the Text field (the last Format field) by locating the comma that
    // precedes it. Text is the (textFieldIndex)-th field (0-based), so the comma
    // right before it is the textFieldIndex-th comma (1-based). Everything from
    // that comma onward is the Text field — which may itself contain commas, so
    // a plain split(",", N) would truncate it. Slice instead.
    const textCommaIndex = findNthComma(line, textFieldIndex)
    if (textCommaIndex < 0) {
      // Fewer fields than the Format declares: can't safely isolate Text.
      continue
    }

    const prefix = line.slice(0, textCommaIndex + 1)
    const text = line.slice(textCommaIndex + 1)
    const leadingFields = line.slice(0, textCommaIndex).split(",")
    const startMs = startFieldIndex >= 0 ? assTimeToMs(leadingFields[startFieldIndex] ?? "") : 0
    const endMs = endFieldIndex >= 0 ? assTimeToMs(leadingFields[endFieldIndex] ?? "") : 0

    counter += 1
    rows.push({
      id: String(counter),
      startMs,
      endMs,
      text,
      originalText: text,
      format,
      meta: { lineIndex: i, prefix },
    })
  }

  return rows
}

export function serializeAssFromRows(
  rawOriginal: string,
  rows: TranslatedRow[],
  format: SubtitleFormat,
): string {
  const eol = detectEol(rawOriginal)
  const lines = rawOriginal.split(eol)

  // Re-parse to recover each Dialogue row's line index and exact prefix. The
  // parser is deterministic, so the synthetic ids line up with `rows`.
  const parsed = parseAssRows(rawOriginal, format)
  const metaById = new Map<string, { lineIndex: number; prefix: string }>()
  for (const r of parsed) {
    if (r.meta.lineIndex != null && r.meta.prefix != null) {
      metaById.set(r.id, { lineIndex: r.meta.lineIndex, prefix: r.meta.prefix })
    }
  }

  for (const row of rows) {
    const m = metaById.get(row.id)
    if (!m) continue
    lines[m.lineIndex] = m.prefix + (row.text ?? "")
  }

  // Tag the [Script Info] section with a translation credit. ASS comments
  // start with "; ". This is appended AFTER the Dialogue Text swap above so
  // the per-row lineIndex values still point at the original lines — inserting
  // earlier would shift every index after [Script Info] and corrupt the swap.
  appendTranslatedByCredit(lines)

  return lines.join(eol)
}

// Insert a "; Translated by BCookieSubs" comment as the first line of the
// [Script Info] section, if that section exists and doesn't already carry the
// credit. Operates in place on the line array (caller joins with the EOL).
function appendTranslatedByCredit(lines: string[]): void {
  const creditLine = "; Translated by BCookieSubs"
  let scriptInfoHeaderIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (sectionHeader(lines[i]) === "script info") {
      scriptInfoHeaderIndex = i
      break
    }
  }
  if (scriptInfoHeaderIndex < 0) return

  // Guard against duplicate credit when re-serializing already-translated output.
  for (let j = scriptInfoHeaderIndex + 1; j < lines.length; j++) {
    if (sectionHeader(lines[j]) !== null) break // left the [Script Info] section
    if (lines[j].trim() === creditLine) return
  }

  lines.splice(scriptInfoHeaderIndex + 1, 0, creditLine)
}