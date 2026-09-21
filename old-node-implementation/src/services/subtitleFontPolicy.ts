// Central language-aware ASS/SSA font policy. Fonts embedded in a source
// subtitle's [V4+ Styles]/[V4 Styles] section and inline \fn overrides are
// preserved as-is UNLESS the output language has a configured override here —
// today that's Thai only, because fonts fansub releases commonly ship
// (Roboto Medium, Arial, Comic Sans MS, ...) are Latin-only and either lack
// Thai glyphs or aren't installed on the media server, rendering as boxes.
// Adding another language's override means adding it to this map (and, if it
// should be user-configurable, threading a config column through like
// `thaiAssFont`) — never patching font names into the export/download code.
import { SubtitleFormat } from "../types/subtitleTypes"
import { rewriteAssFontnames, rewriteAssInlineFontOverrides, setAssScriptInfoTitle } from "./assFontRewriter"

export const DEFAULT_THAI_ASS_FONT = "Garuda"

export const subtitleFontByLanguage: Record<string, string> = {
  th: DEFAULT_THAI_ASS_FONT,
}

const THAI_LANGUAGE_CODES = new Set(["th", "tha"])

function primarySubtag(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0]
}

// Normalizes th / tha / th-TH / th_TH (case-insensitive) to "th"; any other
// code is normalized to its lowercased primary subtag unchanged.
export function normalizeLanguageCode(code: string | null | undefined): string | null {
  if (!code) return null
  const tag = primarySubtag(code)
  return THAI_LANGUAGE_CODES.has(tag) ? "th" : tag
}

export function isThaiLanguageCode(code: string | null | undefined): boolean {
  if (!code) return false
  return THAI_LANGUAGE_CODES.has(primarySubtag(code))
}

// Resolves the font BCookieSubs should force onto ASS/SSA output for a given
// output language, or null to leave the source subtitle's fonts untouched.
// `configuredThaiFont` is the user-configurable "Thai ASS font" setting
// (config.thaiAssFont); an unset/blank value falls back to the hardcoded
// default. Every language other than Thai returns null — i.e. keeps its
// existing font behavior — until it gets its own entry in this module.
export function resolveAssFontForLanguage(
  languageCode: string | null | undefined,
  configuredThaiFont?: string | null,
): string | null {
  if (!isThaiLanguageCode(languageCode)) return null
  return configuredThaiFont?.trim() || subtitleFontByLanguage.th
}

// Applies the resolved font policy to ASS/SSA content: rewrites every style's
// Fontname and every inline \fn override to the resolved font, and corrects
// the [Script Info] Title (e.g. away from a stale "English (US)") to match
// the new output language. No-op for SRT and for any language with no
// resolved font override (resolveAssFontForLanguage returned null) — so today
// this only ever changes output for Thai.
export function applyAssFontPolicy(
  content: string,
  format: SubtitleFormat,
  languageCode: string | null | undefined,
  languageName: string | null | undefined,
  configuredThaiFont?: string | null,
): string {
  if (format !== "ass" && format !== "ssa") return content

  const font = resolveAssFontForLanguage(languageCode, configuredThaiFont)
  if (!font) return content

  let result = rewriteAssFontnames(content, font)
  result = rewriteAssInlineFontOverrides(result, font)
  if (languageName) result = setAssScriptInfoTitle(result, languageName)
  return result
}
