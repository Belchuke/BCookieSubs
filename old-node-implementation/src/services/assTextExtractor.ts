// Prepares ASS/SSA Dialogue Text fields for translation without ever sending the
// styling/position override tags or vector-drawing data to the model.
//
// An ASS Dialogue Text field is a mix of:
//   - override blocks: {...} carrying position/colour/blur/font tags such as
//     {\pos(1723.767,691.233)\fs54\b1\c&H0E5CDD&\blur7.5}
//   - vector-drawing runs: literal text rendered as a shape while a \p1 (or
//     \p<positive>) tag is active, e.g. "m 0 0 m 1431 664.5 b ..."
//   - readable dialogue text: the words the model should actually translate
//
// Sending the first two to the model is both wasteful and dangerous: the model
// may "translate" or mangle coordinate/colour values and drawing commands,
// producing a broken .ass. Instead we replace every non-translatable run with an
// opaque numbered placeholder token — ⟨ASk⟩ — and send only that plus the
// readable text. The model translates the words and keeps the tokens in place;
// restoreAssPlaceholders() swaps each token back for the original run, so the
// serialized file keeps every override tag and drawing byte-identical.
//
// Dialogue lines that contain NO readable text (pure vector drawings, or lines
// made up only of override blocks) have nothing to translate and are skipped by
// the caller — the serializer leaves any id it doesn't receive a translated row
// for untouched, so those lines are copied verbatim.

// U+27E8 / U+27E9 mathematical angle brackets — distinctive, absent from natural
// language, and free of < > so they never collide with the <txtcnk> envelope.
const OPEN = "⟨"
const CLOSE = "⟩"
const PLACEHOLDER_RE = /⟨AS(\d+)⟩/g
const PLACEHOLDER_GLOBAL_RE = /⟨AS\d+⟩/g

export interface AssExtractResult {
  /** Text to hand the model: readable dialogue text + ⟨ASk⟩ tokens. */
  modelText: string
  /** True when at least one readable (non-whitespace, non-escape) run exists. */
  hasTranslatable: boolean
  /** runs[k-1] is the original run text to substitute back for token ⟨ASk⟩. */
  runs: string[]
}

function nextToken(runs: string[]): string {
  const idx = runs.length + 1
  return `${OPEN}AS${idx}${CLOSE}`
}

// Update the drawing-mode flag from the \p tags inside one override block.
// \p<positive> turns drawing ON; \p0 / \p (no arg) turns it OFF. Other tags
// (including \pos, which also begins with "p") leave the flag unchanged. When
// several \p tags appear in one block the last one wins, matching ASS render
// order. The negative lookahead `(?![a-zA-Z])` is what separates \p from \pos.
function applyDrawingTags(current: boolean, block: string): boolean {
  let mode = current
  const re = /\\p(?![a-zA-Z])\s*(\d*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    mode = m[1] === "" ? false : parseInt(m[1], 10) > 0
  }
  return mode
}

export function extractAssTranslatable(text: string): AssExtractResult {
  const runs: string[] = []
  let modelText = ""
  let drawingOn = false

  let i = 0
  const n = text.length
  while (i < n) {
    if (text[i] === "{") {
      // Override block up to the next "}". A missing "}" (malformed) consumes
      // the rest of the line as a block rather than spilling tag text into the
      // model input.
      const end = text.indexOf("}", i)
      const blockEnd = end === -1 ? n : end + 1
      const block = end === -1 ? text.slice(i) : text.slice(i, blockEnd)
      drawingOn = applyDrawingTags(drawingOn, block)
      modelText += nextToken(runs)
      runs.push(block)
      i = blockEnd
    } else {
      // Literal run up to the next "{" or end of line.
      let j = i
      while (j < n && text[j] !== "{") j++
      const lit = text.slice(i, j)
      if (drawingOn) {
        // Vector-drawing data is not translatable — hide it behind a token so
        // the model never sees it and the bytes are restored verbatim.
        modelText += nextToken(runs)
        runs.push(lit)
      } else {
        modelText += lit
      }
      i = j
    }
  }

  // A line is translatable only if, after removing tokens and the ASS line-break
  // / hard-space escapes (\N \n \h), some readable text remains. Lines that are
  // purely drawings or override blocks have nothing to translate and are skipped
  // by the caller.
  const stripped = modelText.replace(PLACEHOLDER_GLOBAL_RE, "").replace(/\\[NnhH]/g, "")
  const hasTranslatable = /\S/.test(stripped)

  return { modelText, hasTranslatable, runs }
}

export function restoreAssPlaceholders(modelText: string, runs: string[]): string {
  return modelText.replace(PLACEHOLDER_RE, (_, n) => runs[parseInt(n, 10) - 1] ?? "")
}

// True when `translated` preserves the placeholder tokens of `source` exactly —
// same count and same left-to-right order. Used to reject candidates where the
// model dropped, duplicated, or reordered a token, which would reattach override
// tags to the wrong text and corrupt the .ass. Reordering the tokens relative to
// one another is treated as corruption even though the words between them may
// legitimately move: ASS override tags apply to the text that follows them in
// order, so the tag sequence is meaningfully ordered.
export function assPlaceholdersIntact(source: string, translated: string): boolean {
  const src = source.match(PLACEHOLDER_GLOBAL_RE) || []
  const dst = translated.match(PLACEHOLDER_GLOBAL_RE) || []
  return src.length === dst.length && src.every((t, idx) => t === dst[idx])
}