// Structural ASS/SSA font-rewriting utilities. Used by subtitleFontPolicy to
// force a language-specific font (e.g. Garuda for Thai) onto exported
// subtitles without a blind find-and-replace over the whole file: only the
// Fontname column of Style: lines and \fn overrides inside {...} override
// blocks are touched, so size/colour/position/every other tag and all
// ordinary dialogue text survive byte-for-byte.
//
// Every function here is idempotent: re-running on output that already uses
// the target font makes no further changes.

function sectionHeader(line: string): string | null {
  const m = line.match(/^\s*\[([^\]]+)\]\s*$/)
  return m ? m[1].toLowerCase().trim() : null
}

function detectEol(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n"
}

// Matches both "v4+ styles" and "v4 styles" — ASS and legacy SSA name this
// section differently, but both use the same Format:/Style: line shape.
function isStylesSectionHeader(name: string): boolean {
  return /^v4\+?\s*styles$/.test(name)
}

// Set every Style: line's Fontname field (as declared by that section's
// Format: line) to `font`. A Styles section with no Format: line, or a
// Style: line with fewer fields than the Format: line declares, is left
// untouched rather than guessed at.
export function rewriteAssFontnames(content: string, font: string): string {
  const eol = detectEol(content)
  const lines = content.split(eol)

  let inStyles = false
  let fontIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const header = sectionHeader(line)
    if (header !== null) {
      inStyles = isStylesSectionHeader(header)
      fontIndex = -1
      continue
    }
    if (!inStyles) continue

    if (/^\s*Format\s*:/i.test(line)) {
      const fields = line
        .replace(/^\s*Format\s*:/i, "")
        .split(",")
        .map((f) => f.trim().toLowerCase())
      fontIndex = fields.indexOf("fontname")
      continue
    }

    if (fontIndex < 0) continue
    const styleMatch = line.match(/^(\s*Style\s*:\s*)(.*)$/i)
    if (!styleMatch) continue

    const [, prefix, rest] = styleMatch
    const parts = rest.split(",")
    if (fontIndex >= parts.length || parts[fontIndex] === font) continue // out of range, or already correct
    parts[fontIndex] = font
    lines[i] = prefix + parts.join(",")
  }

  return lines.join(eol)
}

// Replace every explicit \fn<name> override inside {...} override blocks with
// \fn<font>. Scans char-by-char for block boundaries so text outside {...} —
// ordinary dialogue — is never touched, even if it happens to contain a
// literal backslash-fn sequence.
export function rewriteAssInlineFontOverrides(content: string, font: string): string {
  let result = ""
  let i = 0
  const n = content.length

  while (i < n) {
    if (content[i] !== "{") {
      result += content[i]
      i++
      continue
    }
    const end = content.indexOf("}", i)
    const blockEnd = end === -1 ? n : end + 1
    const block = content.slice(i, blockEnd)
    // A font name runs up to the next tag (backslash) or the end of the block,
    // per the ASS override-block grammar.
    result += block.replace(/\\fn[^\\}]*/g, `\\fn${font}`)
    i = blockEnd
  }

  return result
}

// Ensure [Script Info] has a Title: line equal to `title` — replaces an
// existing Title: line in place, or inserts one right after the section
// header when the section has none. No-op if [Script Info] itself is absent.
export function setAssScriptInfoTitle(content: string, title: string): string {
  const eol = detectEol(content)
  const lines = content.split(eol)

  let scriptInfoIndex = -1
  for (let i = 0; i < lines.length; i++) {
    if (sectionHeader(lines[i]) === "script info") {
      scriptInfoIndex = i
      break
    }
  }
  if (scriptInfoIndex < 0) return content

  for (let i = scriptInfoIndex + 1; i < lines.length; i++) {
    if (sectionHeader(lines[i]) !== null) break // left the [Script Info] section
    if (/^\s*Title\s*:/i.test(lines[i])) {
      if (lines[i].replace(/^\s*Title\s*:\s*/i, "").trim() === title) return content
      lines[i] = `Title: ${title}`
      return lines.join(eol)
    }
  }

  lines.splice(scriptInfoIndex + 1, 0, `Title: ${title}`)
  return lines.join(eol)
}
