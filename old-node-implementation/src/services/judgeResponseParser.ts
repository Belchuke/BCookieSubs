// Staged judge-response parser (see DATABASE_ASSESSMENT.md).
//
// The previous implementation matched /\{[\s\S]*\}/ (greedy: first "{" through
// the LAST "}") and JSON.parse'd that match. When a model appends any text
// after the JSON — a note, a second object, commentary — the greedy match
// spanned the junk, JSON.parse threw "Unexpected non-whitespace character after
// JSON at position … (line 2 column 1)", and the call was classified as a
// model_error and re-run up to maxRetries formatting retries. 569 such failures
// are logged in production, all with the "(line 2 column 1)" fingerprint of
// trailing model text after a valid JSON object.
//
// This parser tries, in order:
//   1. strict JSON.parse of the trimmed response
//   2. markdown-fence stripping + strict parse
//   3. balanced-brace extraction of the FIRST complete {...} object
//      (string-aware, so a "}" inside a quoted reason never closes the object;
//      trailing prose after the closing brace is ignored)
//   4. truncation repair: closes an unterminated string and missing closing
//      brackets/braces, then parses
// …then validates the parsed shape (winnerIndex numeric, optional reason).
// Range validation (winnerIndex < candidateCount) stays at the call site.

export type JudgeParseSuccess = { ok: true; winnerIndex: number; reason: string | null }
export type JudgeParseFailure = { ok: false; error: string }

const REPAIR_INSTRUCTION =
  "\n\nYour previous response was not a single valid JSON object. " +
  'Respond with ONLY the JSON object: {"winnerIndex": <number or -1>, "reason": "..."} — no other text.'

// Appends a short correction instruction to the judge prompt when retrying a
// judge call after a formatting failure. Combined with a small, bounded retry
// budget this keeps the judge from being asked to re-evaluate identical
// candidates many times in a row.
export function judgeRepairPrompt(promptText: string, attempt: number): string {
  const suffix = attempt > 1 ? " (previous attempts also failed to parse)" : ""
  return promptText + REPAIR_INSTRUCTION + suffix
}

/** End index (inclusive) of a JSON string starting at content[start] === '"'. */
function stringEnd(content: string, start: number): number {
  let i = start + 1
  while (i < content.length) {
    if (content[i] === "\\") {
      i += 2
      continue
    }
    if (content[i] === '"') return i
    i++
  }
  return -1
}

/**
 * Extract the first balanced {...} object, skipping leading prose. Returns the
 * object text, or null. String-aware: a "}" inside a quoted value never closes
 * the object. An unterminated string returns null so repair can take over.
 */
function extractFirstBalancedObject(content: string): string | null {
  const start = content.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let i = start
  while (i < content.length) {
    const ch = content[i]
    if (ch === '"') {
      const end = stringEnd(content, i)
      if (end === -1) return null // unterminated string — hand off to repair
      i = end + 1
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return content.slice(start, i + 1)
    }
    i++
  }
  return null
}

/**
 * Repair a truncated JSON object/fragment: closes an unterminated string and
 * any missing closing brackets/braces. Returns null when nothing plausible can
 * be built (e.g. no opening brace at all).
 */
function repairTruncatedJson(fragment: string): string | null {
  if (!fragment || !fragment.includes("{")) return null
  const start = fragment.indexOf("{")
  let s = fragment.slice(start)
  // Drop a trailing partial escape sequence so closing the string is valid.
  s = s.replace(/\\$/, "")
  if (s.trim().length === 0) return null

  // One string-aware pass, tracking open strings and the bracket stack.
  const stack: string[] = []
  let openString = false
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (openString) {
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === '"') openString = false
      i++
      continue
    }
    if (ch === '"') {
      openString = true
      i++
      continue
    }
    if (ch === "{" || ch === "[") stack.push(ch)
    else if (ch === "}" || ch === "]") {
      if (stack.length > 0) stack.pop()
    }
    i++
  }
  // A truncated response ends mid-string: synthesize the closing quote.
  let repaired = s
  if (openString) repaired += '"'
  // Drop a dangling comma/colon right before the synthesized closers.
  repaired = repaired.replace(/[,:\s]+$/, "")
  for (const opener of stack.reverse()) {
    repaired += opener === "{" ? "}" : "]"
  }
  return repaired
}

export function parseJudgeResponse(content: string): JudgeParseSuccess | JudgeParseFailure {
  const trimmed = content.trim()
  if (!trimmed) return { ok: false, error: "empty response" }

  const candidates: string[] = [trimmed]
  // Stage 2: strip markdown code fences around the JSON.
  const fenced = trimmed
    .replace(/^`{3}[a-zA-Z0-9_-]*\s*\n?/, "")
    .replace(/```$/, "")
    .trim()
  if (fenced !== trimmed) candidates.push(fenced)

  // Stage 3: first balanced object out of any surrounding prose.
  const balanced = extractFirstBalancedObject(trimmed)
  if (balanced && !candidates.includes(balanced)) candidates.push(balanced)

  // Stage 4: repair a truncated object (fences stripped first if present).
  const repaired = repairTruncatedJson(balanced ?? fenced)
  if (repaired && !candidates.includes(repaired)) candidates.push(repaired)

  let error = "no parseable JSON object found"
  for (const attempt of candidates) {
    const result = validateShape(attempt)
    if (result) return result
    if (result === null) error = lastShapeError
  }
  return { ok: false, error }
}

// Error detail from the most recent validateShape call.
let lastShapeError = "no JSON object found"

function validateShape(text: string): JudgeParseSuccess | null {
  try {
    const value = JSON.parse(text) as { winnerIndex?: unknown; reason?: unknown }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      lastShapeError = "response is not a JSON object"
      return null
    }
    if (!("winnerIndex" in value)) {
      lastShapeError = "JSON object missing winnerIndex"
      return null
    }
    const winnerIndex = normalizeWinnerIndex(value.winnerIndex)
    if (winnerIndex === null) {
      lastShapeError = "winnerIndex not numeric"
      return null
    }
    const reason = typeof value.reason === "string" ? value.reason.slice(0, 500) : null
    return { ok: true, winnerIndex, reason }
  } catch (e) {
    lastShapeError = e instanceof Error ? e.message : String(e)
    return null
  }
}

// winnerIndex may arrive as 1, "1", or "1 " — normalize to number or null.
function normalizeWinnerIndex(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string") {
    const n = Number(raw.trim())
    if (Number.isFinite(n)) return n
  }
  return null
}