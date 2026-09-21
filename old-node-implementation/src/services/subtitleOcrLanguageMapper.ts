// Maps BCookieSubs language codes (ISO 639-1 / 639-2/B as stored on the
// `language` table) to Tesseract OCR language codes (the suffixes used by the
// `tesseract-ocr-<lang>` packages and the `-l` CLI flag).
//
// VobSub OCR needs a Tesseract language model to recognise text in the
// subtitle images. The translation pipeline already knows the source language
// of a library item / subtitle, so we derive the OCR language from that rather
// than asking for it every time. A user can still override the choice in the
// subtitle-source picker (see SubtitleSourceCandidate.ocrLang).
//
// Anything not in the map falls back to English (`eng`) — Tesseract's
// `tesseract-ocr-eng` is the one pack we guarantee is installed.

const APP_LANG_TO_TESSERACT: Record<string, string> = {
  // ISO 639-1
  en: "eng",
  da: "dan",
  th: "tha",
  ja: "jpn",
  de: "deu",
  fr: "fra",
  es: "spa",
  it: "ita",
  pt: "por",
  ru: "rus",
  ko: "kor",
  zh: "chi_sim",
  ar: "ara",
  hi: "hin",
  tr: "tur",
  nl: "nld",
  pl: "pol",
  sv: "swe",
  no: "nor",
  fi: "fin",
  el: "ell",
  cs: "ces",
  he: "heb",
  hu: "hun",
  ro: "ron",
  vi: "vie",
  id: "ind",
  uk: "ukr",
  bg: "bul",
  hr: "hrv",
  sr: "srp",
  sk: "slk",
  sl: "slv",
  et: "est",
  lv: "lav",
  lt: "lit",
  fa: "fas",
  ca: "cat",
  gl: "glg",
  bn: "ben",
  ta: "tam",
  te: "tel",
  ml: "mal",
  pa: "pan",
  // ISO 639-2/B (BCookieSubs stores these on language.iso6392b)
  eng: "eng",
  dan: "dan",
  tha: "tha",
  jpn: "jpn",
  ger: "deu",
  deu: "deu",
  fre: "fra",
  fra: "fra",
  spa: "spa",
  ita: "ita",
  por: "por",
  rus: "rus",
  kor: "kor",
  chi: "chi_sim",
  zho: "chi_sim",
  ara: "ara",
  hin: "hin",
  tur: "tur",
  dut: "nld",
  nld: "nld",
  pol: "pol",
  swe: "swe",
  nor: "nor",
  fin: "fin",
  gre: "ell",
  ell: "ell",
  cze: "ces",
  ces: "ces",
  heb: "heb",
  hun: "hun",
  rum: "ron",
  ron: "ron",
  vie: "vie",
  ind: "ind",
  ukr: "ukr",
  bul: "bul",
  hrv: "hrv",
  srp: "srp",
  slo: "slk",
  slk: "slk",
  slv: "slv",
  est: "est",
  lav: "lav",
  lit: "lit",
  per: "fas",
  fas: "fas",
  cat: "cat",
  glg: "glg",
  ben: "ben",
  tam: "tam",
  tel: "tel",
  mal: "mal",
  pan: "pan",
}

export const FALLBACK_OCR_LANG = "eng"

// Resolve a single app language code (iso639 or iso6392b) to a Tesseract lang.
export function appLangToTesseractLang(appLang: string | null | undefined): string {
  if (!appLang) return FALLBACK_OCR_LANG
  const mapped = APP_LANG_TO_TESSERACT[appLang.toLowerCase()]
  return mapped ?? FALLBACK_OCR_LANG
}

// Resolve the best Tesseract language from one or more app-language hints
// (track language first, then source language), falling back to English.
export function resolveOcrLang(...hints: (string | null | undefined)[]): string {
  for (const hint of hints) {
    if (!hint) continue
    const mapped = APP_LANG_TO_TESSERACT[hint.toLowerCase()]
    if (mapped) return mapped
  }
  return FALLBACK_OCR_LANG
}

// Tesseract accepts combined languages as `+`-separated, e.g. `chi_sim+eng`.
// Validate that every component is a known code we can map; unknown parts are
// dropped, and if nothing survives we fall back to English.
export function normalizeOcrLangList(lang: string): string {
  const parts = lang
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .map((p) => APP_LANG_TO_TESSERACT[p] ?? p)
  if (parts.length === 0) return FALLBACK_OCR_LANG
  return parts.join("+")
}