import { CREDIT_TEXT } from "../constants/keys"
import { CREDIT_DURATION_MS } from "../constants/timer"
import { SubtitleFormat } from "../types/subtitleTypes"
import { msToAssTime } from "./assSubtitleAdapter"
import { applyAssFontPolicy } from "./subtitleFontPolicy"

function srtToMs(ts: string): number {
  const [hms, ms] = ts.split(",")
  const [h, m, s] = hms.split(":").map(Number)
  return h * 3600000 + m * 60000 + s * 1000 + Number(ms)
}

function msToSrt(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`
}

function parseFirstStartMs(srt: string): number | null {
  const match = srt.match(/\d+\r?\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->/)
  return match ? srtToMs(match[1]) : null
}

export function addCreditToSrt(srt: string): string {
  if (!srt.trim()) return srt

  const firstStartMs = parseFirstStartMs(srt)

  let creditEndMs = CREDIT_DURATION_MS
  if (firstStartMs !== null) {
    const safeEnd = firstStartMs - 100
    if (safeEnd <= 0) {
      return shiftSrtIds(srt)
    }
    creditEndMs = Math.min(CREDIT_DURATION_MS, safeEnd)
  }

  const creditBlock = `1\n${msToSrt(0)} --> ${msToSrt(creditEndMs)}\n${CREDIT_TEXT}\n`
  return creditBlock + "\n" + shiftSrtIds(srt)
}

function shiftSrtIds(srt: string): string {
  return srt.replace(/^(\d+)(\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->)/gm, (_, id, rest) => {
    return `${parseInt(id) + 1}${rest}`
  })
}

// File extension to use when exporting a given source format.
export function subtitleExportExtension(format: SubtitleFormat): ".srt" | ".ass" | ".ssa" {
  if (format === "ass") return ".ass"
  if (format === "ssa") return ".ssa"
  return ".srt"
}

// Format-aware credit dispatcher. Inserts a "Translated by BCookieSubs" entry
// at the top of the subtitle without disturbing the rest of the content.
export function addCreditToSubtitle(content: string, format: SubtitleFormat): string {
  if (format === "ass" || format === "ssa") return addCreditToAss(content)
  return addCreditToSrt(content)
}

// The single place that turns a job's finished translatedText/originalText
// into the exact bytes written to disk, stored as an exported-file path, or
// sent to a download response. Adds the credit line, then applies the
// language-aware ASS font policy (see subtitleFontPolicy.ts) — currently a
// no-op for every language except Thai. Every export/download call site
// should go through this rather than calling addCreditToSubtitle directly, so
// the font/title fix-up can never be applied inconsistently or skipped.
export function finalizeSubtitleForOutput(
  content: string,
  format: SubtitleFormat,
  languageCode: string,
  languageName: string,
  configuredThaiFont: string | null,
): string {
  const credited = addCreditToSubtitle(content, format)
  return applyAssFontPolicy(credited, format, languageCode, languageName, configuredThaiFont)
}

// Insert a credit Dialogue line as the first event in [Events], matching the
// section's Format field order so the line is valid for the file. Styles,
// Script Info, fonts, and existing Dialogue/Comment lines are untouched. If the
// file has no [Events]/Format section, return it unchanged rather than risk
// corrupting it.
function addCreditToAss(content: string): string {
  if (!content.trim()) return content

  const eol = content.includes("\r\n") ? "\r\n" : "\n"
  const lines = content.split(eol)

  let inEvents = false
  let inStyles = false
  let formatLineIndex = -1
  let fields: string[] | null = null
  let firstStyleName: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      const name = header[1].toLowerCase()
      inEvents = name === "events"
      inStyles = name === "v4+ styles" || name === "v4 styles"
      continue
    }

    if (inStyles && firstStyleName === null && /^\s*Style\s*:/i.test(line)) {
      // Style: Name, Fontname, Fontsize, ...
      const after = line.replace(/^\s*Style\s*:/i, "")
      firstStyleName = after.split(",")[0]?.trim() || "Default"
      continue
    }

    if (inEvents && formatLineIndex === -1 && /^\s*Format\s*:/i.test(line)) {
      fields = line.replace(/^\s*Format\s*:/i, "").split(",").map((f) => f.trim())
      formatLineIndex = i
    }
  }

  if (formatLineIndex === -1 || !fields || fields.length === 0) return content

  const textFieldIndex = fields.indexOf("Text") >= 0 ? fields.indexOf("Text") : fields.length - 1
  const styleName = firstStyleName || "Default"

  const valueFor = (field: string): string => {
    switch (field.toLowerCase()) {
      case "layer":
        return "0"
      case "start":
        return "0:00:00.00"
      case "end":
        return msToAssTime(CREDIT_DURATION_MS)
      case "style":
        return styleName
      case "name":
        return ""
      case "marginl":
      case "marginr":
      case "marginv":
        return "0"
      case "effect":
        return ""
      case "text":
        return CREDIT_TEXT
      default:
        return ""
    }
  }

  const creditValues = fields.map(valueFor)
  const creditLine = `Dialogue: ${creditValues.join(",")}`

  // Insert as the first event, immediately after the Format: line.
  lines.splice(formatLineIndex + 1, 0, creditLine)
  return lines.join(eol)
}
