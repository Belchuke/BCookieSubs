// Thin, safe wrapper around the local `tesseract` CLI used by the VobSub OCR
// pipeline. Keeps all child_process spawning in one place so routes/tasks never
// spawn Tesseract directly, and so missing-binary / missing-language-data
// failures surface as a single clear typed error instead of vague crashes.
//
// We deliberately do NOT pull in a Node Tesseract binding: the system CLI is
// installed in the Docker image (see Dockerfile), is faster to invoke per
// image, and avoids a fragile native dependency. A node wrapper is only worth
// adding if it is maintained and tested — see the project task notes.
import { spawnSync } from "child_process"
import { normalizeOcrLangList, FALLBACK_OCR_LANG } from "./subtitleOcrLanguageMapper"

export class TesseractUnavailableError extends Error {
  constructor(message = "Tesseract OCR is not installed or not on PATH") {
    super(message)
    this.name = "TesseractUnavailableError"
  }
}

export class TesseractLangMissingError extends Error {
  constructor(
    public readonly requestedLang: string,
    message: string,
  ) {
    super(message)
    this.name = "TesseractLangMissingError"
  }
}

let _tesseractPathCache: string | null | undefined = undefined

// Locate the tesseract binary once. Returns null if not found. Cached so the
// OCR loop doesn't spawn `--version` before every image.
export function findTesseract(): string | null {
  if (_tesseractPathCache !== undefined) return _tesseractPathCache
  const r = spawnSync("tesseract", ["--version"], { encoding: "utf-8", timeout: 10_000 })
  const ok = r.status === 0 && !r.error && /tesseract/i.test(r.stdout || r.stderr || "")
  _tesseractPathCache = ok ? "tesseract" : null
  return _tesseractPathCache
}

let _availableLangsCache: Set<string> | null = null

// The set of traineddata languages Tesseract can see on this machine
// (`tesseract --list-langs`). Cached for the process — language packs don't
// appear at runtime.
export function listTesseractLangs(): Set<string> {
  if (_availableLangsCache) return _availableLangsCache
  const r = spawnSync("tesseract", ["--list-langs"], { encoding: "utf-8", timeout: 10_000 })
  const set = new Set<string>()
  if (r.status === 0 && !r.error && r.stdout) {
    for (const line of r.stdout.split(/\r?\n/)) {
      const t = line.trim()
      // The first line is usually a header ("List of available languages...").
      if (!t || /list of available/i.test(t) || t === "osd") continue
      set.add(t.toLowerCase())
    }
  }
  _availableLangsCache = set
  return set
}

// True when every `+`-separated component of `lang` has installed traineddata.
export function isOcrLangAvailable(lang: string): boolean {
  const available = listTesseractLangs()
  return lang
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .every((p) => available.has(p))
}

// Ensure tesseract is installed and the requested language data is present,
// throwing a typed error with a useful message otherwise. Call once before the
// OCR loop so a missing dependency fails fast instead of after partial work.
export function assertOcrReady(lang: string): void {
  if (!findTesseract()) {
    throw new TesseractUnavailableError(
      "Tesseract OCR is not installed or not on PATH. Install `tesseract-ocr` (and the needed language packs) to OCR image-based .sub subtitles.",
    )
  }
  const normalized = normalizeOcrLangList(lang)
  if (!isOcrLangAvailable(normalized)) {
    const missing = normalized
      .split("+")
      .filter((p) => !listTesseractLangs().has(p.toLowerCase()))
      .join(", ")
    throw new TesseractLangMissingError(
      normalized,
      `Tesseract language data for "${missing}" is not installed. Install the matching tesseract-ocr language pack(s) (requested OCR language: ${normalized}).`,
    )
  }
}

export type OcrOptions = {
  // Tesseract language code(s), `+`-separated. Defaults to English.
  lang?: string
  // Page-segmentation mode. 6 = "Assume a single uniform block of text" works
  // well for a subtitle line rendered on a solid background; callers may
  // override (e.g. 7 for a single line).
  psm?: number
  // Per-image timeout in ms.
  timeoutMs?: number
}

// Run Tesseract on a single image file and return the recognised text (trimmed).
// Returns "" (not null) when Tesseract recognises nothing — the caller decides
// whether an all-empty result is a failure (see vobSubOcrService).
export function ocrImageFile(imagePath: string, opts: OcrOptions = {}): string {
  const lang = normalizeOcrLangList(opts.lang ?? FALLBACK_OCR_LANG)
  const psm = opts.psm ?? 6
  const args = [imagePath, "stdout", "-l", lang, "--psm", String(psm)]
  const r = spawnSync("tesseract", args, {
    encoding: "utf-8",
    timeout: opts.timeoutMs ?? 30_000,
  })
  if (r.error || r.status !== 0) {
    // Surface a short, sanitized reason; don't dump the whole stderr.
    const reason = (r.stderr || r.error?.message || "").split(/\r?\n/)[0]?.slice(0, 200) || "tesseract exited non-zero"
    throw new Error(`Tesseract OCR failed on ${imagePath}: ${reason}`)
  }
  return (r.stdout || "").replace(/\r/g, "").trim()
}

// Deterministic, non-LLM glyph normalization applied to OCR'd subtitle text.
// Tesseract reliably confuses a thin capital "I" glyph (common in VobSub/PGS
// bitmap rendering) with a pipe "|", which never appears as a legitimate
// character in movie/series dialogue. Swapping "|" → "I" recovers a very
// common misread without touching anything an LLM would second-guess. This is
// intentionally minimal — it does NOT correct "!" (a real exclamation mark) or
// attempt any context-aware fix.
export function cleanSubtitleOcrText(text: string): string {
  return text.replace(/\|/g, "I")
}