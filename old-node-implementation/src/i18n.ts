import path from "path"
import fs from "fs"

export const SUPPORTED_LOCALES = [
  "en", "da", "th", "de", "es", "fr", "sv", "nb", "fi", "pt",
  "ja", "zh", "ru", "tr", "ko", "vi", "nl", "it", "pl", "uk",
  "cs", "ro", "hu", "el", "id", "ms", "hi", "ar", "sq", "hy",
  "az", "eu", "be", "bn", "bs", "bg", "ca", "hr", "et", "fil",
  "ka", "he", "is", "ga", "kk", "lv", "lt", "mk", "sr", "sk",
  "sl", "ta", "te", "ur", "fa", "sw", "af", "zu", "tl", "my",
  "km", "lo", "mn", "ne", "si", "gu", "kn", "ml", "mr", "pa",
  "lb", "mt", "cy", "gd", "gl", "am", "ha", "ig", "yo", "so",
  "ky", "tg", "tk", "uz", "eo", "la",
] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en:  "English",
  da:  "Danish",
  th:  "Thai",
  de:  "German",
  es:  "Spanish",
  fr:  "French",
  sv:  "Swedish",
  nb:  "Norwegian",
  fi:  "Finnish",
  pt:  "Portuguese",
  ja:  "Japanese",
  zh:  "Chinese",
  ru:  "Russian",
  tr:  "Turkish",
  ko:  "Korean",
  vi:  "Vietnamese",
  nl:  "Dutch",
  it:  "Italian",
  pl:  "Polish",
  uk:  "Ukrainian",
  cs:  "Czech",
  ro:  "Romanian",
  hu:  "Hungarian",
  el:  "Greek",
  id:  "Indonesian",
  ms:  "Malay",
  hi:  "Hindi",
  ar:  "Arabic",
  sq:  "Albanian",
  hy:  "Armenian",
  az:  "Azerbaijani",
  eu:  "Basque",
  be:  "Belarusian",
  bn:  "Bengali",
  bs:  "Bosnian",
  bg:  "Bulgarian",
  ca:  "Catalan",
  hr:  "Croatian",
  et:  "Estonian",
  fil: "Filipino",
  ka:  "Georgian",
  he:  "Hebrew",
  is:  "Icelandic",
  ga:  "Irish",
  kk:  "Kazakh",
  lv:  "Latvian",
  lt:  "Lithuanian",
  mk:  "Macedonian",
  sr:  "Serbian",
  sk:  "Slovak",
  sl:  "Slovenian",
  ta:  "Tamil",
  te:  "Telugu",
  ur:  "Urdu",
  fa:  "Persian",
  sw:  "Swahili",
  af:  "Afrikaans",
  zu:  "Zulu",
  tl:  "Tagalog",
  my:  "Burmese",
  km:  "Khmer",
  lo:  "Lao",
  mn:  "Mongolian",
  ne:  "Nepali",
  si:  "Sinhala",
  gu:  "Gujarati",
  kn:  "Kannada",
  ml:  "Malayalam",
  mr:  "Marathi",
  pa:  "Punjabi",
  lb:  "Luxembourgish",
  mt:  "Maltese",
  cy:  "Welsh",
  gd:  "Scottish Gaelic",
  gl:  "Galician",
  am:  "Amharic",
  ha:  "Hausa",
  ig:  "Igbo",
  yo:  "Yoruba",
  so:  "Somali",
  ky:  "Kyrgyz",
  tg:  "Tajik",
  tk:  "Turkmen",
  uz:  "Uzbek",
  eo:  "Esperanto",
  la:  "Latin",
}

export const LOCALE_FLAGS: Record<SupportedLocale, string> = {
  en:  "🇺🇸",
  da:  "🇩🇰",
  th:  "🇹🇭",
  de:  "🇩🇪",
  es:  "🇪🇸",
  fr:  "🇫🇷",
  sv:  "🇸🇪",
  nb:  "🇳🇴",
  fi:  "🇫🇮",
  pt:  "🇧🇷",
  ja:  "🇯🇵",
  zh:  "🇨🇳",
  ru:  "🇷🇺",
  tr:  "🇹🇷",
  ko:  "🇰🇷",
  vi:  "🇻🇳",
  nl:  "🇳🇱",
  it:  "🇮🇹",
  pl:  "🇵🇱",
  uk:  "🇺🇦",
  cs:  "🇨🇿",
  ro:  "🇷🇴",
  hu:  "🇭🇺",
  el:  "🇬🇷",
  id:  "🇮🇩",
  ms:  "🇲🇾",
  hi:  "🇮🇳",
  ar:  "🇸🇦",
  sq:  "🇦🇱",
  hy:  "🇦🇲",
  az:  "🇦🇿",
  eu:  "🇪🇸",
  be:  "🇧🇾",
  bn:  "🇧🇩",
  bs:  "🇧🇦",
  bg:  "🇧🇬",
  ca:  "🇪🇸",
  hr:  "🇭🇷",
  et:  "🇪🇪",
  fil: "🇵🇭",
  ka:  "🇬🇪",
  he:  "🇮🇱",
  is:  "🇮🇸",
  ga:  "🇮🇪",
  kk:  "🇰🇿",
  lv:  "🇱🇻",
  lt:  "🇱🇹",
  mk:  "🇲🇰",
  sr:  "🇷🇸",
  sk:  "🇸🇰",
  sl:  "🇸🇮",
  ta:  "🇮🇳",
  te:  "🇮🇳",
  ur:  "🇵🇰",
  fa:  "🇮🇷",
  sw:  "🇰🇪",
  af:  "🇿🇦",
  zu:  "🇿🇦",
  tl:  "🇵🇭",
  my:  "🇲🇲",
  km:  "🇰🇭",
  lo:  "🇱🇦",
  mn:  "🇲🇳",
  ne:  "🇳🇵",
  si:  "🇱🇰",
  gu:  "🇮🇳",
  kn:  "🇮🇳",
  ml:  "🇮🇳",
  mr:  "🇮🇳",
  pa:  "🇮🇳",
  lb:  "🇱🇺",
  mt:  "🇲🇹",
  cy:  "🏴",
  gd:  "🏴",
  gl:  "🇪🇸",
  am:  "🇪🇹",
  ha:  "🇳🇬",
  ig:  "🇳🇬",
  yo:  "🇳🇬",
  so:  "🇸🇴",
  ky:  "🇰🇬",
  tg:  "🇹🇯",
  tk:  "🇹🇲",
  uz:  "🇺🇿",
  eo:  "🌍",
  la:  "🇻🇦",
}

type LocaleData = Record<string, unknown>

const _cache: Partial<Record<string, LocaleData>> = {}

function loadLocale(locale: string): LocaleData {
  if (_cache[locale]) return _cache[locale]!
  try {
    const filePath = path.join(process.cwd(), "locales", `${locale}.json`)
    const raw = fs.readFileSync(filePath, "utf-8")
    _cache[locale] = JSON.parse(raw) as LocaleData
  } catch {
    _cache[locale] = {}
  }
  return _cache[locale]!
}

function dig(obj: LocaleData, key: string): string | undefined {
  const parts = key.split(".")
  let cur: unknown = obj
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === "string" ? cur : undefined
}

export function translate(locale: string, key: string): string {
  const val = dig(loadLocale(locale), key)
  if (val !== undefined) return val
  if (locale !== "en") {
    const fallback = dig(loadLocale("en"), key)
    if (fallback !== undefined) return fallback
  }
  return key
}

export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(locale)
}

export function resolveLocale(userLocale: string | null | undefined, configLocale: string | undefined): SupportedLocale {
  if (userLocale && isSupportedLocale(userLocale)) return userLocale
  if (configLocale && isSupportedLocale(configLocale)) return configLocale
  return "en"
}
