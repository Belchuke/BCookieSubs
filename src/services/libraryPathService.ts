import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import { getConfigTranslationLanguages } from "../repositories/languageRepository"
import { createLog } from "../repositories/logRepository"
import { createMediaItem, getMediaItemById, getMediaItemByKeys } from "../repositories/mediaRepository"
import { getSubtitleItemMediaItemFromPrompt } from "../repositories/promptFormattingRepository"
import {
  createLibraryPathItem,
  createLibraryPathItemCandidate,
  findLibraryPathItemByPath,
  getEnabledLibraryPaths,
  getLibraryPathById,
  getLibraryPathItemById,
  getLibraryPathsStuckInScanning,
  isLibraryPathItemBlacklisted,
  setLibraryPathState,
  updateLibraryPathItemExtractFileName,
  updateLibraryPathItemStatus,
} from "../repositories/libraryPathRepository"
import { createSubtitleTask, getSubtitleJobsBySubtitleId, getSubtitleById } from "../repositories/subtitleRepository"
import { addCreditToSrt } from "./subtitleExportService"
import { getExportFileName } from "../repositories/subtitleRepository"
import { DBLibraryPath, DBLibraryPathItem, DBUser } from "../types/dbTypes"
import { LIBRARY_SCAN_INTERVAL_MS, STUCK_SCAN_THRESHOLD_MINUTES } from "../setup"

const EXTRACT_TEMP_DIR = path.join(os.tmpdir(), `bcookiesubs-extract-${process.pid}`)
try {
  fs.mkdirSync(EXTRACT_TEMP_DIR, { recursive: true })
} catch {
  }

let _extractCounter = 0
function makeExtractTempPath(stem: string, tag: string): string {
  _extractCounter++
  const safeStem = stem.replace(/[/\\:*?"<>|]/g, "_")
  return path.join(EXTRACT_TEMP_DIR, `${safeStem}.${tag}.${process.pid}-${_extractCounter}.srt`)
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
  } catch {
      }
}

const VIDEO_EXTENSIONS = new Set([
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
      if (VIDEO_EXTENSIONS.has(ext)) videoFiles.push(full)
      else if (ext === ".srt") srtFiles.push(full)
    }
  }
  return { videoFiles, srtFiles }
}

function findAllCompanionSrts(videoFilePath: string): string[] {
  const dir = path.dirname(videoFilePath)
  const stem = path.basename(videoFilePath, path.extname(videoFilePath)).toLowerCase()
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".srt") && e.name.toLowerCase().startsWith(stem))
    .map((e) => path.join(dir, e.name))
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
    const base = path.basename(f, ".srt").toLowerCase()
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
      }))
  } catch {
    return []
  }
}

function extractFfSubtitleStream(videoFile: string, subtitleIndex: number, outputPath: string): boolean {
  try {
    const r = spawnSync("ffmpeg", ["-i", videoFile, "-map", `0:s:${subtitleIndex}`, "-c:s", "srt", "-y", outputPath], {
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
        const outputPath = makeExtractTempPath(stem, tag)
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
    return title.includes(sourceIso1.toLowerCase()) || (sourceIso2b && title.includes(sourceIso2b.toLowerCase())) || title.includes(lowerName)
  })
  const pool = langMatch.length > 0 ? langMatch : streams

  for (const stream of pool) {
    const tag = stream.language ?? `sub${stream.subtitleIndex}`
    const outputPath = makeExtractTempPath(stem, tag)
    if (extractFfSubtitleStream(videoFile, stream.subtitleIndex, outputPath)) return outputPath
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
): string {
  if (!mediaItem) return `${fallbackStem}.srt`
  const sanitized = mediaItem.title
    .replace(/[/\\:*?"<>|]/g, "")
    .replace(/\s+/g, ".")
    .trim()
  let name = sanitized
  if (season != null && episode != null) {
    name += `.S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
  }
  if (mediaItem.year) name += `.(${mediaItem.year})`
  return `${name}.srt`
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

function getAdminUser(db: Database.Database): DBUser | null {
  const row = db.prepare(`SELECT * FROM user WHERE isAdmin = 1 AND deletedAt IS NULL LIMIT 1`).get() as
    | DBUser
    | undefined
  return row ?? null
}

async function matchMediaForFile(
  db: Database.Database,
  adminUser: DBUser,
  fileName: string,
  libraryType: "movie" | "series",
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

  try {
    const detected = await getSubtitleItemMediaItemFromPrompt(
      db,
      adminUser,
      path.basename(fileName, path.extname(fileName)),
    )

    if (detected) {
      season = detected.season
      episode = detected.episode
      detectedYear = detected.year

      const theMovieDbResults = detected.theMovieDbRequestResult ?? []

      if (theMovieDbResults.length > 0) {
                let filtered = detectedYear
          ? theMovieDbResults.filter((r) => {
              const releaseYear = r.releaseDate
                ? parseInt(r.releaseDate.split("-")[0])
                : r.releaseDate !== undefined
                  ? parseInt(String(r.releaseDate).split("-")[0])
                  : null
              return releaseYear === null || releaseYear === detectedYear
            })
          : theMovieDbResults

        if (filtered.length === 0) filtered = theMovieDbResults

        if (filtered.length === 1) {
                    const match = filtered[0]
          const mediaResult = createMediaItem(
            db,
            adminUser,
            match.name ?? detected.name,
            match.originalTitle ?? null,
            libraryType,
            detectedYear,
            false,
            null,
            String(match.id),
            match.posterBase64,
          )
          if (mediaResult.success && mediaResult.mediaItem) {
            return {
              mediaItemId: mediaResult.mediaItem.id,
              multipleMatches: false,
              candidateMediaItemIds: [],
              season,
              episode,
              detectedYear,
            }
          }
        } else {
                    for (const match of filtered) {
            const mediaResult = createMediaItem(
              db,
              adminUser,
              match.name ?? detected.name,
              match.originalTitle ?? null,
              libraryType,
              detectedYear,
              false,
              null,
              String(match.id),
              match.posterBase64,
            )
            if (mediaResult.success && mediaResult.mediaItem) {
              candidateMediaItemIds.push(mediaResult.mediaItem.id)
            }
          }
          return { mediaItemId: null, multipleMatches: true, candidateMediaItemIds, season, episode, detectedYear }
        }
      } else if (detected.name) {
                const existing = getMediaItemByKeys(db, detected.name, libraryType, detectedYear, null)
        if (existing) {
          return {
            mediaItemId: existing.id,
            multipleMatches: false,
            candidateMediaItemIds: [],
            season,
            episode,
            detectedYear,
          }
        }
        const mediaResult = createMediaItem(
          db,
          adminUser,
          detected.name,
          null,
          libraryType,
          detectedYear,
          false,
          null,
          null,
          null,
        )
        if (mediaResult.success && mediaResult.mediaItem) {
          return {
            mediaItemId: mediaResult.mediaItem.id,
            multipleMatches: false,
            candidateMediaItemIds: [],
            season,
            episode,
            detectedYear,
          }
        }
      }
    }
  } catch (e) {
    createLog(db, "warning", "libraryScanner", null, `Name detection failed for file: ${path.basename(fileName)}`, {
      fileName,
      libraryType,
      error: String(e),
    })
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

async function scanLibraryPath(db: Database.Database, libraryPath: DBLibraryPath): Promise<void> {
  const adminUser = getAdminUser(db)
  if (!adminUser) {
    createLog(db, "warning", "libraryScanner", libraryPath.id, `Skipping scan of "${libraryPath.name}": no admin user available to attribute actions to`, {
      libraryPathName: libraryPath.name,
    })
    setLibraryPathState(db, libraryPath.id, "idle")
    return
  }

  if (!fs.existsSync(libraryPath.path)) {
    createLog(db, "warning", "libraryScanner", libraryPath.id, `Library path "${libraryPath.name}" does not exist on disk: ${libraryPath.path}`, {
      libraryPathName: libraryPath.name,
      path: libraryPath.path,
    })
    setLibraryPathState(db, libraryPath.id, "idle")
    return
  }

  const { videoFiles, srtFiles } = findMediaFiles(libraryPath.path)

  const config = getConfig(db)
  const sourceLang = db.prepare(`SELECT * FROM language WHERE id = ?`).get(libraryPath.sourceLangId) as any
  const iso = sourceLang?.iso639 ?? ""
  const iso2b: string | null = sourceLang?.iso6392b ?? null
  const langName = sourceLang?.name ?? ""

    const companionSrtPaths = new Set<string>()

  
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

    const { mediaItemId, multipleMatches, candidateMediaItemIds, season, episode } = await matchMediaForFile(
      db, adminUser, videoFile, libraryPath.type,
    )

    const mediaItem = mediaItemId ? getMediaItemById(db, mediaItemId) : null
    const extractFileName = buildExtractFileName(mediaItem, season, episode, stem)
    const status: DBLibraryPathItem["status"] = mediaItemId ? "not_started" : "no_media_item"

    const item = createLibraryPathItem(db, libraryPath.id, videoFile, extractFileName, mediaItemId, status, season, episode)
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
      await autoTranslateItem(db, adminUser, libraryPath, item.id, resolvedSrt, mediaItemId, season, episode, config.defaultChunkSize)
    } else if (resolvedSrt.isTemp) {
            safeDeleteTempExtract(resolvedSrt.path, db, item.id)
    }
  }

  
  for (const srtFile of srtFiles) {
    if (companionSrtPaths.has(srtFile)) continue

    const srtBasename = path.basename(srtFile)

        if (srtBasename.startsWith("[BCookieSub]")) continue

    const stem = path.basename(srtFile, ".srt")

    if (findLibraryPathItemByPath(db, libraryPath.id, srtFile)) continue

    const { mediaItemId, multipleMatches, candidateMediaItemIds, season, episode } = await matchMediaForFile(
      db, adminUser, srtFile, libraryPath.type,
    )

    const mediaItem = mediaItemId ? getMediaItemById(db, mediaItemId) : null
    const extractFileName = buildExtractFileName(mediaItem, season, episode, stem)
    const status: DBLibraryPathItem["status"] = mediaItemId ? "not_started" : "no_media_item"

    const item = createLibraryPathItem(db, libraryPath.id, srtFile, extractFileName, mediaItemId, status, season, episode)
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

  const configLangs = getConfigTranslationLanguages(db)
  if (configLangs.length === 0) {
    createLog(db, "warning", "libraryScanner", libraryPathItemId, "No default target languages configured — cannot auto-translate library item", {})
    return { success: false, msg: "No default target languages configured — add them in Settings" }
  }

  const targetLangIds = configLangs.map((cl) => cl.languageId)
  const srtFileName = path.basename(srtFilePath)

  const mediaItem = mediaItemId ? getMediaItemById(db, mediaItemId) : null
  const displayName = buildDisplayName(mediaItem)

      const storedSourcePath = isTemp ? null : srtFilePath
  const storedMediaDir = isTemp ? path.dirname(libraryPath.path) : path.dirname(srtFilePath)

  const result = createSubtitleTask(
    db,
    adminUser,
    mediaItemId,
    libraryPath.sourceLangId,
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
    createLog(db, "warning", "libraryScanner", libraryPathItemId, `Failed to create subtitle task for library item: ${result.msg ?? "unknown reason"}`, {
      srtFileName,
      msg: result.msg,
    })
    return { success: false, msg: result.msg ?? "Failed to create subtitle task" }
  }
}

async function autoExtractItems(db: Database.Database, libraryPath: DBLibraryPath): Promise<void> {
    const completedSubtitles = db
    .prepare(
      `SELECT DISTINCT s.id, s.libraryPathItem as libraryPathItemId, s.mediaItemId
       FROM subtitle s
       INNER JOIN subtitleJob sj ON sj.subtitleId = s.id
       WHERE s.libraryPathItem IS NOT NULL AND sj.status = 'completed'`,
    )
    .all() as { id: number; libraryPathItemId: number; mediaItemId: number | null }[]

  for (const row of completedSubtitles) {
    const item = getLibraryPathItemById(db, row.libraryPathItemId)
    if (!item || item.libraryPathId !== libraryPath.id) continue
    if (item.status === "completed") continue
    if (isLibraryPathItemBlacklisted(db, item.id)) continue

    const jobs = getSubtitleJobsBySubtitleId(db, row.id)
    const completedJobs = jobs.filter((j) => j.status === "completed" && j.translatedText)

    if (completedJobs.length === 0) continue

    const subtitle = getSubtitleById(db, row.id)
    if (!subtitle) continue

    const mediaItem = item.mediaItemId
      ? (db.prepare(`SELECT * FROM mediaItem WHERE id = ?`).get(item.mediaItemId) as any)
      : null

    const outputDir = path.dirname(item.path)

    for (const job of completedJobs) {
      const lang = db.prepare(`SELECT * FROM language WHERE id = ?`).get(job.targetLangId) as any
      if (!lang) continue

      const rawTitle = mediaItem?.title ?? subtitle.name
      const title = rawTitle
        .replace(/[/\\:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
      const langCode = lang.iso639.toLowerCase()
      const exportName = getExportFileName(title, job.season, job.episode, mediaItem?.year ?? null, langCode)
      const exportPath = path.join(outputDir, exportName)

            if (fs.existsSync(exportPath)) continue

      try {
        const content = addCreditToSrt(job.translatedText!)
        fs.writeFileSync(exportPath, content, "utf-8")
        updateLibraryPathItemExtractFileName(db, item.id, exportName)
        createLog(db, "info", "libraryScanner", item.id, `Exported translated subtitle to ${exportName} (${lang.name})`, {
          exportPath,
          exportName,
          lang: lang.name,
          jobId: job.id,
        })
      } catch (e) {
        createLog(db, "error", "libraryScanner", item.id, `Failed to export translated subtitle "${exportName}" (${lang.name}): ${String(e).slice(0, 200)}`, {
          exportPath,
          exportName,
          lang: lang.name,
          jobId: job.id,
          error: String(e),
        })
      }
    }

        updateLibraryPathItemStatus(db, item.id, "completed")
  }
}

export async function libraryScannerMain(db: Database.Database): Promise<void> {
  console.log("[library-scanner] Started")

  while (true) {
    try {
      await runScannerOnce(db)
    } catch (e) {
      createLog(db, "error", "libraryScanner", null, `Library scanner loop crashed: ${String(e).slice(0, 200)}`, { error: String(e) })
      console.error("[library-scanner] Unexpected error:", e)
    }
    await sleep(LIBRARY_SCAN_INTERVAL_MS)
  }
}

async function runScannerOnce(db: Database.Database): Promise<void> {
  const config = getConfig(db)
  if (!config.scanLibraryPaths) return

    const stuckPaths = getLibraryPathsStuckInScanning(db)
  for (const lp of stuckPaths) {
    setLibraryPathState(db, lp.id, "error")
    createLog(db, "error", "libraryScanner", lp.id, `Library path "${lp.name}" scan stuck for more than ${STUCK_SCAN_THRESHOLD_MINUTES} minutes — marked as error`, {
      name: lp.name,
      lastRunAt: lp.lastRunAt,
      thresholdMinutes: STUCK_SCAN_THRESHOLD_MINUTES,
    })
    console.warn(
      `[library-scanner] Path "${lp.name}" stuck in scanning > ${STUCK_SCAN_THRESHOLD_MINUTES}min — marked error`,
    )
  }

    const enabledPaths = getEnabledLibraryPaths(db)

  for (const lp of enabledPaths) {
        const fresh = getLibraryPathById(db, lp.id)
    if (!fresh || !fresh.enabled) continue
    if (fresh.state === "scanning") continue

    setLibraryPathState(db, lp.id, "scanning", true)
    try {
      await scanLibraryPath(db, lp)
    } catch (e) {
      createLog(db, "error", "libraryScanner", lp.id, `Scan failed for library path "${lp.name}": ${String(e).slice(0, 200)}`, {
        name: lp.name,
        path: lp.path,
        error: String(e),
      })
      console.error(`[library-scanner] Scan error for "${lp.name}":`, e)
      setLibraryPathState(db, lp.id, "error")
      continue
    }
    setLibraryPathState(db, lp.id, "idle")
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
