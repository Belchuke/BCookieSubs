import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import {
  getConfigTranslationLanguages,
  getLanguageById,
  getLanguageByIso,
  getUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import { createLog } from "../repositories/logRepository"
import { createMediaItem, getMediaItemById, getMediaItemByKeys } from "../repositories/mediaRepository"
import { getHighestRoleUser } from "../repositories/userRepository"
import {
  getSubtitleItemMediaItemFromPrompt,
  selectBestTheMovieDbMatch,
} from "../repositories/promptFormattingRepository"
import { fetchTheMovieDbDetailsById } from "../repositories/movieDbRepository"
import {
  createLibraryPathItem,
  createLibraryPathItemCandidate,
  deleteLibraryPathItem,
  findLibraryPathItemByPath,
  getExportedFileByPath,
  getLibraryPathById,
  getLibraryPathItemById,
  getLibraryPathItemCandidates,
  getLibraryPathItemIdsByLibraryPath,
  isLibraryPathItemBlacklisted,
  pruneMissingExportedFiles,
  recordExportedFile,
  setInitialScanCompleted,
  setLibraryPathState,
  updateLibraryPathItemExtractFileName,
  updateLibraryPathItemStatus,
} from "../repositories/libraryPathRepository"
import {
  createSubtitleTask,
  getSubtitleJobsBySubtitleId,
  getSubtitleById,
  getCompletedLibrarySubtitlesForExport,
} from "../repositories/subtitleRepository"
import {
  upsertItemSubtitleSources,
  getItemSubtitleSources,
} from "../repositories/subtitleSourceCacheRepository"
import { addCreditToSubtitle, subtitleExportExtension } from "./subtitleExportService"
import { CREDIT_TEXT } from "../constants/keys"
import {
  getBcookieTranslatedRowsForItem,
  replaceBcookieTranslatedForItem,
  BcookieTranslatedRow,
} from "../repositories/bcookieTranslatedRepository"
import {
  isSubtitleExtension,
  subtitleExtensionOf,
  subtitleFileExtensionOf,
  isSubFile,
  isSupFile,
  isVobSubCodec,
  isPgsCodec,
  imageSubtitleKindFromCodec,
} from "./subtitleFormatDetector"
import { convertSubToSrt, SubParseError, detectSubKind } from "./subSubtitleAdapter"
import { VobSubOcrError, parseVobSubIdx } from "./vobSubOcrService"
import { ocrPgsToSrt, PgsOcrError, parsePgsSup } from "./pgsOcrService"
import { TesseractUnavailableError, TesseractLangMissingError } from "./tesseractOcrService"
import { resolveOcrLang } from "./subtitleOcrLanguageMapper"
import { DBLibraryPath, DBLibraryPathItem, DBSubtitle, DBUser } from "../types/dbTypes"

const EXTRACT_TEMP_DIR = path.join(os.tmpdir(), `bcookiesubs-extract-${process.pid}`)
try {
  fs.mkdirSync(EXTRACT_TEMP_DIR, { recursive: true })
} catch {}

let _extractCounter = 0
function makeExtractTempPath(stem: string, tag: string, ext = ".srt"): string {
  _extractCounter++
  const safeStem = stem.replace(/[/\\:*?"<>|]/g, "_")
  const safeExt = ext.startsWith(".") ? ext : `.${ext}`
  return path.join(EXTRACT_TEMP_DIR, `${safeStem}.${tag}.${process.pid}-${_extractCounter}${safeExt}`)
}

// TMDB ids that must never be auto-assigned to a scanned movie. These are
// junk/placeholder TMDB entries (e.g. id 1054041 "Subs") that the matcher
// gravitates toward when it can't find the real title, attaching a garbage
// media item to otherwise obvious filenames. Anything that would resolve to
// one of these is left Unmatched (no media item) instead, so the user can fix
// the file rather than silently getting a wrong match. Movies only — series
// ids are left alone.
const BLOCKED_TMDB_IDS_FOR_MOVIES: number[] = [1054041]
function isBlockedTmdbId(tmdbId: number | null | undefined, libraryType: "movie" | "series"): boolean {
  return libraryType === "movie" && tmdbId != null && BLOCKED_TMDB_IDS_FOR_MOVIES.includes(tmdbId)
}

function safeDeleteTempExtract(filePath: string, db?: Database.Database, itemId: number | null = null): void {
  if (!filePath.startsWith(EXTRACT_TEMP_DIR)) return
  // VobSub extraction produces a .sub + .idx pair; delete the .idx sibling too
  // so temp OCR files never leak. (.sup / PGS extraction is a single file.)
  const siblings: string[] = []
  if (filePath.toLowerCase().endsWith(".sub")) {
    siblings.push(filePath.replace(/\.sub$/i, ".idx"))
  }
  for (const f of [filePath, ...siblings]) {
    try {
      fs.unlinkSync(f)
    } catch (e: any) {
      if (e?.code !== "ENOENT" && db) {
        createLog(db, "warning", "libraryScanner", "libraryScanner", itemId, "Failed to delete temporary extracted subtitle file", {
          path: f,
          error: String(e),
        })
      }
    }
  }
}

export function cleanupExtractTempDir(): void {
  try {
    fs.rmSync(EXTRACT_TEMP_DIR, { recursive: true, force: true })
  } catch {}
}

export const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".m4v",
  ".ts",
  ".mpg",
  ".mpeg",
  ".flv",
  ".webm",
])

export function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

const SAMPLE_FILE_RE = /^sample(?:[._-].*)?$/i

function isSampleFile(filename: string): boolean {
  const stem = path.basename(filename, path.extname(filename))
  return SAMPLE_FILE_RE.test(stem)
}

// Walk up from filePath to find its direct-child-of-libraryPathRoot ancestor (the series root folder).
function getSeriesRootDir(filePath: string, libraryPathRoot: string): string {
  const normalizedRoot = path.normalize(libraryPathRoot)
  let current = path.normalize(path.dirname(filePath))
  if (current === normalizedRoot) return libraryPathRoot
  while (true) {
    const parent = path.normalize(path.dirname(current))
    if (parent === normalizedRoot) return current
    if (parent === current) return path.dirname(filePath) // safety fallback
    current = parent
  }
}

// Return the name of the immediate subfolder of seriesRootDir that contains filePath,
// or null if the file lives directly inside seriesRootDir.
function getSeasonFolderNameBetween(filePath: string, seriesRootDir: string): string | null {
  const normalizedRoot = path.normalize(seriesRootDir)
  const normalizedParent = path.normalize(path.dirname(filePath))
  if (normalizedParent === normalizedRoot) return null
  let current = normalizedParent
  while (true) {
    const parent = path.normalize(path.dirname(current))
    if (parent === normalizedRoot) return path.basename(current)
    if (parent === current) return null // safety fallback
    current = parent
  }
}

function parseSeasonFolderName(folderName: string): number | null {
  const t = folderName.trim()
  // Specials / OVA / Extras → season 0
  if (/^(?:specials?|ova|extras?)$/i.test(t)) return 0
  // Exact: "Season 1", "season 01", "S01", "S1", "SE01", "Series 2"
  const exact = t.match(/^(?:season|series|se?)\s*0?(\d{1,2})$/i)
  if (exact) return parseInt(exact[1])
  // Embedded: "Girlfriend, Girlfriend Season 2"
  const embedded = t.match(/\bseason\s+0?(\d{1,2})\b/i)
  if (embedded) return parseInt(embedded[1])
  // Release-group folders: "Kanojo mo Kanojo S01 1080p...", "86 S01P01+SP..."
  const rel = t.match(/\bS0?(\d{1,2})\b/i)
  if (rel) return parseInt(rel[1])
  return null
}

function parseEpisodeFromFilename(filename: string): number | null {
  const base = path.basename(filename, path.extname(filename))
  // SxxExx / SxxEPxx — highest priority (the EP variant is used by some releases)
  const se = base.match(/[Ss]\d{1,2}[Ee][Pp]?(\d{1,3})/)
  if (se) return parseInt(se[1])
  // 1x01 format
  const x = base.match(/\b\d{1,2}[xX](\d{2,3})\b/)
  if (x) return parseInt(x[1])
  // E01 / EP01 standalone (we already returned above if SxxExx matched).
  // Lookarounds rather than \b so underscore/dot/hyphen separators count as
  // boundaries, e.g. "[Exiled-Destiny]_Ghost_Stories_Ep01_(...)".
  const e = base.match(/(?<![A-Za-z0-9])E[Pp]?(\d{1,3})(?![A-Za-z0-9])/)
  if (e) return parseInt(e[1])
  // "Episode 01" literal
  const ep = base.match(/\bepisode\s*(\d{1,3})\b/i)
  if (ep) return parseInt(ep[1])
  // SP00 specials: " - SP01" or "SP01"
  const sp = base.match(/\bSP(\d{1,3})\b/i)
  if (sp) return parseInt(sp[1])
  // Anime-style " - 01 - Title" / " - 01" at end (2–3 digit episode, not a
  // year). Separators may be spaces, dots or underscores, e.g.
  // "[Cleo]91_Days_-_01_(...)" or "[Anime Time] Show Season 02 - 04". The
  // leading hyphen is what marks it as an episode number rather than a year,
  // so this stays specific and won't grab "2007" from a movie title.
  const anime = base.match(/[\s._-]+-[\s._-]+(\d{2,3})(?:[\s._-]+-[\s._-]+|[\s._-]*$|[\s._-]*\()/)
  if (anime) return parseInt(anime[1])
  return null
}

function parseSeasonFromFilename(filename: string): number | null {
  const base = path.basename(filename, path.extname(filename))
  const se = base.match(/[Ss](\d{1,2})[Ee][Pp]?\d{1,3}/)
  if (se) return parseInt(se[1])
  const x = base.match(/\b(\d{1,2})[xX]\d{2,3}\b/)
  if (x) return parseInt(x[1])
  // "Season N" / "Season 02" literal in the filename — covers files that
  // carry season info as a word rather than SxxExx, e.g.
  // "Show Season 02 - 04" or "Show Season 1 Episode 01".
  const seasonWord = base.match(/\bseason\s*0?(\d{1,2})\b/i)
  if (seasonWord) return parseInt(seasonWord[1])
  return null
}

// True for fractional-episode filenames like "S01E18.5-…" — some anime insert a
// ".5" recap/extra between real episodes. parseEpisodeFromFilename reads these
// as the integer part (E18), which would land them as a duplicate of the real
// E18. They are extras, so callers route them to season 0 (specials) with no
// episode number instead.
//
// The lookahead `(?![.\d])` keeps the dot+digit we match as a true fractional
// marker: a single ".N" immediately followed by a non-digit/non-dot (a
// separator, a word, or end-of-name). This avoids false positives where the
// ".N" is really the start of something else glued onto the episode token:
//   - a resolution: "S01E01.720p" / "S01E01.1080p"  (the .7/.1 is "720"/"1080")
//   - a dotted title: "S01E01.1.23.45"               (the episode title "1:23:45")
// Both of those would otherwise be shoved to season 0. Real ".5" extras such as
// "S01E18.5", "S01E18.5-Recap", "S01E18.5 (Recap)" or "S01E18.5v2" still match
// because the fractional digit is followed by a separator, a letter, or end.
function isFractionalSpecial(filename: string): boolean {
  const base = path.basename(filename, path.extname(filename))
  return /[Ss]\d{1,2}[Ee][Pp]?\d{1,3}\.\d(?![.\d])/.test(base)
}

// A stable identity for a season folder so the pre-pass and the main scan
// loop agree on which episodes belong to the same season. The series root
// disambiguates two different shows that both happen to have a "Season 3".
function seasonFolderKey(seriesRoot: string, seasonFolder: string): string {
  return path.normalize(seriesRoot) + path.sep + seasonFolder
}

// Some releases put episodes in a season folder but number them as absolute,
// show-wide continuation numbers instead of 1-based per-season numbers — e.g. a
// "Season 03" folder whose files are "Show - 073 - Title" through "100". When a
// whole season folder uses absolute numbering (no SxxExx markers anywhere) and
// doesn't already start at 1, rebase so the lowest episode in that folder
// becomes episode 1 of the season, offsetting the rest by the same amount
// (073→1, 074→2, …, 100→28). Gaps in the source numbering are preserved. A
// folder that carries SxxExx anywhere is already 1-based per season and is left
// alone. Returns a map of season-folder key → offset where finalEpisode =
// parsedEpisode - offset.
function computeSeasonEpisodeRebase(
  videoFiles: string[],
  libraryRootPath: string,
): Map<string, number> {
  const groups = new Map<string, { min: number; hasSxxExx: boolean; any: boolean }>()
  for (const vf of videoFiles) {
    const seriesRoot = getSeriesRootDir(vf, libraryRootPath)
    const seasonFolder = getSeasonFolderNameBetween(vf, seriesRoot)
    if (seasonFolder === null) continue // files in the series root: no rebase
    if (isFractionalSpecial(vf)) continue // .5 extras → season 0, not part of a season's run
    const key = seasonFolderKey(seriesRoot, seasonFolder)
    const base = path.basename(vf, path.extname(vf))
    const hasSxxExx = /[Ss]\d{1,2}[Ee][Pp]?\d{1,3}/.test(base)
    const ep = parseEpisodeFromFilename(vf)
    let g = groups.get(key)
    if (!g) {
      g = { min: Number.POSITIVE_INFINITY, hasSxxExx: false, any: false }
      groups.set(key, g)
    }
    if (hasSxxExx) g.hasSxxExx = true
    if (ep !== null) {
      g.any = true
      if (ep < g.min) g.min = ep
    }
  }
  const offsets = new Map<string, number>()
  for (const [key, g] of groups) {
    if (!g.any || g.hasSxxExx || g.min <= 1) continue
    offsets.set(key, g.min - 1)
  }
  return offsets
}

type ScannedFiles = { videoFiles: string[]; srtFiles: string[] }

function findMediaFiles(dirPath: string): ScannedFiles {
  const videoFiles: string[] = []
  const srtFiles: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return { videoFiles, srtFiles }
  }
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      // Skip Jellyfin/Plex trickplay thumbnail bundles outright — they hold
      // hundreds of preview images per episode, never video or subtitles, and
      // recursing into them just slows the scan.
      if (entry.name.toLowerCase().endsWith(".trickplay")) continue
      const sub = findMediaFiles(full)
      videoFiles.push(...sub.videoFiles)
      srtFiles.push(...sub.srtFiles)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (VIDEO_EXTENSIONS.has(ext)) {
        if (!isSampleFile(entry.name)) videoFiles.push(full)
      } else if (isSubtitleExtension(ext)) {
        srtFiles.push(full)
      }
    }
  }
  return { videoFiles, srtFiles }
}

// Normalize a filename stem for companion matching: collapse runs of
// whitespace, dots, underscores and hyphens to a single dot and lowercase.
// Subtitle files often swap the video's separators (spaces vs dots vs
// underscores) and append a language tag, e.g. a video "Show - S01E01.mkv"
// ships with "Show.S01E01.en.ssa". A literal startsWith check misses those,
// so the .ssa gets its own translatable row instead of being grouped under
// the episode. Normalizing lets us match across separator styles while the
// trailing "." boundary (see findAllCompanionSrts) keeps "S01E01" from
// matching "S01E10".
function normalizeCompanionStem(stem: string): string {
  return stem.toLowerCase().replace(/[\s._-]+/g, ".")
}

function findAllCompanionSrts(videoFilePath: string): string[] {
  const dir = path.dirname(videoFilePath)
  const videoNorm = normalizeCompanionStem(path.basename(videoFilePath, path.extname(videoFilePath)))
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: string[] = []
  for (const e of entries) {
    if (!e.isFile() || !isSubtitleExtension(e.name)) continue
    const subExt = subtitleExtensionOf(e.name) ?? path.extname(e.name)
    const stem = e.name.endsWith(subExt) ? e.name.slice(0, e.name.length - subExt.length) : e.name
    const stemNorm = normalizeCompanionStem(stem)
    // Either the exact same stem (no language tag) or the video stem followed
    // by a dot-separated language/tag segment. The "." boundary is what
    // prevents "S01E01" from prefix-matching "S01E10".
    if (stemNorm === videoNorm || stemNorm.startsWith(videoNorm + ".")) {
      result.push(path.join(dir, e.name))
    }
  }
  return result
}

// Reconcile the bcookietranslated rows for one library path item against the
// BCookieSubs-translated subtitle files currently sitting next to its video. A
// file counts when it is a text subtitle (.srt/.ass/.ssa) named
// <videoBasename>.<langCode>.<ext> AND its content contains CREDIT_TEXT. The
// original-language export (<base>.<srcIso>.<ext>) also carries the marker but is
// not a translation, so files whose lang code matches the source iso are skipped.
// Runs every scan so a deleted translation file drops its row (and its badge);
// mtime caching avoids re-reading unchanged files on rescan.
function reconcileBcookieTranslatedForItem(
  db: Database.Database,
  itemId: number,
  videoFile: string,
  srcIso: string | null | undefined,
  srcIso2b: string | null | undefined,
): void {
  const videoNorm = normalizeCompanionStem(path.basename(videoFile, path.extname(videoFile)))
  const srcLower = (srcIso ?? "").toLowerCase()
  const src2bLower = (srcIso2b ?? "").toLowerCase()

  const companions = findAllCompanionSrts(videoFile)
  const existing = getBcookieTranslatedRowsForItem(db, itemId)
  if (companions.length === 0) {
    if (existing.length) replaceBcookieTranslatedForItem(db, itemId, [])
    return
  }
  const existingByPath = new Map<string, BcookieTranslatedRow>()
  for (const r of existing) existingByPath.set(r.detectedAtPath, r)

  const desired: BcookieTranslatedRow[] = []
  const seenLangIds = new Set<number>()
  for (const f of companions) {
    const subExt = subtitleExtensionOf(f)
    if (!subExt) continue // only text-subtitle translations (.srt/.ass/.ssa)
    const stem = f.endsWith(subExt) ? f.slice(0, f.length - subExt.length) : f
    const stemNorm = normalizeCompanionStem(path.basename(stem))
    if (!stemNorm.startsWith(videoNorm + ".")) continue // no lang tag → source subtitle
    const langCode = stemNorm.slice(videoNorm.length + 1).split(".")[0]
    if (!langCode) continue
    if (langCode === srcLower || (src2bLower && langCode === src2bLower)) continue // original-language export
    const lang = getLanguageByIso(db, langCode)
    if (!lang || seenLangIds.has(lang.id)) continue
    let mtime: number | null = null
    try {
      mtime = Math.floor(fs.statSync(f).mtimeMs)
    } catch {
      continue
    }
    const cached = existingByPath.get(f)
    if (cached && cached.fileMtimeMs === mtime) {
      // Unchanged since last scan — trust the previously-confirmed marker.
      desired.push({ languageId: lang.id, detectedAtPath: f, fileMtimeMs: mtime })
      seenLangIds.add(lang.id)
      continue
    }
    try {
      if (fs.readFileSync(f, "utf-8").includes(CREDIT_TEXT)) {
        desired.push({ languageId: lang.id, detectedAtPath: f, fileMtimeMs: mtime })
        seenLangIds.add(lang.id)
      }
    } catch {
      /* unreadable file — ignore */
    }
  }
  replaceBcookieTranslatedForItem(db, itemId, desired)
}

function selectBestSrt(
  companions: string[],
  standalone: string[],
  sourceLangIso639: string,
  sourceLangName: string,
): string | null {
  const pool = companions.length > 0 ? companions : standalone
  if (pool.length === 0) return null
  if (pool.length === 1) return pool[0]

  const lowerIso = sourceLangIso639.toLowerCase()
  const lowerName = sourceLangName.toLowerCase()

  const langMatches = pool.filter((f) => {
    const lower = path.basename(f).toLowerCase()
    const subExt = subtitleExtensionOf(lower)
    const base = subExt ? lower.slice(0, lower.length - subExt.length) : lower
    const lastDotPart = base.includes(".") ? base.split(".").pop()! : ""
    const hasLangSuffix = lastDotPart.length >= 2 && lastDotPart.length <= 8
    if (!hasLangSuffix) return true
    return lastDotPart === lowerIso || lastDotPart === lowerName
  })

  const candidates = langMatches.length > 0 ? langMatches : pool

  // Prefer text subtitle formats (.srt/.ass/.ssa) over image-based .sub/.sup,
  // which would force an OCR pass — only fall back to .sub/.sup when no text
  // companion exists. Among the same class, pick the largest file as before.
  const textCandidates = candidates.filter((f) => !isSubFile(f) && !isSupFile(f))
  const sameClass = textCandidates.length > 0 ? textCandidates : candidates

  return sameClass.reduce((best, f) => {
    try {
      return fs.statSync(f).size > fs.statSync(best).size ? f : best
    } catch {
      return best
    }
  })
}

// Language tokens (ISO 639-1 / 639-2/B codes + common English names) for the
// languages BCookieSubs typically translates. A subtitle whose entire stem is
// one of these — e.g. "english.srt", "spa.srt", "en.srt", "pt-BR.srt" — is a
// bare language tag with no movie title in the filename, so matching it on its
// own stem is garbage ("english" is not a movie). For movies we instead attach
// it to the owning video in the same folder tree (see findOwningVideoFile).
const LANGUAGE_NAME_TOKENS = new Set<string>([
  // ISO 639-2/B + 639-1 codes
  "eng", "en", "spa", "es", "fre", "fra", "fr", "ger", "de", "ita", "it", "por", "pt",
  "rus", "ru", "jpn", "ja", "kor", "ko", "chi", "zho", "zh", "ara", "ar", "hin", "hi",
  "tur", "tr", "dut", "nld", "nl", "pol", "pl", "swe", "sv", "nor", "no", "dan", "da",
  "fin", "fi", "gre", "ell", "el", "cze", "ces", "cs", "heb", "he", "hun", "hu", "rom",
  "ron", "ro", "tha", "th", "vie", "vi", "ind", "id", "may", "msa", "ms", "ukr", "uk",
  "bul", "bg", "hrv", "hr", "srp", "sr", "slk", "sk", "slv", "sl", "est", "et", "lav",
  "lv", "lit", "lt", "per", "fas", "fa", "cat", "ca", "glg", "gl", "ben", "bn", "tam",
  "ta", "tel", "te", "mal", "ml", "pan", "pa", "gla", "gd", "wel", "cym", "cy",
  // common English names
  "english", "spanish", "french", "german", "italian", "portuguese", "russian",
  "japanese", "korean", "chinese", "arabic", "hindi", "turkish", "dutch", "polish",
  "swedish", "norwegian", "danish", "finnish", "greek", "czech", "hebrew", "hungarian",
  "romanian", "thai", "vietnamese", "indonesian", "malay", "ukrainian", "bulgarian",
  "croatian", "serbian", "slovak", "slovenian", "estonian", "latvian", "lithuanian",
  "persian", "catalan", "galician", "bengali", "tamil", "telugu", "malayalam", "punjabi",
  "scottish", "welsh",
])

// True when a subtitle stem is just a language tag (optionally with a region or
// hearing-impaired suffix), carrying no movie title. The year guard keeps a
// stray "french.2007" from being misread as a bare language.
function isLanguageOnlyStem(stem: string): boolean {
  const raw = stem.trim().toLowerCase()
  if (!raw || /\b(?:19|20)\d{2}\b/.test(raw)) return false
  const parts = raw.split(/[._-]+/).filter(Boolean)
  if (parts.length === 0) return false
  if (!LANGUAGE_NAME_TOKENS.has(parts[0])) return false
  // Allow a single region/hearing-impaired suffix (e.g. "pt-BR", "en-SDH",
  // "es.HI"); anything longer than that is probably a real title.
  const suffix = parts.slice(1).join("-")
  if (suffix.length > 6) return false
  return true
}

// True when a subtitle sits inside a "subs"/"Subs" subfolder of a movie folder.
// RARBG/YTS releases ship many language tracks there with filenames that don't
// share the movie stem (e.g. "10_Finnish.srt", "English (SDH).eng.srt",
// "Français.fre.srt") — they fail isLanguageOnlyStem and would otherwise be
// garbage-matched on a language name. For movies every file in a subs folder
// belongs to the owning movie video, so we attach it the same way.
function isInSubsFolder(srtPath: string): boolean {
  return /^subs$/i.test(path.basename(path.dirname(srtPath)))
}

// True when a subtitle sits directly in the same folder as a movie video — i.e.
// directly in the movie folder, not in a "Subs" subfolder and not a companion
// (companions share the video stem and are grouped in the video loop, so they
// never reach the standalone-srt loop that calls this). For movies any subtitle
// next to the video belongs to that movie even when its filename is neither the
// video stem nor a bare language tag (e.g. a release-group label, a foreign
// title, or a renamed track). Without this, such a file is garbage-matched on
// its own stem instead of attaching to the owning movie.
function isInMovieVideoFolder(srtPath: string, videoFiles: string[]): boolean {
  const srtDir = path.normalize(path.dirname(srtPath))
  for (const vf of videoFiles) {
    if (path.normalize(path.dirname(vf)) === srtDir) return true
  }
  return false
}

// For a standalone subtitle, find the video file in the same folder tree whose
// directory is the nearest enclosing ancestor of the subtitle's directory
// (the "Subs" subfolder case: the subtitle lives one level under the video's
// folder). Returns the deepest-matching video, or null if none encloses it.
function findOwningVideoFile(srtPath: string, videoFiles: string[]): string | null {
  const srtDir = path.normalize(path.dirname(srtPath)) + path.sep
  let best: string | null = null
  let bestLen = -1
  for (const vf of videoFiles) {
    const vDir = path.normalize(path.dirname(vf))
    if (srtDir === vDir + path.sep || srtDir.startsWith(vDir + path.sep)) {
      if (vDir.length > bestLen) {
        best = vf
        bestLen = vDir.length
      }
    }
  }
  return best
}

// Extra/bonus content under a movie folder lives in a named subfolder
// ("Featurettes", "Extras", "Special Features", "Bonus"). Such a video is NOT
// the movie — it is a featurette that should attach to the owning movie. The
// folder name match is intentionally narrow (immediate parent dir only) so a
// real movie file sitting directly in the movie root is never misread as an
// extra.
function isInExtrasFolder(videoPath: string): boolean {
  return /^(featurettes?|extras?|special\s*features?|bonus)$/i.test(path.basename(path.dirname(videoPath)))
}

// For a featurette/extra, find the owning movie video: the deepest video whose
// directory is a strict ancestor of the extra's directory AND is not itself an
// extra (so a sibling featurette in the same "Featurettes" folder can't own
// another — findOwningVideoFile would wrongly pick that sibling). For
// "movieRoot/Featurettes/x.mkv" this returns the video in "movieRoot".
function findOwningMovieVideoForExtra(extraPath: string, videoFiles: string[]): string | null {
  const extraDir = path.normalize(path.dirname(extraPath))
  let best: string | null = null
  let bestLen = -1
  for (const vf of videoFiles) {
    if (isInExtrasFolder(vf)) continue // a sibling extra never owns another extra
    const vDir = path.normalize(path.dirname(vf))
    if (vDir === extraDir) continue // same folder as the extra
    if (extraDir.startsWith(vDir + path.sep) && vDir.length > bestLen) {
      best = vf
      bestLen = vDir.length
    }
  }
  return best
}

interface MkvSubTrack {
  id: number
  codec: string
  language: string | null
  // mkvmerge track_name (e.g. "Dialogue", "Signs / Songs", "Commentary"). Lets
  // the picker tell same-language tracks apart so the user doesn't pick the
  // signs/songs track expecting dialogue.
  title: string | null
  defaultTrack: boolean
  numIndexEntries: number
}

const MKV_TEXT_CODECS = new Set(["SubRip/SRT", "SubStationAlpha", "Advanced SubStation Alpha", "WebVTT"])

// Map a probed subtitle codec name (ffmpeg codec_name or mkvmerge codec) to the
// file extension to use when extracting that track. ASS/SSA tracks are
// extracted with -c:s copy so their structure is preserved byte-for-byte;
// other text codecs are converted to SRT as before.
function codecToSubtitleExt(codec: string | null | undefined): ".srt" | ".ass" | ".ssa" {
  if (!codec) return ".srt"
  const c = codec.toLowerCase()
  if (c === "ass" || c === "advanced substation alpha") return ".ass"
  if (c === "ssa" || c === "substationalpha") return ".ssa"
  return ".srt"
}

function isAssCodec(codec: string | null | undefined): boolean {
  const c = (codec ?? "").toLowerCase()
  return c === "ass" || c === "ssa" || c === "advanced substation alpha" || c === "substationalpha"
}

function probeMkvSubtitleTracks(videoFile: string): MkvSubTrack[] | null {
  try {
    const r = spawnSync("mkvmerge", ["-J", videoFile], { encoding: "utf-8", timeout: 15_000 })
    if (r.status !== 0 || r.error || !r.stdout) return null
    const data = JSON.parse(r.stdout) as { tracks?: any[] }
    return (data.tracks ?? [])
      .filter((t) => t.type === "subtitles" && MKV_TEXT_CODECS.has(t.codec))
      .map((t) => ({
        id: t.id as number,
        codec: t.codec as string,
        language: (t.properties?.language as string | undefined) ?? null,
        title: (t.properties?.track_name as string | undefined) ?? null,
        defaultTrack: Boolean(t.properties?.default_track),
        numIndexEntries: (t.properties?.num_index_entries as number | undefined) ?? 0,
      }))
  } catch {
    return null
  }
}

function extractMkvTrack(videoFile: string, trackId: number, outputPath: string): boolean {
  try {
    const r = spawnSync("mkvextract", ["tracks", videoFile, `${trackId}:${outputPath}`], {
      encoding: "utf-8",
      timeout: 60_000,
    })
    return r.status === 0 && !r.error && fs.existsSync(outputPath)
  } catch {
    return false
  }
}

const FFMPEG_TEXT_CODECS = new Set(["subrip", "srt", "mov_text", "ass", "ssa", "webvtt"])

interface FfSubStream {
  subtitleIndex: number
  language: string | null
  title: string | null
  codecName: string | null
}

function probeFfSubtitleStreams(videoFile: string): FfSubStream[] {
  try {
    const r = spawnSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "s", videoFile],
      { encoding: "utf-8", timeout: 15_000 },
    )
    if (r.status !== 0 || r.error) return []
    const data = JSON.parse(r.stdout) as { streams?: any[] }
    return (data.streams ?? [])
      .filter((s) => FFMPEG_TEXT_CODECS.has(s.codec_name))
      .map((s, i) => ({
        subtitleIndex: i,
        language: (s.tags?.language as string | undefined) ?? null,
        title: (s.tags?.title as string | undefined) ?? null,
        codecName: (s.codec_name as string | undefined) ?? null,
      }))
  } catch {
    return []
  }
}

function extractFfSubtitleStream(videoFile: string, subtitleIndex: number, outputPath: string, codec: string | null): boolean {
  try {
    // ASS/SSA: copy the track verbatim so styles/override tags survive. Other
    // text codecs are converted to SRT (the historical behavior).
    const codecFlag = isAssCodec(codec) ? "copy" : "srt"
    const r = spawnSync("ffmpeg", ["-i", videoFile, "-map", `0:s:${subtitleIndex}`, "-c:s", codecFlag, "-y", outputPath], {
      encoding: "utf-8",
      timeout: 60_000,
    })
    return r.status === 0 && !r.error && fs.existsSync(outputPath)
  } catch {
    return false
  }
}

// ─── Embedded image subtitles (VobSub / PGS) ─────────────────────────────────
// Image subtitle tracks carry bitmaps, not text. VobSub/DVD subtitles extract
// as a .sub + .idx pair and are OCR'd via vobSubOcrService. PGS/HDMV subtitles
// extract as a .sup and are OCR'd via pgsOcrService. Both are surfaced in the
// source picker as image-based / OCR-required.

interface MkvImageSubTrack {
  id: number
  codec: string
  language: string | null
  // mkvmerge track_name (e.g. "Dialogue", "Signs / Songs"). Without this the
  // picker can't distinguish two same-language PGS tracks, so a user picking
  // "the second subtrack" can accidentally grab the signs/songs track (which
  // has no dialogue) instead of the dialogue track.
  title: string | null
  defaultTrack: boolean
  numIndexEntries: number
  kind: "vobsub" | "pgs"
}

function probeMkvImageSubtitleTracks(videoFile: string): MkvImageSubTrack[] | null {
  try {
    const r = spawnSync("mkvmerge", ["-J", videoFile], { encoding: "utf-8", timeout: 15_000 })
    if (r.status !== 0 || r.error || !r.stdout) return null
    const data = JSON.parse(r.stdout) as { tracks?: any[] }
    return (data.tracks ?? [])
      .filter((t) => t.type === "subtitles")
      .map((t) => {
        const kind = imageSubtitleKindFromCodec(t.codec as string)
        if (!kind) return null
        return {
          id: t.id as number,
          codec: t.codec as string,
          language: (t.properties?.language as string | undefined) ?? null,
          title: (t.properties?.track_name as string | undefined) ?? null,
          defaultTrack: Boolean(t.properties?.default_track),
          numIndexEntries: (t.properties?.num_index_entries as number | undefined) ?? 0,
          kind,
        } as MkvImageSubTrack
      })
      .filter((t): t is MkvImageSubTrack => t !== null)
  } catch {
    return null
  }
}

// Extract an embedded VobSub track with mkvextract, which writes a .sub + .idx
// pair when the output path ends in .sub. Returns the .sub path on success
// (with the .idx sibling present), null otherwise.
function extractMkvVobSubTrack(videoFile: string, trackId: number, outputPath: string): boolean {
  try {
    const r = spawnSync("mkvextract", ["tracks", videoFile, `${trackId}:${outputPath}`], {
      encoding: "utf-8",
      timeout: 120_000,
    })
    return (
      r.status === 0 &&
      !r.error &&
      fs.existsSync(outputPath) &&
      fs.existsSync(outputPath.replace(/\.sub$/i, ".idx"))
    )
  } catch {
    return false
  }
}

// Extract an embedded PGS/HDMV track with mkvextract, which writes a .sup when
// the output path ends in .sup. Returns true on success (with the .sup present).
function extractMkvPgsTrack(videoFile: string, trackId: number, outputPath: string): boolean {
  try {
    const r = spawnSync("mkvextract", ["tracks", videoFile, `${trackId}:${outputPath}`], {
      encoding: "utf-8",
      timeout: 180_000,
    })
    return r.status === 0 && !r.error && fs.existsSync(outputPath)
  } catch {
    return false
  }
}

interface FfImageSubStream {
  subtitleIndex: number
  language: string | null
  title: string | null
  codecName: string | null
  kind: "vobsub" | "pgs"
}

function probeFfImageSubtitleStreams(videoFile: string): FfImageSubStream[] {
  try {
    const r = spawnSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "s", videoFile],
      { encoding: "utf-8", timeout: 15_000 },
    )
    if (r.status !== 0 || r.error) return []
    const data = JSON.parse(r.stdout) as { streams?: any[] }
    return (data.streams ?? [])
      .map((s, i) => {
        const codecName = (s.codec_name as string | undefined) ?? null
        const kind = imageSubtitleKindFromCodec(codecName)
        if (!kind) return null
        return {
          subtitleIndex: i,
          language: (s.tags?.language as string | undefined) ?? null,
          title: (s.tags?.title as string | undefined) ?? null,
          codecName,
          kind,
        } as FfImageSubStream
      })
      .filter((s): s is FfImageSubStream => s !== null)
  } catch {
    return []
  }
}

function trackLangMatches(trackLang: string | null, sourceIso1: string, sourceIso2b: string | null): boolean {
  if (!trackLang) return false
  const t = trackLang.toLowerCase()
  if (sourceIso2b && t === sourceIso2b.toLowerCase()) return true
  if (t === sourceIso1.toLowerCase()) return true
  return false
}

type ExtractOpts = {
  // Restrict extraction to a specific embedded track (by mkv/ffmpeg id/index).
  preferTrackId?: number | null
  // Restrict extraction to a codec family, e.g. "vobsub"/"dvd_subtitle" when the
  // user picked a VobSub image track from the source picker.
  preferCodec?: string | null
  // When false, image-based tracks (VobSub) are NOT considered as a fallback
  // (used by callers that only want a text subtitle). Default true.
  allowImageFallback?: boolean
}

function extractBestEmbeddedSrt(
  videoFile: string,
  sourceIso1: string,
  sourceIso2b: string | null,
  langName: string,
  opts: ExtractOpts = {},
): string | null {
  const stem = path.basename(videoFile, path.extname(videoFile))
  const ext = path.extname(videoFile).toLowerCase()
  const preferCodecKind = opts.preferCodec ? imageSubtitleKindFromCodec(opts.preferCodec) : null
  const allowImage = opts.allowImageFallback !== false

  if (ext === ".mkv") {
    const tracks = probeMkvSubtitleTracks(videoFile)
    if (tracks !== null) {
      const imageTracks = allowImage ? probeMkvImageSubtitleTracks(videoFile) ?? [] : []

      // If a specific VobSub track was requested, extract just that one.
      if (preferCodecKind === "vobsub" || (opts.preferTrackId != null && imageTracks.some((t) => t.id === opts.preferTrackId && t.kind === "vobsub"))) {
        const target = imageTracks.find((t) => t.kind === "vobsub" && (opts.preferTrackId == null || t.id === opts.preferTrackId))
        if (target) {
          const tag = target.language ?? `sub${target.id}`
          const outputPath = makeExtractTempPath(stem, tag, ".sub")
          if (extractMkvVobSubTrack(videoFile, target.id, outputPath)) return outputPath
        }
        return null
      }

      // If a specific PGS track was requested, extract it to a .sup (OCR path).
      if (preferCodecKind === "pgs" || (opts.preferTrackId != null && imageTracks.some((t) => t.id === opts.preferTrackId && t.kind === "pgs"))) {
        const target = imageTracks.find((t) => t.kind === "pgs" && (opts.preferTrackId == null || t.id === opts.preferTrackId))
        if (target) {
          const tag = target.language ?? `sub${target.id}`
          const outputPath = makeExtractTempPath(stem, tag, ".sup")
          if (extractMkvPgsTrack(videoFile, target.id, outputPath)) return outputPath
        }
        return null
      }

      if (tracks.length === 0) {
        // No text tracks — fall back to an image track (VobSub or PGS, OCR
        // path). When several image tracks exist, pick the one with the MOST
        // subtitles (num_index_entries) so the OCR yields the densest transcript.
        // NOTE: the MKV `default_track` flag is NOT a good primary signal here —
        // for PGS it frequently marks the "Signs / Songs" track (the one players
        // show by default for on-screen foreign text), which has far fewer
        // subtitles than the dialogue track. Subtitle count wins; default and
        // track id only break ties.
        if (allowImage) {
          const imagePool = imageTracks
          if (imagePool.length > 0) {
            const langMatch = imagePool.filter((t) => trackLangMatches(t.language, sourceIso1, sourceIso2b))
            const pool = langMatch.length > 0 ? langMatch : imagePool
            const sorted = [...pool].sort((a, b) => {
              if (b.numIndexEntries !== a.numIndexEntries) return b.numIndexEntries - a.numIndexEntries
              if (a.defaultTrack !== b.defaultTrack) return a.defaultTrack ? -1 : 1
              return a.id - b.id
            })
            for (const track of sorted) {
              const tag = track.language ?? `sub${track.id}`
              const ext = track.kind === "pgs" ? ".sup" : ".sub"
              const outputPath = makeExtractTempPath(stem, tag, ext)
              const ok = track.kind === "pgs"
                ? extractMkvPgsTrack(videoFile, track.id, outputPath)
                : extractMkvVobSubTrack(videoFile, track.id, outputPath)
              if (ok) return outputPath
            }
          }
        }
        return null
      }

      const langMatch = tracks.filter((t) => trackLangMatches(t.language, sourceIso1, sourceIso2b))
      const pool = langMatch.length > 0 ? langMatch : tracks

      const sorted = [...pool].sort((a, b) => {
        if (a.defaultTrack !== b.defaultTrack) return a.defaultTrack ? -1 : 1
        return b.numIndexEntries - a.numIndexEntries
      })

      for (const track of sorted) {
        if (opts.preferTrackId != null && track.id !== opts.preferTrackId) continue
        const tag = track.language ?? `sub${track.id}`
        const outputPath = makeExtractTempPath(stem, tag, codecToSubtitleExt(track.codec))
        if (extractMkvTrack(videoFile, track.id, outputPath)) return outputPath
      }
      return null
    }
  }

  const streams = probeFfSubtitleStreams(videoFile)
  const imageStreams = allowImage ? probeFfImageSubtitleStreams(videoFile) : []

  // Specific VobSub track requested (non-MKV container).
  if (preferCodecKind === "vobsub") {
    const vobsubStreams = imageStreams.filter((s) => s.kind === "vobsub")
    if (vobsubStreams.length > 0) {
      const target = vobsubStreams.find((s) => opts.preferTrackId == null || s.subtitleIndex === opts.preferTrackId) ?? vobsubStreams[0]
      const tag = target.language ?? `sub${target.subtitleIndex}`
      const outputPath = makeExtractTempPath(stem, tag, ".sub")
      // ffmpeg can copy dvd_subtitle to a raw .sub (VobSub) for some containers.
      const r = spawnSync(
        "ffmpeg",
        ["-y", "-i", videoFile, "-map", `0:s:${target.subtitleIndex}`, "-c:s", "copy", outputPath],
        { encoding: "utf-8", timeout: 120_000 },
      )
      if (r.status === 0 && !r.error && fs.existsSync(outputPath) && fs.existsSync(outputPath.replace(/\.sub$/i, ".idx"))) {
        return outputPath
      }
    }
    return null
  }

  // Specific PGS track requested (non-MKV container).
  if (preferCodecKind === "pgs") {
    const pgsStreams = imageStreams.filter((s) => s.kind === "pgs")
    if (pgsStreams.length > 0) {
      const target = pgsStreams.find((s) => opts.preferTrackId == null || s.subtitleIndex === opts.preferTrackId) ?? pgsStreams[0]
      const tag = target.language ?? `sub${target.subtitleIndex}`
      const outputPath = makeExtractTempPath(stem, tag, ".sup")
      // ffmpeg can copy hdmv_pgs_subtitle to a raw .sup for some containers.
      const r = spawnSync(
        "ffmpeg",
        ["-y", "-i", videoFile, "-map", `0:s:${target.subtitleIndex}`, "-c:s", "copy", outputPath],
        { encoding: "utf-8", timeout: 180_000 },
      )
      if (r.status === 0 && !r.error && fs.existsSync(outputPath)) {
        return outputPath
      }
    }
    return null
  }

  if (streams.length === 0) return null

  const lowerName = langName.toLowerCase()
  const langMatch = streams.filter((s) => {
    if (trackLangMatches(s.language, sourceIso1, sourceIso2b)) return true
    const title = s.title?.toLowerCase() ?? ""
    return (
      title.includes(sourceIso1.toLowerCase()) ||
      (sourceIso2b && title.includes(sourceIso2b.toLowerCase())) ||
      title.includes(lowerName)
    )
  })
  const pool = langMatch.length > 0 ? langMatch : streams

  for (const stream of pool) {
    if (opts.preferTrackId != null && stream.subtitleIndex !== opts.preferTrackId) continue
    const tag = stream.language ?? `sub${stream.subtitleIndex}`
    const outputPath = makeExtractTempPath(stem, tag, codecToSubtitleExt(stream.codecName))
    if (extractFfSubtitleStream(videoFile, stream.subtitleIndex, outputPath, stream.codecName)) return outputPath
  }
  return null
}

function buildDisplayName(mediaItem: any | null): string | null {
  if (!mediaItem) return null
  return mediaItem.title
}

function buildExtractFileName(
  mediaItem: any | null,
  season: number | null,
  episode: number | null,
  fallbackStem: string,
  ext: ".srt" | ".ass" | ".ssa" = ".srt",
): string {
  if (!mediaItem) return `${fallbackStem}${ext}`
  const sanitized = mediaItem.title
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, ".")
    .trim()
  let name = sanitized
  if (season != null && episode != null) {
    name += `.S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
  }
  if (mediaItem.year) name += `.(${mediaItem.year})`
  return `${name}${ext}`
}

export type ResolvedSrt = { path: string; isTemp: boolean }

export function findCompanionSrt(
  videoFilePath: string,
  sourceLangIso639: string,
  sourceLangIso2b: string | null = null,
  sourceLangName = "",
  opts: ExtractOpts = {},
): ResolvedSrt | null {
  // When a specific image track/codec was chosen, skip companion-file
  // selection and go straight to embedded extraction.
  if (opts.preferCodec || opts.preferTrackId != null) {
    const extracted = extractBestEmbeddedSrt(videoFilePath, sourceLangIso639, sourceLangIso2b, sourceLangName, opts)
    return extracted ? { path: extracted, isTemp: true } : null
  }
  const companions = findAllCompanionSrts(videoFilePath)
  const best = selectBestSrt(companions, [], sourceLangIso639, sourceLangName)
  if (best) return { path: best, isTemp: false }
  const extracted = extractBestEmbeddedSrt(videoFilePath, sourceLangIso639, sourceLangIso2b, sourceLangName, opts)
  return extracted ? { path: extracted, isTemp: true } : null
}

export type SubtitleSourceCandidate = {
  type: "embedded" | "external"
  path: string
  isTemp: boolean
  label: string
  language: string | null
  codec: string | null
  filename: string | null
  filenameOnly: string
  // True for image-based sources (VobSub .sub+.idx, embedded VobSub/PGS, .sup)
  // that must be OCR'd before translation.
  imageBased?: boolean
  // True when BCookieSubs will OCR this source with Tesseract (VobSub / PGS).
  requiresOcr?: boolean
  // Tesseract language code derived from the source language, surfaced so the
  // picker can show/override it.
  ocrLang?: string | null
  // Embedded track id/index, sent back to re-extract the exact chosen track.
  trackId?: number | null
  // Embedded track title/name from the container (e.g. "Dialogue",
  // "Signs / Songs"). Surfaced in the picker so the user can distinguish
  // same-language image tracks — the most common reason for "missing dialogue"
  // is picking the signs/songs track by mistake.
  title?: string | null
  // Image-based but no OCR pipeline is implemented. Currently unused (VobSub and
  // PGS both have OCR pipelines); kept for future formats the picker should
  // disable.
  unsupported?: boolean
  // Image subtitle family: "vobsub" (VobSub .sub+.idx), "pgs" (PGS/.sup), or
  // "text" for a text .sub (MicroDVD/SubViewer). null for srt/ass/ssa.
  subKind?: "vobsub" | "pgs" | "text" | null
  // For image tracks: number of mkvmerge index entries (~2x subtitle count).
  // The picker ranks image sources by this so the densest dialogue track sorts
  // ahead of sparse "Signs / Songs" tracks. 0/undefined for text sources.
  numIndexEntries?: number
  // For image-based sources: the number of subtitle pictures/bitmap events the
  // source contains — parsed from the .sup (PGS) / .idx (VobSub) for external
  // files, or numIndexEntries for embedded tracks (no extraction at list time).
  // The picker orders image sources by this DESC and displays it so the user
  // can tell the dialogue track from sparse "Signs / Songs" tracks. Undefined
  // for text sources or when the count could not be determined.
  pictureCount?: number
}

function externalCandidatesFor(videoFilePath: string): string[] {
  return findAllCompanionSrts(videoFilePath)
}

type EmbeddedCandidateInfo = {
  trackId: number
  language: string | null
  codec: string
  kind: "text" | "vobsub" | "pgs"
  // Track title/name from the container (mkvmerge track_name / ffprobe tag).
  // Surfaced in the picker so the user can tell "Dialogue" from "Signs / Songs".
  title: string | null
  // Number of subtitle index entries (= roughly 2x subtitle count) for image
  // tracks. Used to rank image tracks so the densest dialogue track sorts ahead
  // of sparse "Signs / Songs" tracks. 0 for text tracks (not ranked).
  numIndexEntries: number
}

function embeddedCandidatesFor(videoFilePath: string, ext: string): EmbeddedCandidateInfo[] {
  const out: EmbeddedCandidateInfo[] = []
  if (ext === ".mkv") {
    const tracks = probeMkvSubtitleTracks(videoFilePath)
    if (tracks) {
      for (const t of tracks) out.push({ trackId: t.id, language: t.language, codec: t.codec, kind: "text", title: t.title, numIndexEntries: t.numIndexEntries })
      const imageTracks = probeMkvImageSubtitleTracks(videoFilePath)
      if (imageTracks) {
        for (const t of imageTracks) out.push({ trackId: t.id, language: t.language, codec: t.codec, kind: t.kind, title: t.title, numIndexEntries: t.numIndexEntries })
      }
      return out
    }
  }
  for (const s of probeFfSubtitleStreams(videoFilePath)) {
    out.push({ trackId: s.subtitleIndex, language: s.language, codec: s.codecName ?? "embedded", kind: "text", title: s.title, numIndexEntries: 0 })
  }
  for (const s of probeFfImageSubtitleStreams(videoFilePath)) {
    out.push({ trackId: s.subtitleIndex, language: s.language, codec: s.codecName ?? s.kind, kind: s.kind, title: s.title, numIndexEntries: 0 })
  }
  return out
}

// Count the subtitle pictures/bitmap events in an external image source, for
// ordering + display in the source picker. PGS (.sup) events come from
// parsePgsSup; VobSub (.sub+.idx) events come from parseVobSubIdx. Returns
// undefined when the file is missing/malformed so the picker still works —
// ordering falls back to 0 and the count simply isn't shown.
function countExternalPictures(filePath: string, subKind: "vobsub" | "pgs"): number | undefined {
  try {
    if (subKind === "pgs") {
      return parsePgsSup(filePath).events.length
    }
    const idxPath = filePath.replace(/\.sub$/i, ".idx")
    if (!fs.existsSync(idxPath)) return undefined
    return parseVobSubIdx(idxPath).events.length
  } catch {
    return undefined
  }
}

// Count the subtitle pictures/bitmap events in embedded image tracks. mkvmerge's
// `num_index_entries` track property is only present for files mkvmerge itself
// muxed, so for typical MKVs (MakeMKV/downloaded) it reads as 0 — which is why
// embedded PGS/VobSub tracks used to always display "0 pictures". Instead we
// extract each image track with a single mkvextract call (one file scan for all
// tracks), parse the resulting .sup/.idx for the real event count, and clean up
// the temp files. Returns a Map< trackId, count >. Best-effort: a track that
// fails to extract/parse is simply absent from the map (no badge shown).
function countEmbeddedPicturesBatch(
  videoFilePath: string,
  tracks: { trackId: number; kind: "vobsub" | "pgs" }[],
): Map<number, number> {
  const result = new Map<number, number>()
  if (tracks.length === 0) return result
  const stem = path.basename(videoFilePath, path.extname(videoFilePath))
  const temps: { trackId: number; kind: "vobsub" | "pgs"; subPath: string; idxPath: string | null }[] = []
  const args = ["tracks", videoFilePath]
  for (const t of tracks) {
    const ext = t.kind === "vobsub" ? ".sub" : ".sup"
    const subPath = makeExtractTempPath(stem, `count-track-${t.trackId}`, ext)
    temps.push({
      trackId: t.trackId,
      kind: t.kind,
      subPath,
      idxPath: t.kind === "vobsub" ? subPath.replace(/\.sub$/i, ".idx") : null,
    })
    args.push(`${t.trackId}:${subPath}`)
  }
  try {
    // mkvextract exits non-zero if ANY track fails, but partial outputs may still
    // exist — parse whichever temp files are present so one bad track doesn't
    // hide the rest.
    spawnSync("mkvextract", args, { encoding: "utf-8", timeout: 180_000 })
    for (const tp of temps) {
      try {
        if (tp.kind === "pgs") {
          if (fs.existsSync(tp.subPath)) result.set(tp.trackId, parsePgsSup(tp.subPath).events.length)
        } else if (tp.idxPath && fs.existsSync(tp.idxPath)) {
          result.set(tp.trackId, parseVobSubIdx(tp.idxPath).events.length)
        }
      } catch {
        /* skip this track */
      }
    }
  } catch {
    /* mkvextract unavailable / failed — leave counts absent */
  } finally {
    for (const tp of temps) {
      try {
        if (fs.existsSync(tp.subPath)) fs.unlinkSync(tp.subPath)
      } catch {
        /* ignore */
      }
      if (tp.idxPath) {
        try {
          if (fs.existsSync(tp.idxPath)) fs.unlinkSync(tp.idxPath)
        } catch {
          /* ignore */
        }
      }
    }
  }
  return result
}

export function listSubtitleSourcesForVideo(
  videoFilePath: string,
  sourceLangIso639: string,
  sourceLangIso2b: string | null = null,
  sourceLangName = "",
  opts: { withPictureCounts?: boolean } = {},
): SubtitleSourceCandidate[] {
  // Computing picture counts for embedded image tracks requires extracting them
  // (mkvextract). Callers that only need to know *whether* an embedded track
  // exists (e.g. extraHasEmbedded) pass { withPictureCounts: false } to skip the
  // extraction. The picker endpoint offloads the full call to the translate-prep
  // worker so the extraction runs off the Express event loop.
  const withPictureCounts = opts.withPictureCounts !== false
  const result: SubtitleSourceCandidate[] = []
  const ext = path.extname(videoFilePath).toLowerCase()
  const stem = path.basename(videoFilePath, path.extname(videoFilePath))
  const ocrLangDefault = resolveOcrLang(sourceLangIso639, sourceLangIso2b, sourceLangName)

  for (const srt of externalCandidatesFor(videoFilePath)) {
    const filename = path.basename(srt)
    const fileExt = subtitleFileExtensionOf(filename) ?? ".srt"
    const isSub = isSubFile(filename)
    const isSup = isSupFile(filename)
    // .sub is image-based only when a sibling .idx exists (VobSub); a text .sub
    // (MicroDVD/SubViewer) is parsed directly without OCR. .sup is always
    // image-based (PGS) and OCR'd.
    const subKind: "vobsub" | "pgs" | "text" | null = isSup
      ? "pgs"
      : isSub
        ? (fs.existsSync(srt.replace(/\.sub$/i, ".idx")) ? "vobsub" : "text")
        : null
    const imageBased = subKind === "vobsub" || subKind === "pgs"
    result.push({
      type: "external",
      path: srt,
      isTemp: false,
      label: filename,
      language: null,
      codec: fileExt,
      filename,
      filenameOnly: filename,
      imageBased,
      requiresOcr: imageBased,
      ocrLang: imageBased ? ocrLangDefault : null,
      trackId: null,
      unsupported: false,
      subKind,
      pictureCount:
        withPictureCounts && imageBased && subKind !== null && (subKind === "vobsub" || subKind === "pgs")
          ? countExternalPictures(srt, subKind)
          : undefined,
    })
  }

  const embedded = embeddedCandidatesFor(videoFilePath, ext)
  // Extract every embedded image track in one mkvextract pass and parse the
  // resulting .sup/.idx for the real picture count. mkvmerge's num_index_entries
  // is only present for files mkvmerge muxed, so for typical MKVs it reads 0 —
  // extraction is what gives an accurate, non-zero count. mkvextract only handles
  // .mkv, so skip it (and leave counts absent) for other containers.
  const embeddedImageTracks = embedded
    .filter((t) => t.kind === "vobsub" || t.kind === "pgs")
    .map((t) => ({ trackId: t.trackId, kind: t.kind as "vobsub" | "pgs" }))
  const embeddedPictureCounts =
    withPictureCounts && ext === ".mkv" && embeddedImageTracks.length > 0
      ? countEmbeddedPicturesBatch(videoFilePath, embeddedImageTracks)
      : new Map<number, number>()

  for (const track of embedded) {
    const langTag = track.language ?? `track-${track.trackId}`
    const isImage = track.kind === "vobsub" || track.kind === "pgs"
    // VobSub extracts to .sub (+.idx); PGS extracts to .sup; text uses codec ext.
    const trackExt = track.kind === "vobsub" ? ".sub" : track.kind === "pgs" ? ".sup" : codecToSubtitleExt(track.codec)
    const tempPath = makeExtractTempPath(stem, langTag, trackExt)
    // Include the track title ("Dialogue" vs "Signs / Songs") in the label when
    // present so the user can pick the right one. Fall back to a kind hint for
    // image tracks with no title so it's still obvious which carries dialogue.
    const titlePart = track.title
      ? track.title
      : isImage
        ? "untitled image track"
        : null
    result.push({
      type: "embedded",
      path: tempPath,
      isTemp: true,
      label: titlePart
        ? `Embedded · ${track.codec} · ${track.language ?? "unknown"} · ${titlePart}`
        : `Embedded · ${track.codec} · ${track.language ?? "unknown"}`,
      language: track.language,
      codec: track.codec,
      filename: null,
      filenameOnly: `${stem}.${langTag}${trackExt}`,
      imageBased: isImage,
      requiresOcr: isImage,
      ocrLang: isImage ? resolveOcrLang(track.language, sourceLangIso639, sourceLangIso2b, sourceLangName) : null,
      trackId: track.trackId,
      title: track.title,
      unsupported: false,
      subKind: track.kind === "vobsub" ? "vobsub" : track.kind === "pgs" ? "pgs" : null,
      numIndexEntries: track.numIndexEntries,
      // Real picture count from extraction+parse (see countEmbeddedPicturesBatch);
      // undefined when counting was skipped or the track couldn't be parsed.
      pictureCount: isImage && withPictureCounts ? embeddedPictureCounts.get(track.trackId) : undefined,
    })
  }

  // Default ordering: external text first, then embedded text, then image-based
  // (OCR) sources last so the cheapest path is presented first. Within the
  // image-based group, rank by pictureCount DESC so the dialogue track (most
  // pictures) sorts ahead of sparse "Signs / Songs" tracks — these often share
  // a language and only the picture count reliably distinguishes them.
  const rank = (r: SubtitleSourceCandidate): number => {
    if (r.unsupported) return 3
    if (r.requiresOcr || r.imageBased) return 2
    if (r.type === "external") return 0
    return 1
  }
  result.sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    // Within the same rank group, image-based sources are ordered by picture
    // count (densest first); everything else keeps insertion order (stable).
    if (ra === 2 && ra === rb) {
      return (b.pictureCount ?? 0) - (a.pictureCount ?? 0)
    }
    return 0
  })

  // Mark preferred (matches source lang) for the picker
  const sourceLangLc = (sourceLangIso639 || "").toLowerCase()
  const sourceNameLc = (sourceLangName || "").toLowerCase()
  const source2bLc = (sourceLangIso2b || "").toLowerCase()
  for (const r of result) {
    if (r.type === "embedded" && r.language) {
      const t = r.language.toLowerCase()
      if (
        (source2bLc && t === source2bLc) ||
        t === sourceLangLc ||
        (sourceNameLc && t === sourceNameLc)
      ) {
        r.label = `★ ${r.label}`
      }
    }
  }
  return result
}

export function pickSubtitleSource(
  candidates: SubtitleSourceCandidate[],
  sourceLangIso639: string,
  sourceLangIso2b: string | null = null,
  sourceLangName = "",
): SubtitleSourceCandidate | null {
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  // Prefer embedded tracks matching source language
  const sourceLangLc = (sourceLangIso639 || "").toLowerCase()
  const sourceNameLc = (sourceLangName || "").toLowerCase()
  const source2bLc = (sourceLangIso2b || "").toLowerCase()
  const embeddedMatches = candidates.filter(
    (c) => c.type === "embedded" && c.language &&
      (c.language.toLowerCase() === sourceLangLc ||
        (source2bLc && c.language.toLowerCase() === source2bLc) ||
        (sourceNameLc && c.language.toLowerCase() === sourceNameLc)),
  )
  if (embeddedMatches.length > 0) return embeddedMatches[0]
  // Else, prefer any embedded
  const embeddedAny = candidates.find((c) => c.type === "embedded")
  if (embeddedAny) return embeddedAny
  return candidates[0]
}

export function resolveSubtitleSourceFromCandidate(
  candidate: SubtitleSourceCandidate,
  sourceLangIso639: string,
  sourceLangIso2b: string | null = null,
  sourceLangName = "",
): ResolvedSrt | null {
  if (candidate.type === "external") {
    return { path: candidate.path, isTemp: false }
  }
  if (isSubtitleExtension(candidate.path) && fs.existsSync(candidate.path)) {
    return { path: candidate.path, isTemp: true }
  }
  // Re-extract from media
  return findCompanionSrt(candidate.path.split(".").slice(0, -2).join(".") + ".mp4", sourceLangIso639, sourceLangIso2b, sourceLangName)
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

interface NfoMetadata {
  title: string | null
  originalTitle: string | null
  year: number | null
  genres: string | null
  tmdbId: number | null
  // Raw <art><poster> text from the NFO (an absolute path from the original
  // media server — usually not valid locally after the files are pulled down).
  posterValue: string | null
}

// Read the title / original title / year / genres / tmdb id / poster path out of
// a Jellyfin/Kodi .nfo. These files ship with the media when it is exported
// from a media server, so when one is present it is a richer and cheaper source
// of truth than guessing the title from the filename and querying
// TheMovieDatabase.
function parseNfoFile(nfoPath: string): NfoMetadata | null {
  let content: string
  try {
    content = fs.readFileSync(nfoPath, "utf-8")
  } catch {
    return null
  }

  // An episode .nfo (<episodedetails>) carries the episode's title, its
  // thumbnail, and an episode-level tmdb id — none of which identify the
  // show. Refuse it so the caller falls back to folder-id / name-detection
  // instead of building a media item titled after episode 1.
  if (/<episodedetails\b/i.test(content)) return null

  const pick = (tag: string): string | null => {
    const m = content.match(new RegExp(`<${tag}[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i"))
    if (!m) return null
    const v = m[1].trim()
    return v === "" ? null : decodeXmlEntities(v)
  }

  const title = pick("title")
  const originalTitle = pick("originaltitle")

  let year: number | null = null
  const yearStr = pick("year")
  if (yearStr) {
    const ym = yearStr.match(/(\d{4})/)
    if (ym) year = parseInt(ym[1])
  }
  if (year === null) {
    for (const t of ["premiered", "releasedate", "aired"]) {
      const d = pick(t)
      if (d) {
        const ym = d.match(/(\d{4})/)
        if (ym) {
          year = parseInt(ym[1])
          break
        }
      }
    }
  }

  const genreMatches = [...content.matchAll(/<genre>\s*([^\s<][^<]*?)\s*<\/genre>/gi)]
  const genreList = genreMatches
    .map((m) => decodeXmlEntities(m[1].trim()))
    .filter((g) => g.length > 0)
  const genres = genreList.length > 0 ? genreList.join(", ") : null

  let tmdbId: number | null = null
  const tmdbXml =
    content.match(/<tmdbid>\s*(\d+)\s*<\/tmdbid>/i) ??
    content.match(/<uniqueid[^>]+type=["']tmdb["'][^>]*>\s*(\d+)\s*<\/uniqueid>/i)
  if (tmdbXml) {
    tmdbId = parseInt(tmdbXml[1])
  } else {
    const urlMatch = content.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/)
    if (urlMatch) tmdbId = parseInt(urlMatch[1])
  }

  let posterValue: string | null = null
  const artMatch = content.match(/<art>([\s\S]*?)<\/art>/i)
  if (artMatch) {
    const posterMatch = artMatch[1].match(/<poster>\s*([^\s<][^<]*?)\s*<\/poster>/i)
    if (posterMatch) posterValue = decodeXmlEntities(posterMatch[1].trim())
  }

  return { title, originalTitle, year, genres, tmdbId, posterValue }
}

// Prefer the canonical Jellyfin/Kodi filename (movie.nfo / tvshow.nfo) and,
// for MOVIES only, fall back to any other .nfo in the folder (e.g. a
// release-named "Free Guy.nfo"). For SERIES, never fall back: a series root
// without a tvshow.nfo almost certainly contains per-episode .nfo files
// (<episodedetails>), and matching against one would use the episode's title
// and episode thumbnail as if they were the show's — producing a garbage
// media item named after episode 1. Returning null lets the caller fall
// through to the folder-id / name-detection paths instead.
function findPrimaryNfoPath(dir: string, libraryType: "movie" | "series"): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const nfos = entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === ".nfo")
    .map((e) => path.join(dir, e.name))
  if (nfos.length === 0) return null
  const preferred = libraryType === "movie" ? "movie.nfo" : "tvshow.nfo"
  const canonical = nfos.find((p) => path.basename(p).toLowerCase() === preferred)
  if (canonical) return canonical
  return libraryType === "movie" ? nfos[0] : null
}

// Resolve the NFO's poster reference to an actual image file on disk. The
// <art><poster> value is an absolute path from the original media server and
// will not exist on the local machine after the media was pulled down, so try
// the literal path first, then the poster's basename next to the NFO, then in
// a "metadata" subfolder (where Jellyfin stores episode thumbs). Returns null
// when no image can be found — the caller then falls back to a TMDB fetch.
function resolveNfoPoster(nfoPath: string, posterValue: string | null): string | null {
  if (!posterValue) return null
  const nfoDir = path.dirname(nfoPath)
  const base = path.basename(posterValue)
  const candidates = [posterValue, path.join(nfoDir, base), path.join(nfoDir, "metadata", base)]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch {
      // ignore unreadable candidate
    }
  }
  return null
}

function getSeriesDetectionName(filePath: string, libraryPathRoot: string): string {
  const seriesRoot = getSeriesRootDir(filePath, libraryPathRoot)
  return path.basename(seriesRoot)
}

// Parse an embedded TMDB id from a Jellyfin/Plex-style folder name, e.g.
// "Captain America: Civil War (2016) [tmdbid-271110]" or "... {tmdb-271110}".
// Recognises the common "tmdb"/"tmdbid" tags as well as the "tmbid" misspelling
// some metadata tools emit (e.g. "[tmbid-42942]").
function parseTmdbIdFromFolderName(folderName: string): number | null {
  const m = folderName.match(/[[{]\s*tm(?:db(?:id)?|bid)-(\d+)\s*[\]}]/i)
  return m ? parseInt(m[1]) : null
}

// Strip id/source tags so the LLM matcher sees a clean title, e.g.
// "Captain America: Civil War (2016) [tmdbid-271110]" -> "Captain America: Civil War (2016)".
// Recognises tmdb/tmdbid/tmbid alongside imdb/tvdb variants.
function stripFolderIdTags(folderName: string): string {
  return folderName
    .replace(/[[{]\s*(?:tm(?:db(?:id)?|bid)|imdb|tvdb)-[^\]}]*[\]}]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

// Release-group/source/codec/resolution tokens that appear in scene release
// filenames but carry no title information. Stripping them lets the name
// formatter and TMDB search see "Superman 2025" instead of
// "Superman.2025.1080p.WEB-DL.x264", which otherwise confuses title/year
// extraction (the model sometimes keeps "1080p" as part of the title or reads
// the wrong year). The release year itself is intentionally NOT stripped — it
// is meaningful and the name formatter extracts it separately.
const RELEASE_TOKEN_RE =
  /(?<![A-Za-z0-9])(?:2160p|1080p|720p|576p|480p|4k|uhd|hdr10|hdr|dv|dovi|10bit|8bit|sdr|web-?dl|web-?rip|webrip|webdl|blu-?ray|bdrip|brrip|dvdrip|dvdscr|remux|hdrip|hdtv|pdtv|dsrtv|cam|ts-?hdtc|tc|scr|satrip|tvrip|x264|x265|h264|h265|hevc|avc|vc1|vp9|av1|aac|ac3|eac3|ddp|dd|dts-?hd|dts-?ma|truehd|atmos|5[ .]1|7[ .]1|2[ .]0|2ch|6ch|8ch|repack|proper|internal|limited|festival|3d|imax|nf|amzn|atvp|cmor|hulu|dsnp|starz|crchd|galaxyrg|rarbg|yts|ettv|eztv|tigole|joy|psa|rmteam|footographe|nikita|d3g|telly)(?![A-Za-z0-9])/gi

// Strip release tokens from a release filename stem/folder and normalise
// dots/underscores to spaces. Hyphens are kept so the regex can match
// hyphenated release tokens (WEB-DL, Blu-Ray, DTS-HD) while title hyphens
// (Spider-Man, X-Men) are preserved. The title and any 4-digit year are kept.
function stripReleaseTokens(name: string): string {
  if (!name) return name
  return name
    .replace(/[._]+/g, " ")
    .replace(RELEASE_TOKEN_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
}

async function matchMediaForFile(
  db: Database.Database,
  adminUser: DBUser,
  fileName: string,
  libraryType: "movie" | "series",
  libraryPathRoot: string,
): Promise<{
  mediaItemId: number | null
  multipleMatches: boolean
  candidateMediaItemIds: number[]
  season: number | null
  episode: number | null
  detectedYear: number | null
}> {
  let season: number | null = null
  let episode: number | null = null
  let detectedYear: number | null = null
  let candidateMediaItemIds: number[] = []

  // NFO-first matching. A Jellyfin/Kodi .nfo carried next to the media carries
  // the title, year, genres, a poster reference and (often) a tmdb id. When the
  // NFO has a title plus a poster image that actually exists on disk plus
  // genres, that is enough to identify the media with no TheMovieDatabase call
  // at all — so both the AI name-detection and the TMDB fetch are skipped,
  // which makes the library scan a lot faster. Match order is NFO first, then
  // the tmdb id embedded in the folder name, then AI name-detection from the
  // folder name. Look for the canonical movie.nfo / tvshow.nfo before any
  // other .nfo in the folder.
  const nfoDir = libraryType === "series" ? getSeriesRootDir(fileName, libraryPathRoot) : path.dirname(fileName)
  const nfoPath = findPrimaryNfoPath(nfoDir, libraryType)
  const nfoMeta = nfoPath ? parseNfoFile(nfoPath) : null
  const nfoPoster = nfoMeta ? resolveNfoPoster(nfoPath!, nfoMeta.posterValue) : null

  if (nfoMeta && nfoMeta.title && nfoPoster && nfoMeta.genres) {
    try {
      const mediaResult = await createMediaItem(
        db,
        adminUser,
        nfoMeta.title,
        nfoMeta.originalTitle,
        libraryType,
        nfoMeta.year,
        false,
        nfoMeta.genres,
        nfoMeta.tmdbId ? String(nfoMeta.tmdbId) : null,
        null,
        nfoPoster,
      )
      if (mediaResult.success && mediaResult.mediaItem) {
        createLog(
          db,
          "info",
          "nfoMatch", "libraryScanner",
          null,
          `NFO match for "${path.basename(fileName)}" → ${nfoMeta.title} (poster+genres from NFO; skipped TheMovieDatabase)`,
          {
            fileName: path.basename(fileName),
            nfoPath,
            title: nfoMeta.title,
            tmdbId: nfoMeta.tmdbId,
          },
        )
        return {
          mediaItemId: mediaResult.mediaItem.id,
          multipleMatches: false,
          candidateMediaItemIds: [],
          season,
          episode,
          detectedYear: nfoMeta.year,
        }
      }
    } catch (e) {
      createLog(
        db,
        "warning",
        "nfoMatch", "libraryScanner",
        null,
        `NFO match failed for "${path.basename(fileName)}": ${String(e).slice(0, 200)}`,
        {
          fileName: path.basename(fileName),
          nfoPath,
          error: String(e),
        },
      )
    }
  }

  // TMDB id pre-check: an NFO tmdb id (if the NFO didn't satisfy the shortcut
  // above) comes first, then a tmdb id embedded in the folder name. Either lets
  // us fetch directly by id and skip the AI name-detection step.
  const idConfig = getConfig(db)
  const idSources: { tmdbId: number; source: string }[] = []
  if (nfoMeta?.tmdbId) idSources.push({ tmdbId: nfoMeta.tmdbId, source: "NFO" })
  const folderTmdbId = parseTmdbIdFromFolderName(path.basename(nfoDir))
  if (folderTmdbId && folderTmdbId !== nfoMeta?.tmdbId) idSources.push({ tmdbId: folderTmdbId, source: "folder name" })

  for (const { tmdbId, source } of idSources) {
    try {
      if (isBlockedTmdbId(tmdbId, libraryType)) {
        createLog(
          db,
          "info",
          "tmdbBlocked", "libraryScanner",
          null,
          `Blocked TMDB junk id ${tmdbId} (${source}) for "${path.basename(fileName)}"; skipping and leaving Unmatched`,
          { fileName: path.basename(fileName), tmdbId, tmdbIdSource: source },
        )
        continue
      }
      const details = await fetchTheMovieDbDetailsById(db, tmdbId, libraryType)
      if (details) {
        const tmdbYear = details.releaseDate ? parseInt(details.releaseDate.split("-")[0]) : null
        const mediaResult = await createMediaItem(
          db,
          adminUser,
          details.name ?? String(tmdbId),
          details.originalTitle ?? null,
          libraryType,
          tmdbYear,
          details.isAnime ?? false,
          details.genres || null,
          String(details.id),
          details.posterUrl || null,
        )
        if (mediaResult.success && mediaResult.mediaItem) {
          createLog(
            db,
            "info",
            "tmdbMatch", "libraryScanner",
            null,
            `${source} TMDB match for "${path.basename(fileName)}" → ${details.name} (id ${details.id})`,
            {
              fileName: path.basename(fileName),
              tmdbId,
              tmdbIdSource: source,
              title: details.name,
            },
          )
          return {
            mediaItemId: mediaResult.mediaItem.id,
            multipleMatches: false,
            candidateMediaItemIds: [],
            season,
            episode,
            detectedYear: tmdbYear,
          }
        }
      } else if (idConfig.theMovieDbActive) {
        // The embedded tmdb id (from the NFO or folder name) did not resolve to
        // a valid TMDB entry — it is invalid/deleted, or TMDB was temporarily
        // unreachable. Warn so the user knows their embedded id is suspect, then
        // fall through to the next id source and finally to name-based fallback
        // matching instead of silently leaving the file Unmatched.
        createLog(
          db,
          "warning",
          "tmdbMatch", "libraryScanner",
          null,
          `TMDB id ${tmdbId} (${source}) did not resolve for "${path.basename(fileName)}"; continuing to fallback matching`,
          { fileName: path.basename(fileName), tmdbId, tmdbIdSource: source },
        )
      }
    } catch (e) {
      createLog(
        db,
        "warning",
        "tmdbMatch", "libraryScanner",
        null,
        `${source} TMDB fetch failed for "${path.basename(fileName)}": ${String(e).slice(0, 200)}`,
        {
          fileName: path.basename(fileName),
          tmdbId,
          tmdbIdSource: source,
        },
      )
    }
  }

  // Candidate detection names, in priority order. For series there is one:
  // the series-root folder. For movies, prefer the FILENAME — it is the
  // release-named signal (carries the title + year + tags) and is what matches
  // reliably even when the movie's containing folder isn't in a clean
  // "Title (Year)" layout. The containing folder name is a fallback for the
  // opposite case: a numbered/DVD filename ("VTS_01_1.mkv", "01.mkv") sitting
  // inside a descriptive folder. Trying filename first then folder covers both
  // layouts; a clean single match on the first name wins, and we only fall
  // through to the next name when the first yields no usable match.
  const stem = path.basename(fileName, path.extname(fileName))
  const detectionNames: string[] = []
  if (libraryType === "series") {
    // For series the series-root folder is the authoritative title (the
    // filename is the episode, not the show), so it stays first. The filename is
    // a fallback for series that live in a badly-named/blank folder or directly
    // in the library root — the episode filename usually carries the show name
    // plus SxxExx, which the name formatter turns back into a clean title.
    detectionNames.push(stripReleaseTokens(getSeriesDetectionName(fileName, libraryPathRoot)))
    const cleanStem = stripReleaseTokens(stem)
    if (cleanStem && !detectionNames.includes(cleanStem)) detectionNames.push(cleanStem)
  } else {
    const dir = path.normalize(path.dirname(fileName))
    const root = path.normalize(libraryPathRoot)
    const folderName = dir === root ? null : stripReleaseTokens(stripFolderIdTags(path.basename(dir)))
    const cleanStem = stripReleaseTokens(stem)
    // For movies prefer the FILENAME — it is the release-named signal (carries
    // the title + year + tags) and is what matches reliably even when the
    // movie's containing folder isn't in a clean "Title (Year)" layout.
    // stripReleaseTokens removes the resolution/codec/source noise so the name
    // formatter sees "Superman 2025" instead of "Superman.2025.1080p.WEB-DL.x264".
    detectionNames.push(cleanStem)
    if (folderName && folderName !== cleanStem) detectionNames.push(folderName)
  }

  type DetectionOutcome = {
    status: "matched" | "multiple" | "none"
    season: number | null
    episode: number | null
    detectedYear: number | null
    mediaItemId: number | null
    candidateMediaItemIds: number[]
  }

  // One AI-detection + TMDB-match attempt against a single detection name.
  // Returns the outcome plus a status so the caller can decide whether to fall
  // through to the next candidate name.
  const attemptDetectionMatch = async (detectionName: string): Promise<DetectionOutcome> => {
    let attemptSeason: number | null = null
    let attemptEpisode: number | null = null
    let attemptYear: number | null = null
    let attemptCandidates: number[] = []

    try {
      const detected = await getSubtitleItemMediaItemFromPrompt(db, adminUser, detectionName, libraryType)

      if (detected) {
        attemptSeason = detected.season
        attemptEpisode = detected.episode
        attemptYear = detected.year

        const rawResults = detected.theMovieDbRequestResult ?? []
        // Drop blocked junk ids (e.g. TMDB 1054041 "Subs") so they can never
        // become a single match, an AI pick, or a manual-selection candidate.
        const theMovieDbResults = rawResults.filter((r) => !isBlockedTmdbId(r.id, libraryType))
        const hadOnlyBlockedResults = rawResults.length > 0 && theMovieDbResults.length === 0

        if (theMovieDbResults.length > 0) {
          let filtered = attemptYear
            ? theMovieDbResults.filter((r) => {
                const releaseYear = r.releaseDate
                  ? parseInt(r.releaseDate.split("-")[0])
                  : r.releaseDate !== undefined
                    ? parseInt(String(r.releaseDate).split("-")[0])
                    : null
                return releaseYear === null || releaseYear === attemptYear
              })
            : theMovieDbResults

          if (filtered.length === 0) filtered = theMovieDbResults

          if (filtered.length === 1) {
            const match = filtered[0]
            const tmdbYear = match.releaseDate ? parseInt(match.releaseDate.split("-")[0]) : null
            const mediaResult = await createMediaItem(
              db,
              adminUser,
              match.name ?? detected.name,
              match.originalTitle ?? null,
              libraryType,
              tmdbYear ?? attemptYear,
              match.isAnime ?? false,
              match.genres || null,
              String(match.id),
              match.posterUrl || null,
            )
            if (mediaResult.success && mediaResult.mediaItem) {
              return {
                status: "matched",
                season: attemptSeason,
                episode: attemptEpisode,
                detectedYear: attemptYear,
                mediaItemId: mediaResult.mediaItem.id,
                candidateMediaItemIds: [],
              }
            }
          } else {
            const aiWinner = await selectBestTheMovieDbMatch(db, adminUser, detectionName, filtered)
            if (aiWinner) {
              const tmdbYear = aiWinner.releaseDate ? parseInt(aiWinner.releaseDate.split("-")[0]) : null
              const mediaResult = await createMediaItem(
                db,
                adminUser,
                aiWinner.name ?? detected.name,
                aiWinner.originalTitle ?? null,
                libraryType,
                tmdbYear ?? attemptYear,
                aiWinner.isAnime ?? false,
                aiWinner.genres || null,
                String(aiWinner.id),
                aiWinner.posterUrl || null,
              )
              if (mediaResult.success && mediaResult.mediaItem) {
                return {
                  status: "matched",
                  season: attemptSeason,
                  episode: attemptEpisode,
                  detectedYear: attemptYear,
                  mediaItemId: mediaResult.mediaItem.id,
                  candidateMediaItemIds: [],
                }
              }
            }

            createLog(
              db,
              "info",
              "tmdbMultiple", "libraryScanner",
              null,
              `Multiple TMDb candidates for "${path.basename(fileName)}" from "${detectionName}"; falling back to manual selection`,
              {
                fileName: path.basename(fileName),
                detectionName,
                candidateCount: filtered.length,
              },
            )

            for (const match of filtered) {
              const tmdbYear = match.releaseDate ? parseInt(match.releaseDate.split("-")[0]) : null
              const mediaResult = await createMediaItem(
                db,
                adminUser,
                match.name ?? detected.name,
                match.originalTitle ?? null,
                libraryType,
                tmdbYear ?? attemptYear,
                match.isAnime ?? false,
                match.genres || null,
                String(match.id),
                match.posterUrl || null,
              )
              if (mediaResult.success && mediaResult.mediaItem) {
                attemptCandidates.push(mediaResult.mediaItem.id)
              }
            }
            return {
              status: "multiple",
              season: attemptSeason,
              episode: attemptEpisode,
              detectedYear: attemptYear,
              mediaItemId: null,
              candidateMediaItemIds: attemptCandidates,
            }
          }
        } else if (hadOnlyBlockedResults) {
          // TMDB returned only junk ids (e.g. 1054041 "Subs"). Don't fall back
          // to a filename-only media item — leave the file Unmatched so the
          // user can fix it, rather than silently attaching a garbage match.
          createLog(
            db,
            "info",
            "tmdbBlocked", "libraryScanner",
            null,
            `Blocked TMDB junk match for "${path.basename(fileName)}"; leaving Unmatched`,
            { fileName: path.basename(fileName), detectionName, blockedIds: rawResults.map((r) => r.id) },
          )
        } else if (detected.name) {
          const existing = getMediaItemByKeys(db, detected.name, libraryType, attemptYear, null)
          if (existing) {
            return {
              status: "matched",
              season: attemptSeason,
              episode: attemptEpisode,
              detectedYear: attemptYear,
              mediaItemId: existing.id,
              candidateMediaItemIds: [],
            }
          }
          // Series: reuse an already-matched mediaItem (one carrying a
          // theMovieDbId) of the same title, ignoring the year. An isolated
          // episode like "Silo S03E05" sitting in its own folder — separate
          // from the already-scanned/matched Silo seasons — should join that
          // matched "Silo" series instead of getting a fresh placeholder
          // mediaItem (no theMovieDbId) and staying half-resolved/unmatched.
          // Year is ignored because the matched series row usually carries the
          // TMDB release year while a name-only detection yields none.
          if (libraryType === "series") {
            const matched = db
              .prepare(
                `SELECT id FROM mediaItem WHERE title = ? AND type = ? AND theMovieDbId IS NOT NULL AND theMovieDbId != '' ORDER BY createdAt DESC LIMIT 1`,
              )
              .get(detected.name, libraryType) as { id: number } | undefined
            if (matched) {
              createLog(
                db,
                "info",
                "seriesReuse", "libraryScanner",
                null,
                `Reusing matched series media item for "${path.basename(fileName)}" → "${detected.name}" (id ${matched.id})`,
                { fileName: path.basename(fileName), detectionName: detectionName, detectedName: detected.name, mediaItemId: matched.id },
              )
              return {
                status: "matched",
                season: attemptSeason,
                episode: attemptEpisode,
                detectedYear: attemptYear,
                mediaItemId: matched.id,
                candidateMediaItemIds: [],
              }
            }
          }
          const mediaResult = await createMediaItem(
            db,
            adminUser,
            detected.name,
            null,
            libraryType,
            attemptYear,
            false,
            null,
            null,
            null,
          )
          if (mediaResult.success && mediaResult.mediaItem) {
            return {
              status: "matched",
              season: attemptSeason,
              episode: attemptEpisode,
              detectedYear: attemptYear,
              mediaItemId: mediaResult.mediaItem.id,
              candidateMediaItemIds: [],
            }
          }
        }
      }
    } catch (e) {
      createLog(db, "warning", "nameDetection", "libraryScanner", null, `Name detection failed for file: ${path.basename(fileName)}`, {
        fileName,
        libraryType,
        detectionName,
        error: String(e),
      })
    }

    return {
      status: "none",
      season: attemptSeason,
      episode: attemptEpisode,
      detectedYear: attemptYear,
      mediaItemId: null,
      candidateMediaItemIds: [],
    }
  }

  // Try each candidate detection name in order. A definitive match wins
  // immediately. A "multiple" (ambiguous, needs manual pick) is remembered but we
  // still try the next name — a cleaner single match on the folder name (or
  // filename) is preferable to forcing manual selection. If every name is
  // ambiguous, the first "multiple" outcome is returned so the user still gets
  // the manual-selection candidates.
  //
  // Series exception: the series-root folder (the first detection name) is the
  // authoritative title — the episode filename is the episode, not the show, so
  // a single match derived from it is unreliable (e.g. an episode title like
  // "The Crush" matching an unrelated movie). When the folder name already
  // produced candidates ("multiple"), the correct show is almost certainly among
  // them, so stop and keep those candidates for manual selection instead of
  // letting the episode filename override the match. The filename is still used
  // as a fallback when the folder name yields nothing ("none") — e.g. a blank
  // or badly-named folder, or files sitting directly in the library root.
  let multipleOutcome: DetectionOutcome | null = null
  for (let i = 0; i < detectionNames.length; i++) {
    const detectionName = detectionNames[i]
    const outcome = await attemptDetectionMatch(detectionName)

    if (outcome.status === "matched") {
      return {
        mediaItemId: outcome.mediaItemId,
        multipleMatches: false,
        candidateMediaItemIds: [],
        season: outcome.season,
        episode: outcome.episode,
        detectedYear: outcome.detectedYear,
      }
    }

    if (outcome.status === "multiple" && !multipleOutcome) {
      multipleOutcome = outcome
    }

    // carry forward the best season/episode/year seen so the no-match return
    // still populates them (e.g. an SxxExx parsed by the name formatter).
    if (outcome.season !== null) season = outcome.season
    if (outcome.episode !== null) episode = outcome.episode
    if (outcome.detectedYear !== null) detectedYear = outcome.detectedYear

    // Series: a "multiple" from the root-folder name is authoritative — don't
    // let the episode filename override it. (See the series-exception note
    // above.) Only fall through to the filename when the folder gave nothing.
    if (
      libraryType === "series" &&
      i === 0 &&
      outcome.status === "multiple" &&
      multipleOutcome &&
      multipleOutcome.candidateMediaItemIds.length > 0
    ) {
      break
    }
  }

  if (multipleOutcome) {
    return {
      mediaItemId: null,
      multipleMatches: true,
      candidateMediaItemIds: multipleOutcome.candidateMediaItemIds,
      season: multipleOutcome.season,
      episode: multipleOutcome.episode,
      detectedYear: multipleOutcome.detectedYear,
    }
  }

  if (season === null || episode === null) {
    const seMatch = path.basename(fileName).match(/[Ss](\d{1,2})[Ee](\d{1,2})/)
    if (seMatch) {
      season = parseInt(seMatch[1])
      episode = parseInt(seMatch[2])
    }
  }

  return { mediaItemId: null, multipleMatches: false, candidateMediaItemIds: [], season, episode, detectedYear }
}

/**
 * Thrown by `scanLibraryPath` when an abort is requested (a rescan of the path
 * currently being scanned). Distinct from a real scan failure — the caller
 * (libraryTask) catches it separately and restarts the scan from the beginning
 * without marking the path as errored.
 */
export class ScanAbortedError extends Error {
  constructor(message = "Scan aborted by rescan") {
    super(message)
    this.name = "ScanAbortedError"
  }
}

// Pre-compute + cache the subtitle source list for a library path item's video
// file, so the source picker reads from cache instead of probing/extracting the
// media on every open. Runs in the scanner worker (off the Express loop), so the
// mkvextract pass for embedded picture counts is acceptable here. Best-effort:
// any failure is swallowed so it never aborts the scan.
function cacheItemSubtitleSources(
  db: Database.Database,
  itemId: number,
  videoFilePath: string,
  iso: string,
  iso2b: string | null,
  langName: string,
): void {
  try {
    const st = fs.statSync(videoFilePath)
    const sources = listSubtitleSourcesForVideo(videoFilePath, iso, iso2b, langName)
    upsertItemSubtitleSources(db, itemId, sources, Math.floor(st.mtimeMs), st.size)
  } catch {
    /* probe/extract failed — leave the cache empty; picker falls back to live */
  }
}

// Whether the cached sources for an item are still fresh (match the live file's
// mtime + size). False when there's no cache or the file changed since caching.
function cachedSourcesAreFresh(db: Database.Database, itemId: number, videoFilePath: string): boolean {
  const cached = getItemSubtitleSources(db, itemId)
  if (!cached) return false
  try {
    const st = fs.statSync(videoFilePath)
    return cached.fileMtimeMs === Math.floor(st.mtimeMs) && cached.fileSize === st.size
  } catch {
    return false
  }
}

export async function scanLibraryPath(
  db: Database.Database,
  libraryPath: DBLibraryPath,
  shouldAbort?: () => boolean,
): Promise<void> {
  if (shouldAbort?.()) throw new ScanAbortedError()
  const adminUser = getHighestRoleUser(db)
  if (!adminUser) {
    createLog(
      db,
      "warning",
      "scanSkipped", "libraryScanner",
      libraryPath.id,
      `Skipping scan of "${libraryPath.name}": no admin user available to attribute actions to`,
      {
        libraryPathName: libraryPath.name,
      },
    )
    setLibraryPathState(db, libraryPath.id, "idle")
    return
  }

  if (!fs.existsSync(libraryPath.path)) {
    createLog(
      db,
      "warning",
      "scanSkipped", "libraryScanner",
      libraryPath.id,
      `Library path "${libraryPath.name}" does not exist on disk: ${libraryPath.path}`,
      {
        libraryPathName: libraryPath.name,
        path: libraryPath.path,
      },
    )
    setLibraryPathState(db, libraryPath.id, "idle")
    return
  }

  // Prune inventory items whose source file has been removed from the folder
  // since the last scan. The library scan is the only place that adds items, so
  // it is also the right place to drop them: an item with no file on disk is
  // stale and would otherwise linger forever as a translatable card pointing at
  // nothing. Candidate/blacklist rows cascade on delete; any linked subtitle is
  // detached (libraryPathItem SET NULL) so finished translations/exported files
  // are preserved.
  const existingItems = getLibraryPathItemIdsByLibraryPath(db, libraryPath.id)
  for (const inv of existingItems) {
    if (fs.existsSync(inv.path)) continue
    deleteLibraryPathItem(db, inv.id)
    createLog(db, "info", "libraryScanner", "libraryScanner", inv.id, `Removed library item no longer on disk: ${inv.path}`, {
      libraryPathName: libraryPath.name,
      path: inv.path,
    })
  }

  // Drop registry entries for exported files the user has since deleted, so a
  // later user-placed file at the same path isn't wrongly hidden as our output.
  pruneMissingExportedFiles(db, libraryPath.id)

  const { videoFiles, srtFiles } = findMediaFiles(libraryPath.path)

  const config = getConfig(db)
  const sourceLang = getLanguageById(db, libraryPath.sourceLangId)
  const iso = sourceLang?.iso639 ?? ""
  const iso2b: string | null = sourceLang?.iso6392b ?? null
  const langName = sourceLang?.name ?? ""

  const companionSrtPaths = new Set<string>()

  // Pre-compute per-season episode rebase offsets (absolute → 1-based) before
  // the per-file loop, since a season's offset depends on the lowest episode
  // number across all of its files. See computeSeasonEpisodeRebase.
  const episodeRebase =
    libraryPath.type === "series"
      ? computeSeasonEpisodeRebase(videoFiles, libraryPath.path)
      : new Map<string, number>()

  const seriesFolderCache = new Map<
    string,
    {
      mediaItemId: number | null
      multipleMatches: boolean
      candidateMediaItemIds: number[]
      detectedYear: number | null
    }
  >()

  // For movie library paths, cache the per-movie-root match (the movie video's
  // directory) so featurettes/extras in a "Featurettes" subfolder inherit the
  // owning movie's media item without an independent (garbage) match — and so
  // the movie is matched exactly once even when "Featurettes" sorts before the
  // movie file in findMediaFiles (then the extra populates the cache and the
  // later movie video reuses it).
  const movieRootCache = new Map<
    string,
    {
      mediaItemId: number | null
      multipleMatches: boolean
      candidateMediaItemIds: number[]
      season: number | null
      episode: number | null
      detectedYear: number | null
    }
  >()

  for (const videoFile of videoFiles) {
    if (shouldAbort?.()) throw new ScanAbortedError()
    const stem = path.basename(videoFile, path.extname(videoFile))

    const existingItem = findLibraryPathItemByPath(db, libraryPath.id, videoFile)
    if (existingItem) {
      findAllCompanionSrts(videoFile).forEach((s) => companionSrtPaths.add(s))
      // Refresh the cached subtitle sources if the media file changed (re-muxed)
      // since it was last cached. If the cache is still fresh, skip — this is the
      // common case on rescan and avoids re-extracting every file every scan.
      if (!cachedSourcesAreFresh(db, existingItem.id, videoFile)) {
        if (shouldAbort?.()) throw new ScanAbortedError()
        cacheItemSubtitleSources(db, existingItem.id, videoFile, iso, iso2b, langName)
      }
      // Reconcile BCookieSubs-translated files next to this video against the
      // bcookietranslated rows — runs every scan so deleted translations drop
      // their badges even when the (unchanged) video didn't need a cache refresh.
      reconcileBcookieTranslatedForItem(db, existingItem.id, videoFile, iso, iso2b)
      continue
    }

    const companions = findAllCompanionSrts(videoFile)
    companions.forEach((s) => companionSrtPaths.add(s))

    let resolvedSrt: ResolvedSrt | null = null
    const companionMatch = selectBestSrt(companions, [], iso, langName)
    if (companionMatch) {
      resolvedSrt = { path: companionMatch, isTemp: false }
    } else {
      const extracted = extractBestEmbeddedSrt(videoFile, iso, iso2b, langName)
      if (extracted) resolvedSrt = { path: extracted, isTemp: true }
    }

    // Match the media item regardless of whether a subtitle was found. A video
    // with no companion/extractable SRT (e.g. a dual-audio release waiting for
    // Whisper) still belongs to a series/movie, so it should be matched via
    // NFO/folder-id/name-detection and shown with the correct title rather than
    // left as an anonymous "no_srts_found" row. The match is cached per series
    // root, so this adds at most one TheMovieDatabase/AI call per series.
    let mediaItemId: number | null = null
    let multipleMatches = false
    let candidateMediaItemIds: number[] = []
    let season: number | null = null
    let episode: number | null = null
    let isExtra = false

    if (libraryPath.type === "series") {
      const seriesRoot = getSeriesRootDir(videoFile, libraryPath.path)
      let cached = seriesFolderCache.get(seriesRoot)
      if (!cached) {
        const detection = await matchMediaForFile(db, adminUser, videoFile, libraryPath.type, libraryPath.path)
        cached = {
          mediaItemId: detection.mediaItemId,
          multipleMatches: detection.multipleMatches,
          candidateMediaItemIds: detection.candidateMediaItemIds,
          detectedYear: detection.detectedYear,
        }
        seriesFolderCache.set(seriesRoot, cached)
      }
      mediaItemId = cached.mediaItemId
      multipleMatches = cached.multipleMatches
      candidateMediaItemIds = cached.candidateMediaItemIds

      // Season: prefer folder name, then fall back to filename
      const seasonFolder = getSeasonFolderNameBetween(videoFile, seriesRoot)
      if (isFractionalSpecial(videoFile)) {
        // A ".5" episode (e.g. "S01E18.5") is a recap/extra, not a real
        // episode — route it to season 0 (specials) with no episode number.
        season = 0
        episode = null
      } else {
        season =
          seasonFolder !== null
            ? (parseSeasonFolderName(seasonFolder) ?? parseSeasonFromFilename(videoFile))
            : parseSeasonFromFilename(videoFile)
        // No season could be determined from either the folder or the filename:
        // default to season 1. This covers files directly in the series root with
        // no season info, AND files inside a non-season subfolder whose name we
        // can't parse (e.g. an anime release-group folder like "[KH] Show (BD
        // 1080p)" or "Show [1080]" with "Show - 01 - Title" filenames that carry
        // no season number anywhere). Season 0 is only ever assigned explicitly
        // (Specials/OVA/Extras folders, parseSeasonFolderName returns 0, or a
        // fractional-special filename above), so a null season here is genuinely
        // "unknown" → treat as the primary season.
        if (season === null) season = 1
        episode = parseEpisodeFromFilename(videoFile)
        // Rebase absolute (show-wide) episode numbers to 1-based per-season
        // numbers when the whole season folder lacks SxxExx markers, e.g. a
        // "Season 03" folder of "Show - 073".."100" becomes 1..28.
        if (episode !== null && seasonFolder !== null) {
          const rebaseOffset = episodeRebase.get(seasonFolderKey(seriesRoot, seasonFolder))
          if (rebaseOffset) episode = episode - rebaseOffset
        }
      }
    } else {
      // Movie library path. A video inside a "Featurettes"/"Extras" subfolder is
      // bonus content, not the movie: attach it to the owning movie video's
      // media item (inheriting its match — including unresolved candidates —
      // via the per-movie-root cache) and flag it as an extra with no
      // season/episode. Skip matchMediaForFile for extras so a featurette
      // named e.g. "Clash of the Titans" isn't AI/TMDB-matched to that movie.
      if (isInExtrasFolder(videoFile)) {
        const owner = findOwningMovieVideoForExtra(videoFile, videoFiles)
        if (owner) {
          const ownerRoot = path.dirname(owner)
          let cached = movieRootCache.get(ownerRoot)
          if (!cached) {
            const detection = await matchMediaForFile(db, adminUser, owner, libraryPath.type, libraryPath.path)
            cached = {
              mediaItemId: detection.mediaItemId,
              multipleMatches: detection.multipleMatches,
              candidateMediaItemIds: detection.candidateMediaItemIds,
              season: detection.season,
              episode: detection.episode,
              detectedYear: detection.detectedYear,
            }
            movieRootCache.set(ownerRoot, cached)
          }
          mediaItemId = cached.mediaItemId
          multipleMatches = cached.multipleMatches
          candidateMediaItemIds = cached.candidateMediaItemIds
          season = 0
          episode = null
          isExtra = true
          createLog(
            db,
            "info",
            "libraryScanner", "libraryScanner",
            null,
            `Extra "${path.basename(videoFile)}" attached to movie video "${path.basename(owner)}"`,
            { libraryPathName: libraryPath.name, extraPath: videoFile, owningVideo: owner },
          )
        } else {
          // No owning movie video found — leave it as a plain unmatched item
          // rather than garbage-matching the featurette's own title.
          createLog(
            db,
            "info",
            "libraryScanner", "libraryScanner",
            null,
            `Extra "${path.basename(videoFile)}" has no owning movie video; leaving Unmatched`,
            { libraryPathName: libraryPath.name, extraPath: videoFile },
          )
        }
      } else {
        const movieRoot = path.dirname(videoFile)
        let cached = movieRootCache.get(movieRoot)
        if (!cached) {
          const detection = await matchMediaForFile(db, adminUser, videoFile, libraryPath.type, libraryPath.path)
          cached = {
            mediaItemId: detection.mediaItemId,
            multipleMatches: detection.multipleMatches,
            candidateMediaItemIds: detection.candidateMediaItemIds,
            season: detection.season,
            episode: detection.episode,
            detectedYear: detection.detectedYear,
          }
          movieRootCache.set(movieRoot, cached)
        }
        mediaItemId = cached.mediaItemId
        multipleMatches = cached.multipleMatches
        candidateMediaItemIds = cached.candidateMediaItemIds
        season = cached.season
        episode = cached.episode
      }
    }

    const mediaItem = mediaItemId ? getMediaItemById(db, mediaItemId) : null
    const extractFileName = buildExtractFileName(mediaItem, season, episode, stem)

    if (!resolvedSrt) {
      // No subtitle to translate yet, but the media item is still matched so
      // the card shows the right show/episode and the video can be queued for
      // Whisper transcription later. Season/episode come from the folder/
      // filename (not the SRT), so they are available here too.
      const noSrtItem = createLibraryPathItem(db, libraryPath.id, videoFile, extractFileName, mediaItemId, "no_srts_found", season, episode, isExtra)
      // Cache embedded/external subtitle sources so the picker (if the user opens
      // it to grab an embedded track) doesn't have to re-probe the file later.
      if (noSrtItem) {
        cacheItemSubtitleSources(db, noSrtItem.id, videoFile, iso, iso2b, langName)
        reconcileBcookieTranslatedForItem(db, noSrtItem.id, videoFile, iso, iso2b)
      }
      continue
    }

    const status: DBLibraryPathItem["status"] = mediaItemId ? "not_started" : "no_media_item"

    const item = createLibraryPathItem(
      db,
      libraryPath.id,
      videoFile,
      extractFileName,
      mediaItemId,
      status,
      season,
      episode,
      isExtra,
    )
    if (!item) {
      if (resolvedSrt.isTemp) safeDeleteTempExtract(resolvedSrt.path, db)
      continue
    }

    // Cache this item's subtitle sources (embedded tracks + companion files,
    // with picture counts) so the source picker reads from cache on open.
    cacheItemSubtitleSources(db, item.id, videoFile, iso, iso2b, langName)
    reconcileBcookieTranslatedForItem(db, item.id, videoFile, iso, iso2b)

    if (multipleMatches && candidateMediaItemIds.length > 0) {
      for (const candidateId of candidateMediaItemIds) {
        createLibraryPathItemCandidate(db, item.id, videoFile, candidateId)
      }
    }

    if (libraryPath.autoTranslate && (mediaItemId || !multipleMatches)) {
      await autoTranslateItem(
        db,
        adminUser,
        libraryPath,
        item.id,
        resolvedSrt,
        mediaItemId,
        season,
        episode,
        config.defaultChunkSize,
        undefined,
        undefined,
        videoFile,
      )
    } else if (resolvedSrt.isTemp) {
      safeDeleteTempExtract(resolvedSrt.path, db, item.id)
    }
  }

  for (const srtFile of srtFiles) {
    if (shouldAbort?.()) throw new ScanAbortedError()
    if (companionSrtPaths.has(srtFile)) {
      // This subtitle is a companion of a video in the same folder, so it is
      // the video item's source — not its own translatable row. An older,
      // stricter scan may have created a standalone item for it (e.g. a
      // dot-named .ssa next to a space-named .mkv); drop that stale row so
      // the episode stops showing up twice on the Library Requests page.
      const staleCompanion = findLibraryPathItemByPath(db, libraryPath.id, srtFile)
      if (staleCompanion) {
        deleteLibraryPathItem(db, staleCompanion.id)
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          staleCompanion.id,
          `Removed standalone subtitle item now grouped under its video: ${srtFile}`,
          { libraryPathName: libraryPath.name, path: srtFile },
        )
      }
      continue
    }

    const srtBasename = path.basename(srtFile)

    if (srtBasename.startsWith("[BCookieSub]")) continue

    // Files BCookieSubs exported into the library folder are translation
    // output, not a source to translate from — except whisper-generated
    // transcripts, which are legitimate sources. Skip our own output so it
    // never becomes a translatable row on the Library Requests page.
    const exportedRecord = getExportedFileByPath(db, srtFile)
    if (exportedRecord && !exportedRecord.isWhisper) {
      const staleExport = findLibraryPathItemByPath(db, libraryPath.id, srtFile)
      if (staleExport) {
        deleteLibraryPathItem(db, staleExport.id)
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          staleExport.id,
          `Removed BCookieSubs-exported subtitle item (not a translation source): ${srtFile}`,
          { libraryPathName: libraryPath.name, path: srtFile },
        )
      }
      continue
    }

    const fileExt = subtitleExtensionOf(srtFile) ?? ".srt"
    const stem = srtBasename.toLowerCase().endsWith(fileExt)
      ? srtBasename.slice(0, srtBasename.length - fileExt.length)
      : srtBasename

    if (findLibraryPathItemByPath(db, libraryPath.id, srtFile)) continue

    let mediaItemId: number | null = null
    let multipleMatches = false
    let candidateMediaItemIds: number[] = []
    let season: number | null = null
    let episode: number | null = null

    // Movies-only: a subtitle that carries no usable movie title in its
    // filename — a bare language tag ("english.srt", "spa.srt") OR any file
    // inside a "Subs"/"subs" subfolder of a movie folder (RARBG/YTS releases
    // ship "10_Finnish.srt", "English (SDH).eng.srt", "Français.fre.srt",
    // etc.). Matching such a file on its own stem is garbage ("english" / "10"
    // is not a movie), so attach it to the owning video in the same folder tree
    // and inherit that video's media item — the subtitle becomes a translatable
    // track for the correct movie. Series are folder-matched and excluded by
    // request.
    let matchedViaOwningVideo = false
    if (
      libraryPath.type === "movie" &&
      (isLanguageOnlyStem(stem) || isInSubsFolder(srtFile) || isInMovieVideoFolder(srtFile, videoFiles))
    ) {
      const owningVideo = findOwningVideoFile(srtFile, videoFiles)
      const owningItem = owningVideo ? findLibraryPathItemByPath(db, libraryPath.id, owningVideo) : null
      if (owningItem) {
        mediaItemId = owningItem.mediaItemId
        if (mediaItemId) {
          multipleMatches = false
          candidateMediaItemIds = []
        } else {
          // Video itself is unresolved — mirror its candidates so the user can
          // pick the same match for this subtitle.
          const owningCandidates = getLibraryPathItemCandidates(db, owningItem.id)
          if (owningCandidates.length > 0) {
            multipleMatches = true
            candidateMediaItemIds = owningCandidates.map((c) => c.mediaItemId)
          }
        }
        matchedViaOwningVideo = true
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          null,
          `Subtitle "${srtBasename}" attached to movie video "${path.basename(owningVideo!)}"`,
          { libraryPathName: libraryPath.name, srtPath: srtFile, owningVideo: owningVideo! },
        )
      } else {
        // No owning movie video in the folder tree — leave Unmatched instead of
        // garbage-matching on a language name.
        matchedViaOwningVideo = true
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          null,
          `Subtitle "${srtBasename}" has no owning movie video; leaving Unmatched`,
          { libraryPathName: libraryPath.name, srtPath: srtFile },
        )
      }
    }

    if (!matchedViaOwningVideo) {
      if (libraryPath.type === "series") {
        const seriesRoot = getSeriesRootDir(srtFile, libraryPath.path)
        let cached = seriesFolderCache.get(seriesRoot)
        if (!cached) {
          const detection = await matchMediaForFile(db, adminUser, srtFile, libraryPath.type, libraryPath.path)
          cached = {
            mediaItemId: detection.mediaItemId,
            multipleMatches: detection.multipleMatches,
            candidateMediaItemIds: detection.candidateMediaItemIds,
            detectedYear: detection.detectedYear,
          }
          seriesFolderCache.set(seriesRoot, cached)
        }
        mediaItemId = cached.mediaItemId
        multipleMatches = cached.multipleMatches
        candidateMediaItemIds = cached.candidateMediaItemIds

        const seasonFolder = getSeasonFolderNameBetween(srtFile, seriesRoot)
        if (isFractionalSpecial(srtFile)) {
          // A ".5" subtitle (e.g. "S01E18.5") is a recap/extra → season 0.
          season = 0
          episode = null
        } else {
          season =
            seasonFolder !== null
              ? (parseSeasonFolderName(seasonFolder) ?? parseSeasonFromFilename(srtFile))
              : parseSeasonFromFilename(srtFile)
          if (season === null) season = 1
          episode = parseEpisodeFromFilename(srtFile)
        }
      } else {
        const detection = await matchMediaForFile(db, adminUser, srtFile, libraryPath.type, libraryPath.path)
        mediaItemId = detection.mediaItemId
        multipleMatches = detection.multipleMatches
        candidateMediaItemIds = detection.candidateMediaItemIds
        season = detection.season
        episode = detection.episode
      }
    }

    const mediaItem = mediaItemId ? getMediaItemById(db, mediaItemId) : null
    const extractFileName = buildExtractFileName(mediaItem, season, episode, stem, fileExt)
    const status: DBLibraryPathItem["status"] = mediaItemId ? "not_started" : "no_media_item"

    const item = createLibraryPathItem(
      db,
      libraryPath.id,
      srtFile,
      extractFileName,
      mediaItemId,
      status,
      season,
      episode,
    )
    if (!item) continue

    if (multipleMatches && candidateMediaItemIds.length > 0) {
      for (const candidateId of candidateMediaItemIds) {
        createLibraryPathItemCandidate(db, item.id, srtFile, candidateId)
      }
    }

    if (libraryPath.autoTranslate && (mediaItemId || !multipleMatches)) {
      await autoTranslateItem(
        db,
        adminUser,
        libraryPath,
        item.id,
        { path: srtFile, isTemp: false },
        mediaItemId,
        season,
        episode,
        config.defaultChunkSize,
      )
    }
  }

  if (libraryPath.autoExtract) {
    await autoExtractItems(db, libraryPath)
  }

  if (!libraryPath.initialScanCompleted) {
    setInitialScanCompleted(db, libraryPath.id)
  }
}

export async function autoTranslateItem(
  db: Database.Database,
  adminUser: DBUser,
  libraryPath: DBLibraryPath,
  libraryPathItemId: number,
  srtSource: ResolvedSrt,
  mediaItemId: number | null,
  season: number | null,
  episode: number | null,
  chunkSetting: number,
  overrideTargetLangIds?: number[],
  sourceLangIdOverride?: number | null,
  // Associated video path — used for MicroDVD FPS detection when the source is
  // a text .sub, and informational for OCR logging.
  associatedVideoPath?: string | null,
  // OCR language override (Tesseract code) from the source picker, if the user
  // chose one for a VobSub image source.
  ocrLangOverride?: string | null,
  // FPS override for MicroDVD text .sub (from the picker).
  fpsOverride?: number | null,
): Promise<{ success: boolean; msg: string }> {
  const { path: srtFilePath, isTemp } = srtSource

  if (isLibraryPathItemBlacklisted(db, libraryPathItemId)) {
    if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)
    return { success: false, msg: "Item is blacklisted from translation" }
  }

  const effectiveSourceLangId = sourceLangIdOverride ?? libraryPath.sourceLangId
  const sourceLang = getLanguageById(db, effectiveSourceLangId)
  const sourceLangHints = [sourceLang?.iso639, sourceLang?.iso6392b]

  let srtContent: string
  // Provenance metadata stored on the subtitle row so the dashboard/logs can
  // show that a translation came from a .sub via parse vs OCR.
  let textOrigin: string | null = null
  let originalSourceFormat: string | null = null

  if (isSubFile(srtFilePath) || isSupFile(srtFilePath)) {
    // Image/text source that needs conversion to an SRT intermediate before
    // entering the standard translation pipeline:
    //   .sub → text parse (MicroDVD/SubViewer) or VobSub OCR (subSubtitleAdapter)
    //   .sup → PGS bitmap OCR (pgsOcrService)
    // Failures are handled here so a bad file / missing Tesseract never crashes
    // the worker loop.
    const isPgs = isSupFile(srtFilePath)
    try {
      if (isPgs) {
        const ocrLang = ocrLangOverride ?? resolveOcrLang(...sourceLangHints)
        const converted = ocrPgsToSrt(srtFilePath, {
          ocrLang,
          sourceLangHints,
        })
        srtContent = converted.srt
        textOrigin = "ocr"
        originalSourceFormat = "sup"
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          libraryPathItemId,
          `Imported .sup (PGS) subtitle via OCR for translation`,
          {
            sourceFormat: "sup",
            textOrigin: "ocr",
            ocrLang,
            rows: converted.entries.length,
            ocrRows: converted.ocrRows,
            emptyOcrRows: converted.emptyRows,
            fromEmbeddedExtract: isTemp,
          },
        )
      } else {
        const converted = convertSubToSrt(srtFilePath, {
          videoPath: associatedVideoPath,
          ocrLang: ocrLangOverride ?? null,
          sourceLangHints,
          fpsOverride: fpsOverride ?? null,
        })
        srtContent = converted.srt
        textOrigin = converted.textOrigin
        originalSourceFormat = converted.originalSourceFormat

        const ocrLang = ocrLangOverride ?? resolveOcrLang(...sourceLangHints)
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          libraryPathItemId,
          `Imported .sub subtitle (${converted.kind}, ${converted.textOrigin}) for translation`,
          {
            sourceFormat: "sub",
            textOrigin: converted.textOrigin,
            subKind: converted.kind,
            ocrLang: converted.textOrigin === "ocr" ? ocrLang : null,
            rows: converted.entries.length,
            ocrRows: converted.ocrRows,
            emptyOcrRows: converted.emptyRows,
            fpsUsed: converted.fpsUsed,
            fromEmbeddedExtract: isTemp,
          },
        )
        if (converted.fpsAssumedDefault) {
          createLog(
            db,
            "warning",
            "libraryScanner", "libraryScanner",
            libraryPathItemId,
            `MicroDVD .sub FPS could not be detected from media; assumed default ${converted.fpsUsed} fps. Timing may be off — set FPS via the source picker if needed.`,
            { fpsUsed: converted.fpsUsed },
          )
        }
      }
    } catch (e: any) {
      const reason = e?.message ?? String(e)
      const errorType =
        e instanceof TesseractUnavailableError ? "tesseract_missing"
        : e instanceof TesseractLangMissingError ? "tesseract_lang_missing"
        : e instanceof VobSubOcrError ? "vobsub_ocr_failed"
        : e instanceof PgsOcrError ? "pgs_ocr_failed"
        : e instanceof SubParseError ? "sub_parse_failed"
        : isPgs ? "sup_import_failed"
        : "sub_import_failed"
      createLog(
        db,
        "error",
        "libraryScanner", "libraryScanner",
        libraryPathItemId,
        `Failed to import ${isPgs ? ".sup (PGS)" : ".sub"} subtitle for translation: ${reason}`,
        { sourceFormat: isPgs ? "sup" : "sub", errorType, error: String(reason).slice(0, 300) },
      )
      updateLibraryPathItemStatus(db, libraryPathItemId, "failed")
      if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)
      return { success: false, msg: reason }
    }
    // Temp extraction files (.sub+.idx pair or .sup) are cleaned after conversion.
    if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)
  } else {
    try {
      srtContent = fs.readFileSync(srtFilePath, "utf-8")
      // mkvextract prepends a UTF-8 BOM to extracted ASS/SSA tracks, and Node's
      // "utf-8" decoding leaves it in place. A leading BOM makes the first line
      // "﻿[Script Info]", which libass won't recognize as a section header
      // — so PlayResX/PlayResY get dropped and every \pos renders against the
      // 384x288 fallback instead of the authored canvas. Strip it on read so the
      // BOM never enters originalText or any exported translation.
      if (srtContent.charCodeAt(0) === 0xfeff) srtContent = srtContent.slice(1)
    } catch (e) {
      createLog(db, "error", "libraryScanner", "libraryScanner", libraryPathItemId, "Failed to read SRT file for auto-translate", {
        path: srtFilePath,
        isTemp,
        error: String(e),
      })
      updateLibraryPathItemStatus(db, libraryPathItemId, "failed")
      if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)
      return { success: false, msg: "Could not read SRT file" }
    }
    if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)
  }

  const targetLangIds = overrideTargetLangIds ?? getConfigTranslationLanguages(db).map((cl) => cl.languageId)
  if (targetLangIds.length === 0) {
    createLog(
      db,
      "warning",
      "libraryScanner", "libraryScanner",
      libraryPathItemId,
      "No default target languages configured — cannot auto-translate library item",
      {},
    )
    return { success: false, msg: "No default target languages configured — add them in Settings" }
  }
  const srtFileName = path.basename(srtFilePath)

  const mediaItem = mediaItemId ? getMediaItemById(db, mediaItemId) : null
  const displayName = buildDisplayName(mediaItem)

  const storedSourcePath = isTemp ? null : srtFilePath
  const storedMediaDir = isTemp ? path.dirname(libraryPath.path) : path.dirname(srtFilePath)

  const result = createSubtitleTask(
    db,
    adminUser,
    mediaItemId,
    effectiveSourceLangId,
    targetLangIds,
    srtContent,
    chunkSetting,
    season,
    episode,
    srtFileName,
    displayName,
    "library",
    storedSourcePath,
    storedMediaDir,
    libraryPathItemId,
    textOrigin,
    originalSourceFormat,
  )

  if (result.success) {
    updateLibraryPathItemStatus(db, libraryPathItemId, "queued")
    createLog(db, "info", "libraryScanner", "libraryScanner", libraryPathItemId, `Queued library item for translation: ${srtFileName}`, {
      srtFileName,
      targetLangIds,
      fromEmbeddedExtract: isTemp,
      textOrigin,
      originalSourceFormat,
    })
    return { success: true, msg: result.msg ?? "Queued for translation" }
  } else {
    createLog(
      db,
      "warning",
      "libraryScanner", "libraryScanner",
      libraryPathItemId,
      `Failed to create subtitle task for library item: ${result.msg ?? "unknown reason"}`,
      {
        srtFileName,
        msg: result.msg,
      },
    )
    return { success: false, msg: result.msg ?? "Failed to create subtitle task" }
  }
}

// Shape of a user-selected source from the subtitle source picker (embedded
// track or external file). Mirrors the route body's sourceOverride; shared by
// the route handlers and the translate-prep worker so the heavy work runs off
// the Express main thread.
export type TranslateSourceOverride = {
  type: string
  path: string
  language: string
  codec: string
  trackId?: number | null
  ocrLang?: string | null
  fps?: number | null
  // True when the source is image-based (PGS/VobSub) and needs Tesseract OCR.
  // Set by the source picker from the candidate; routes use it to decide whether
  // to enqueue a background OCR job (async) instead of running the translate
  // synchronously behind the modal.
  imageBased?: boolean
}

// Resolve a subtitle source for a library path item, run any OCR/conversion
// needed to produce an SRT intermediate, and queue translation jobs. This is
// the off-thread body of the per-item Translate / re-add / season-batch flows:
// the route handlers send a request to the translate-prep worker, which calls
// this. PGS/VobSub OCR and embedded-track extraction (mkvextract) run here, so
// the Express event loop never blocks on them.
export async function prepareTranslationForItem(
  db: Database.Database,
  itemId: number,
  resetStatus: boolean,
  userId: number,
  sourceOverride?: TranslateSourceOverride | null,
  sourceLanguageHint?: string | null,
): Promise<{ success: boolean; msg: string }> {
  const item = getLibraryPathItemById(db, itemId)
  if (!item) return { success: false, msg: "Item not found" }

  if (isLibraryPathItemBlacklisted(db, itemId)) {
    return { success: false, msg: "Item is blacklisted — remove it from the blacklist first" }
  }

  const libraryPath = getLibraryPathById(db, item.libraryPathId)
  if (!libraryPath) return { success: false, msg: "Library path not found" }

  if (resetStatus) updateLibraryPathItemStatus(db, itemId, "not_started")

  // The associated video path (for MicroDVD FPS detection). When the library
  // item itself is a subtitle (standalone .sub), there is no video in scope.
  const associatedVideoPath = isSubtitleExtension(item.path) ? null : item.path

  let srtSource: { path: string; isTemp: boolean } | null = null
  if (isSubtitleExtension(item.path)) {
    srtSource = { path: item.path, isTemp: false }
  } else if (sourceOverride && sourceOverride.path) {
    // Use the user-selected source (embedded or external)
    if (sourceOverride.type === "external" && fs.existsSync(sourceOverride.path)) {
      srtSource = { path: sourceOverride.path, isTemp: false }
    } else if (sourceOverride.type === "embedded") {
      // Re-extract the exact chosen embedded track from the media file
      // (embedded temp files are per-scan, so they don't persist). Threading
      // the codec/trackId lets findCompanionSrt extract a VobSub image track
      // to .sub+.idx rather than only text tracks.
      const sourceLang = getLanguageById(db, libraryPath.sourceLangId)
      srtSource = sourceLang
        ? findCompanionSrt(
            item.path,
            sourceLang.iso639,
            sourceLang.iso6392b ?? null,
            sourceLang.name ?? "",
            {
              preferCodec: sourceOverride.codec || null,
              preferTrackId: sourceOverride.trackId ?? null,
            },
          )
        : null
    } else {
      const sourceLang = getLanguageById(db, libraryPath.sourceLangId)
      srtSource = sourceLang
        ? findCompanionSrt(item.path, sourceLang.iso639, sourceLang.iso6392b ?? null, sourceLang.name ?? "")
        : null
    }
  } else {
    const sourceLang = getLanguageById(db, libraryPath.sourceLangId)
    srtSource = sourceLang
      ? findCompanionSrt(item.path, sourceLang.iso639, sourceLang.iso6392b ?? null, sourceLang.name ?? "")
      : null
  }

  if (!srtSource) return { success: false, msg: "No SRT file found next to video file" }

  const adminUser = getHighestRoleUser(db)
  if (!adminUser) return { success: false, msg: "No admin user found" }

  const config = getConfig(db)

  const userTargetLangs = getUserConfigTranslationLanguages(db, userId)
  const targetLangIds =
    userTargetLangs.length > 0
      ? userTargetLangs.map((tl) => tl.languageId)
      : getConfigTranslationLanguages(db).map((cl) => cl.languageId)

  // If the user picked a specific subtitle track (or we guessed a language from
  // the subtitle filename), use that as the translation source language instead
  // of the library path default.
  const sourceLangCode = (sourceOverride && sourceOverride.language) || sourceLanguageHint || ""
  const sourceLangIdOverride: number | null = sourceLangCode
    ? getLanguageByIso(db, sourceLangCode)?.id ?? null
    : null

  try {
    return await autoTranslateItem(
      db,
      adminUser,
      libraryPath,
      itemId,
      srtSource,
      item.mediaItemId,
      item.season,
      item.episode,
      config.defaultChunkSize,
      targetLangIds,
      sourceLangIdOverride,
      associatedVideoPath,
      sourceOverride?.ocrLang ?? null,
      sourceOverride?.fps ?? null,
    )
  } catch {
    return { success: false, msg: "Failed to queue translation" }
  }
}

// Export a single subtitle's files into its library folder. Writes the
// original-language SRT (when available) and one SRT per completed translated
// job, each with the "Translated by BCookieSubs" credit prepended. Files that
// already exist are left untouched, so this is idempotent and safe to call
// repeatedly as jobs complete.
//
// Gated on the owning library path's `autoExtract` setting. Called both from
// the library scanner (via autoExtractItems) and from the worker threads when
// whisper transcription / translation finalizes, so exports land without
// requiring a library rescan.
export async function exportSubtitleToLibraryFolder(
  db: Database.Database,
  subtitle: DBSubtitle,
  opts: { includeOriginal?: boolean; includeTranslated?: boolean; markCompleted?: boolean } = {},
): Promise<void> {
  const includeOriginal = opts.includeOriginal !== false
  const includeTranslated = opts.includeTranslated !== false
  // Only flip the library item to "completed" when the caller knows the whole
  // subtitle is done — per-job incremental exports write files but leave the
  // item status alone so it isn't hidden from later library scans.
  const markCompleted = opts.markCompleted !== false
  if (!subtitle.libraryPathItem) return

  const item = getLibraryPathItemById(db, subtitle.libraryPathItem)
  if (!item) return
  if (isLibraryPathItemBlacklisted(db, item.id)) return

  const libraryPath = getLibraryPathById(db, item.libraryPathId)
  if (!libraryPath || !libraryPath.autoExtract) return

  // Derive the base filename from the source media file (not the subtitle/movie
  // title) and KEEP its original separators. The saved subtitle must share the
  // episode's filename stem so Jellyfin/Plex detect it as a companion
  // subtitle ("<episode>.<lang>.<ext>"); rewriting spaces to dots would make
  // the subtitle's name differ from the episode and break that detection.
  // Only filesystem-illegal characters are stripped.
  // e.g. /series/Show/Season 1/Show - S01E01 - Title.mkv
  //   -> "Show - S01E01 - Title"  ->  "Show - S01E01 - Title.th.ass"
  const sourceBaseRaw = path.basename(item.path).replace(/\.[^.]+$/, "")
  const sourceBase = sourceBaseRaw.replace(/[/\\:*?"<>|]/g, "").trim()

  const outputDir = path.dirname(item.path)
  let lastExportName: string | null = null
  let anyExported = false

  const ext = subtitleExportExtension(subtitle.sourceFormat)
  // A subtitle is a "whisper file" (a legitimate translation source) only when
  // Whisper generated it; library/upload sources are not. Used to decide whether
  // our exported copy may reappear as a translatable row on the Library page.
  const isWhisperSource = subtitle.source === "whisper"

  // Original-language subtitle (e.g. the Whisper-generated source transcript).
  if (includeOriginal && subtitle.originalText) {
    const srcLang = subtitle.sourceLangId ? getLanguageById(db, subtitle.sourceLangId) : null
    const srcCode = (srcLang?.iso639 ?? "original").toLowerCase()
    const origName = `${sourceBase}.${srcCode}${ext}`
    const origPath = path.join(outputDir, origName)

    if (fs.existsSync(origPath)) {
      lastExportName = origName
    } else {
      try {
        fs.writeFileSync(origPath, addCreditToSubtitle(subtitle.originalText, subtitle.sourceFormat), "utf-8")
        lastExportName = origName
        anyExported = true
        recordExportedFile(db, item.libraryPathId, origPath, subtitle.id, isWhisperSource)
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          item.id,
          `Exported original subtitle to ${origName}`,
          { exportPath: origPath, exportName: origName, subtitleId: subtitle.id },
        )
      } catch (e) {
        createLog(
          db,
          "error",
          "libraryScanner", "libraryScanner",
          item.id,
          `Failed to export original subtitle "${origName}": ${String(e).slice(0, 200)}`,
          { exportPath: origPath, exportName: origName, subtitleId: subtitle.id, error: String(e) },
        )
      }
    }
  }

  // Translated SRTs — one file per completed target language.
  if (includeTranslated) {
    const jobs = getSubtitleJobsBySubtitleId(db, subtitle.id)
    const completedJobs = jobs.filter((j) => j.status === "completed" && j.translatedText)

    for (const job of completedJobs) {
      const lang = getLanguageById(db, job.targetLangId)
      if (!lang) continue

      const langCode = lang.iso639.toLowerCase()
      // e.g. Deadpool.2.2018.720p.BluRay.x264-[YTS.AM].th.srt
      const exportName = `${sourceBase}.${langCode}${ext}`
      const exportPath = path.join(outputDir, exportName)

      if (fs.existsSync(exportPath)) {
        lastExportName = exportName
        continue
      }

      try {
        const content = addCreditToSubtitle(job.translatedText!, subtitle.sourceFormat)
        fs.writeFileSync(exportPath, content, "utf-8")
        lastExportName = exportName
        anyExported = true
        recordExportedFile(db, item.libraryPathId, exportPath, subtitle.id, false)
        createLog(
          db,
          "info",
          "libraryScanner", "libraryScanner",
          item.id,
          `Exported translated subtitle to ${exportName} (${lang.name})`,
          {
            exportPath,
            exportName,
            lang: lang.name,
            jobId: job.id,
          },
        )
      } catch (e) {
        createLog(
          db,
          "error",
          "libraryScanner", "libraryScanner",
          item.id,
          `Failed to export translated subtitle "${exportName}" (${lang.name}): ${String(e).slice(0, 200)}`,
          {
            exportPath,
            exportName,
            lang: lang.name,
            jobId: job.id,
            error: String(e),
          },
        )
      }
    }
  }

  if (lastExportName) {
    updateLibraryPathItemExtractFileName(db, item.id, lastExportName)
  }
  if (markCompleted && anyExported) {
    updateLibraryPathItemStatus(db, item.id, "completed")
  }
}

async function autoExtractItems(db: Database.Database, libraryPath: DBLibraryPath): Promise<void> {
  const completedSubtitles = getCompletedLibrarySubtitlesForExport(db)

  for (const row of completedSubtitles) {
    const item = getLibraryPathItemById(db, row.libraryPathItemId)
    if (!item || item.libraryPathId !== libraryPath.id) continue
    if (item.status === "completed") continue

    const subtitle = getSubtitleById(db, row.id)
    if (!subtitle) continue

    // Delegate to the shared per-subtitle exporter (translated SRTs only here;
    // the original-language SRT is exported as soon as whisper finishes).
    await exportSubtitleToLibraryFolder(db, subtitle, { includeOriginal: false, includeTranslated: true })
  }
}
