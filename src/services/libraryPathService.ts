import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import { getConfigTranslationLanguages, getLanguageById } from "../repositories/languageRepository"
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
import { addCreditToSubtitle, subtitleExportExtension } from "./subtitleExportService"
import { isSubtitleExtension, subtitleExtensionOf } from "./subtitleFormatDetector"
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

function safeDeleteTempExtract(filePath: string, db?: Database.Database, itemId: number | null = null): void {
  if (!filePath.startsWith(EXTRACT_TEMP_DIR)) return
  try {
    fs.unlinkSync(filePath)
  } catch (e: any) {
    if (e?.code !== "ENOENT" && db) {
      createLog(db, "warning", "libraryScanner", itemId, "Failed to delete temporary extracted subtitle file", {
        path: filePath,
        error: String(e),
      })
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
  // SxxExx — highest priority
  const se = base.match(/[Ss]\d{1,2}[Ee](\d{1,3})/)
  if (se) return parseInt(se[1])
  // 1x01 format
  const x = base.match(/\b\d{1,2}[xX](\d{2,3})\b/)
  if (x) return parseInt(x[1])
  // E01 / EP01 standalone (we already returned above if SxxExx matched)
  const e = base.match(/\bE[Pp]?(\d{1,3})\b/)
  if (e) return parseInt(e[1])
  // "Episode 01" literal
  const ep = base.match(/\bepisode\s*(\d{1,3})\b/i)
  if (ep) return parseInt(ep[1])
  // SP00 specials: " - SP01" or "SP01"
  const sp = base.match(/\bSP(\d{1,3})\b/i)
  if (sp) return parseInt(sp[1])
  // Anime-style " - 01 - Title" or " - 01" at end (2–3 digit episode, not a year)
  const anime = base.match(/\s+-\s+(\d{2,3})(?:\s+-\s+|\s*$|\s+\()/)
  if (anime) return parseInt(anime[1])
  return null
}

function parseSeasonFromFilename(filename: string): number | null {
  const base = path.basename(filename, path.extname(filename))
  const se = base.match(/[Ss](\d{1,2})[Ee]\d{1,3}/)
  if (se) return parseInt(se[1])
  const x = base.match(/\b(\d{1,2})[xX]\d{2,3}\b/)
  if (x) return parseInt(x[1])
  return null
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

  return candidates.reduce((best, f) => {
    try {
      return fs.statSync(f).size > fs.statSync(best).size ? f : best
    } catch {
      return best
    }
  })
}

interface MkvSubTrack {
  id: number
  codec: string
  language: string | null
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

function trackLangMatches(trackLang: string | null, sourceIso1: string, sourceIso2b: string | null): boolean {
  if (!trackLang) return false
  const t = trackLang.toLowerCase()
  if (sourceIso2b && t === sourceIso2b.toLowerCase()) return true
  if (t === sourceIso1.toLowerCase()) return true
  return false
}

function extractBestEmbeddedSrt(
  videoFile: string,
  sourceIso1: string,
  sourceIso2b: string | null,
  langName: string,
): string | null {
  const stem = path.basename(videoFile, path.extname(videoFile))
  const ext = path.extname(videoFile).toLowerCase()

  if (ext === ".mkv") {
    const tracks = probeMkvSubtitleTracks(videoFile)
    if (tracks !== null) {
      if (tracks.length === 0) return null

      const langMatch = tracks.filter((t) => trackLangMatches(t.language, sourceIso1, sourceIso2b))
      const pool = langMatch.length > 0 ? langMatch : tracks

      const sorted = [...pool].sort((a, b) => {
        if (a.defaultTrack !== b.defaultTrack) return a.defaultTrack ? -1 : 1
        return b.numIndexEntries - a.numIndexEntries
      })

      for (const track of sorted) {
        const tag = track.language ?? `sub${track.id}`
        const outputPath = makeExtractTempPath(stem, tag, codecToSubtitleExt(track.codec))
        if (extractMkvTrack(videoFile, track.id, outputPath)) return outputPath
      }
      return null
    }
  }

  const streams = probeFfSubtitleStreams(videoFile)
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
): ResolvedSrt | null {
  const companions = findAllCompanionSrts(videoFilePath)
  const best = selectBestSrt(companions, [], sourceLangIso639, sourceLangName)
  if (best) return { path: best, isTemp: false }
  const extracted = extractBestEmbeddedSrt(videoFilePath, sourceLangIso639, sourceLangIso2b, sourceLangName)
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
}

function externalCandidatesFor(videoFilePath: string): string[] {
  return findAllCompanionSrts(videoFilePath)
}

function embeddedCandidatesFor(videoFilePath: string, ext: string): { trackId: number; language: string | null; codec: string }[] {
  if (ext === ".mkv") {
    const tracks = probeMkvSubtitleTracks(videoFilePath)
    if (tracks) {
      return tracks.map((t) => ({ trackId: t.id, language: t.language, codec: t.codec }))
    }
  }
  const streams = probeFfSubtitleStreams(videoFilePath)
  return streams.map((s) => ({ trackId: s.subtitleIndex, language: s.language, codec: s.codecName ?? "embedded" }))
}

export function listSubtitleSourcesForVideo(
  videoFilePath: string,
  sourceLangIso639: string,
  sourceLangIso2b: string | null = null,
  sourceLangName = "",
): SubtitleSourceCandidate[] {
  const result: SubtitleSourceCandidate[] = []
  const ext = path.extname(videoFilePath).toLowerCase()
  const stem = path.basename(videoFilePath, path.extname(videoFilePath))

  for (const srt of externalCandidatesFor(videoFilePath)) {
    const filename = path.basename(srt)
    const fileExt = subtitleExtensionOf(filename) ?? ".srt"
    result.push({
      type: "external",
      path: srt,
      isTemp: false,
      label: filename,
      language: null,
      codec: fileExt,
      filename,
      filenameOnly: filename,
    })
  }

  for (const track of embeddedCandidatesFor(videoFilePath, ext)) {
    const langTag = track.language ?? `track-${track.trackId}`
    const trackExt = codecToSubtitleExt(track.codec)
    const tempPath = makeExtractTempPath(stem, langTag, trackExt)
    result.push({
      type: "embedded",
      path: tempPath,
      isTemp: true,
      label: `Embedded · ${track.codec} · ${track.language ?? "unknown"}`,
      language: track.language,
      codec: track.codec,
      filename: null,
      filenameOnly: `${stem}.${langTag}${trackExt}`,
    })
  }

  // Default ordering: external first, then embedded; prefer embedded when matched to source language
  result.sort((a, b) => {
    if (a.type === b.type) return 0
    return a.type === "external" ? -1 : 1
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
  // If only one, mark preferred if it's embedded
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

// Prefer the canonical Jellyfin/Kodi filename (movie.nfo / tvshow.nfo) and fall
// back to any other .nfo in the folder (e.g. a release-named "Free Guy.nfo").
// Returns null when the folder has no .nfo at all.
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
  return canonical ?? nfos[0]
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
function parseTmdbIdFromFolderName(folderName: string): number | null {
  const m = folderName.match(/[[{]\s*tmdb(?:id)?-(\d+)\s*[\]}]/i)
  return m ? parseInt(m[1]) : null
}

// Strip id/source tags so the LLM matcher sees a clean title, e.g.
// "Captain America: Civil War (2016) [tmdbid-271110]" -> "Captain America: Civil War (2016)".
function stripFolderIdTags(folderName: string): string {
  return folderName
    .replace(/[[{]\s*(?:tmdb|imdb|tvdb)(?:id)?-[^\]}]*[\]}]/gi, "")
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
          "libraryScanner",
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
        "libraryScanner",
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
  const idSources: { tmdbId: number; source: string }[] = []
  if (nfoMeta?.tmdbId) idSources.push({ tmdbId: nfoMeta.tmdbId, source: "NFO" })
  const folderTmdbId = parseTmdbIdFromFolderName(path.basename(nfoDir))
  if (folderTmdbId && folderTmdbId !== nfoMeta?.tmdbId) idSources.push({ tmdbId: folderTmdbId, source: "folder name" })

  for (const { tmdbId, source } of idSources) {
    try {
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
            "libraryScanner",
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
      }
    } catch (e) {
      createLog(
        db,
        "warning",
        "libraryScanner",
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
    detectionNames.push(getSeriesDetectionName(fileName, libraryPathRoot))
    if (stem && !detectionNames.includes(stem)) detectionNames.push(stem)
  } else {
    const dir = path.normalize(path.dirname(fileName))
    const root = path.normalize(libraryPathRoot)
    const folderName = dir === root ? null : stripFolderIdTags(path.basename(dir))
    detectionNames.push(stem)
    if (folderName && folderName !== stem) detectionNames.push(folderName)
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

        const theMovieDbResults = detected.theMovieDbRequestResult ?? []

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
              "libraryScanner",
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
      createLog(db, "warning", "libraryScanner", null, `Name detection failed for file: ${path.basename(fileName)}`, {
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
  let multipleOutcome: DetectionOutcome | null = null
  for (const detectionName of detectionNames) {
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

export async function scanLibraryPath(db: Database.Database, libraryPath: DBLibraryPath): Promise<void> {
  const adminUser = getHighestRoleUser(db)
  if (!adminUser) {
    createLog(
      db,
      "warning",
      "libraryScanner",
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
      "libraryScanner",
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
    createLog(db, "info", "libraryScanner", inv.id, `Removed library item no longer on disk: ${inv.path}`, {
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

  const seriesFolderCache = new Map<
    string,
    {
      mediaItemId: number | null
      multipleMatches: boolean
      candidateMediaItemIds: number[]
      detectedYear: number | null
    }
  >()

  for (const videoFile of videoFiles) {
    const stem = path.basename(videoFile, path.extname(videoFile))

    if (findLibraryPathItemByPath(db, libraryPath.id, videoFile)) {
      findAllCompanionSrts(videoFile).forEach((s) => companionSrtPaths.add(s))
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

    if (!resolvedSrt) {
      createLibraryPathItem(db, libraryPath.id, videoFile, `${stem}.srt`, null, "no_srts_found", null, null)
      continue
    }

    let mediaItemId: number | null = null
    let multipleMatches = false
    let candidateMediaItemIds: number[] = []
    let season: number | null = null
    let episode: number | null = null

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
      season =
        seasonFolder !== null
          ? (parseSeasonFolderName(seasonFolder) ?? parseSeasonFromFilename(videoFile))
          : parseSeasonFromFilename(videoFile)
      // Files directly in the series root with no season info default to season 1
      if (season === null && seasonFolder === null) season = 1
      episode = parseEpisodeFromFilename(videoFile)
    } else {
      const detection = await matchMediaForFile(db, adminUser, videoFile, libraryPath.type, libraryPath.path)
      mediaItemId = detection.mediaItemId
      multipleMatches = detection.multipleMatches
      candidateMediaItemIds = detection.candidateMediaItemIds
      season = detection.season
      episode = detection.episode
    }

    const mediaItem = mediaItemId ? getMediaItemById(db, mediaItemId) : null
    const extractFileName = buildExtractFileName(mediaItem, season, episode, stem)
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
    )
    if (!item) {
      if (resolvedSrt.isTemp) safeDeleteTempExtract(resolvedSrt.path, db)
      continue
    }

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
      )
    } else if (resolvedSrt.isTemp) {
      safeDeleteTempExtract(resolvedSrt.path, db, item.id)
    }
  }

  for (const srtFile of srtFiles) {
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
          "libraryScanner",
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
          "libraryScanner",
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
      season =
        seasonFolder !== null
          ? (parseSeasonFolderName(seasonFolder) ?? parseSeasonFromFilename(srtFile))
          : parseSeasonFromFilename(srtFile)
      if (season === null && seasonFolder === null) season = 1
      episode = parseEpisodeFromFilename(srtFile)
    } else {
      const detection = await matchMediaForFile(db, adminUser, srtFile, libraryPath.type, libraryPath.path)
      mediaItemId = detection.mediaItemId
      multipleMatches = detection.multipleMatches
      candidateMediaItemIds = detection.candidateMediaItemIds
      season = detection.season
      episode = detection.episode
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
): Promise<{ success: boolean; msg: string }> {
  const { path: srtFilePath, isTemp } = srtSource

  if (isLibraryPathItemBlacklisted(db, libraryPathItemId)) {
    if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)
    return { success: false, msg: "Item is blacklisted from translation" }
  }
  let srtContent: string
  try {
    srtContent = fs.readFileSync(srtFilePath, "utf-8")
  } catch (e) {
    createLog(db, "error", "libraryScanner", libraryPathItemId, "Failed to read SRT file for auto-translate", {
      path: srtFilePath,
      isTemp,
      error: String(e),
    })
    updateLibraryPathItemStatus(db, libraryPathItemId, "failed")
    if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)
    return { success: false, msg: "Could not read SRT file" }
  }

  if (isTemp) safeDeleteTempExtract(srtFilePath, db, libraryPathItemId)

  const targetLangIds = overrideTargetLangIds ?? getConfigTranslationLanguages(db).map((cl) => cl.languageId)
  if (targetLangIds.length === 0) {
    createLog(
      db,
      "warning",
      "libraryScanner",
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
    sourceLangIdOverride ?? libraryPath.sourceLangId,
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
  )

  if (result.success) {
    updateLibraryPathItemStatus(db, libraryPathItemId, "queued")
    createLog(db, "info", "libraryScanner", libraryPathItemId, `Queued library item for translation: ${srtFileName}`, {
      srtFileName,
      targetLangIds,
      fromEmbeddedExtract: isTemp,
    })
    return { success: true, msg: result.msg ?? "Queued for translation" }
  } else {
    createLog(
      db,
      "warning",
      "libraryScanner",
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
          "libraryScanner",
          item.id,
          `Exported original subtitle to ${origName}`,
          { exportPath: origPath, exportName: origName, subtitleId: subtitle.id },
        )
      } catch (e) {
        createLog(
          db,
          "error",
          "libraryScanner",
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
          "libraryScanner",
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
          "libraryScanner",
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
