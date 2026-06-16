import { Router } from "express"
import Database from "better-sqlite3"
import * as path from "path"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"
import { getConfig, isWhisperGpuAvailable } from "../repositories/configRepository"
import {
  getLibraryPaths,
  getLibraryPathItemsWithDetails,
  getLibraryPathItemById,
  getLibraryPathById,
  updateLibraryPathItemMediaItem,
} from "../repositories/libraryPathRepository"
import {
  getConfigTranslationLanguages,
  getLanguageById,
  getLanguages,
  getUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { createMediaItem, getMediaItemById } from "../repositories/mediaRepository"
import {
  addMissingTargetLanguageJobs,
  getActiveSubtitleForLibraryPathItem,
  createWhisperSubtitle,
  getActiveWhisperSubtitleForMediaItem,
  createPlaceholderTranslationJobs,
  getTargetLanguagesForWhisperWorkflow,
  getJobLangStatusBySubtitle,
} from "../repositories/subtitleRepository"
import { getHighestRoleUser } from "../repositories/userRepository"
import {
  findCompanionSrt,
  listSubtitleSourcesForVideo,
  isVideoFile,
} from "../services/libraryPathService"
import { autoTranslateItem } from "../services/libraryPathService"

type RequestGroupItem = {
  itemId: number
  season: number | null
  episode: number | null
  fileName: string
  libraryPathName: string
  libraryPathId: number
  subtitleId: number | null
  missingTargetLangIds: number[]
  hasActiveJobs: boolean
  whisperStatus: string | null
  isVideo: boolean
  hasSrt: boolean
}

type RequestGroup = {
  key: string
  title: string
  year: number | null
  genres: string | null
  posterPath: string | null
  type: "movie" | "series"
  items: RequestGroupItem[]
}

export function libraryRequestsRouter(db: Database.Database) {
  const router = Router()

  router.use(requireAuth, requirePermission("canAddSubtitleToTranslateFromLibrary"))

  router.get("/", (req, res) => {
    const user = res.locals.user!
    const libraryPaths = getLibraryPaths(db).filter((lp) => lp.enabled)
    const userTargetLangs = getUserConfigTranslationLanguages(db, user.id)
    const userTargetLangIds = userTargetLangs.map((tl) => tl.languageId)
    const theme = getActiveTheme(db, user.id)
    const config = getConfig(db)
    const showPosters = !!config.showPosters && user.showPosters !== 0
    const languages = getLanguages(db)
    const langById = Object.fromEntries(languages.map((l) => [l.id, l]))

    const groupsMap = new Map<string, RequestGroup>()

    function addItemToGroup(
      lpType: "movie" | "series",
      mediaItem: any | null,
      item: any,
      subtitleId: number | null,
      missingTargetLangIds: number[],
      hasActiveJobs: boolean,
      whisperStatus: string | null,
    ) {
      const key = mediaItem?.id ? String(mediaItem.id) : `unmatched-${item.id}`
      const existing = groupsMap.get(key)
      const groupItem: RequestGroupItem = {
        itemId: item.id,
        season: item.season,
        episode: item.episode,
        fileName: item.path.split("/").pop() ?? "",
        libraryPathName: lpType === "movie" ? "" : "",
        libraryPathId: item.libraryPathId ?? 0,
        subtitleId,
        missingTargetLangIds,
        hasActiveJobs,
        whisperStatus,
        isVideo: isVideoFile(item.path),
        hasSrt: item.status !== "no_srts_found",
      }
      if (existing) {
        existing.items.push(groupItem)
        existing.items.sort((a, b) => {
          if (a.season != null && b.season != null) {
            if (a.season !== b.season) return a.season - b.season
            return (a.episode ?? 0) - (b.episode ?? 0)
          }
          return a.fileName.localeCompare(b.fileName)
        })
        return
      }
      groupsMap.set(key, {
        key,
        title: mediaItem?.title ?? item.path.split("/").pop() ?? "Untitled",
        year: mediaItem?.year ?? null,
        genres: mediaItem?.genres ?? null,
        posterPath: mediaItem?.mediaItemPhotoPath ?? null,
        type: lpType,
        items: [groupItem],
      })
    }

    for (const lp of libraryPaths) {
      const items = getLibraryPathItemsWithDetails(db, lp.id)
      for (const item of items) {
        if (item.blacklist) continue
        if (item.status === "not_started" || item.status === "no_srts_found") {
          const whisperStatus = item.mediaItemId
            ? getActiveWhisperSubtitleForMediaItem(db, item.mediaItemId)?.whisperTranscriptionStatus ?? null
            : null
          addItemToGroup(lp.type, item.mediaItem, item, null, userTargetLangIds, false, whisperStatus)
          continue
        }

        if (item.subtitleInfo && !item.subtitleInfo.deleted) {
          // Use the actual job targetLangId mapping from DB to be authoritative
          const jobRows = getJobLangStatusBySubtitle(db, item.subtitleInfo.subtitleId)

          const finishedLangIds = new Set(
            jobRows.filter((j) => j.status === "completed").map((j) => j.targetLangId),
          )
          const hasActiveJobs = jobRows.some(
            (j) => j.status === "queued" || j.status === "running",
          )

          const missingTargetLangIds =
            userTargetLangIds.length === 0
              ? []
              : userTargetLangIds.filter((id) => !finishedLangIds.has(id))

          // If no user target languages configured, show the item (no specific filter)
          // If all target languages are finished, hide the item
          // If a translation was deleted (no active jobs, no completed), show with all languages missing
          const allCompleted =
            userTargetLangIds.length > 0 &&
            userTargetLangIds.every((id) => finishedLangIds.has(id))

          if (allCompleted) continue

          if (missingTargetLangIds.length === 0 && !hasActiveJobs) {
            // No missing and no active - hide
            continue
          }

          const whisperStatus = item.mediaItemId
            ? getActiveWhisperSubtitleForMediaItem(db, item.mediaItemId)?.whisperTranscriptionStatus ?? null
            : null
          addItemToGroup(
            lp.type,
            item.mediaItem,
            item,
            item.subtitleInfo.subtitleId,
            missingTargetLangIds,
            hasActiveJobs,
            whisperStatus,
          )
        }
      }
    }

    const allGroups = Array.from(groupsMap.values())
    allGroups.sort((a, b) => a.title.localeCompare(b.title))

    const allGenres: string[] = []
    for (const group of allGroups) {
      if (group.genres) {
        group.genres.split(",").forEach((g) => {
          const trimmed = g.trim()
          if (trimmed && allGenres.indexOf(trimmed) === -1) allGenres.push(trimmed)
        })
      }
    }
    allGenres.sort()

    const movieGroups = allGroups.filter((g) => g.type === "movie")
    const seriesGroups = allGroups.filter((g) => g.type === "series")

    res.render("libraryrequests", {
      user,
      activeNav: "library-requests",
      movieGroups,
      seriesGroups,
      allGenres,
      showPosters,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
      languages,
      langById,
    })
  })

  // Returns available subtitle sources for a library path item
  router.get("/item/:itemId/subtitle-sources", (req, res) => {
    const itemId = parseInt(String(req.params.itemId))
    const item = getLibraryPathItemById(db, itemId)
    if (!item) return res.json({ success: false, msg: "Item not found", sources: [] })

    const lp = getLibraryPathById(db, item.libraryPathId)
    if (!lp) return res.json({ success: false, msg: "Library path not found", sources: [] })

    const sourceLang = getLanguageById(db, lp.sourceLangId)
    if (!sourceLang) return res.json({ success: false, msg: "Source language not found", sources: [] })

    // Only list sources for video files (not standalone .srt)
    if (item.path.toLowerCase().endsWith(".srt")) {
      return res.json({ success: true, sources: [], message: "Standalone SRT — no source selection needed" })
    }

    const sources = listSubtitleSourcesForVideo(
      item.path,
      sourceLang.iso639,
      sourceLang.iso6392b ?? null,
      sourceLang.name,
    )
    res.json({ success: true, sources })
  })

  // Add missing target language(s) to an existing subtitle
  router.post("/item/:itemId/add-missing-lang", (req, res) => {
    const itemId = parseInt(String(req.params.itemId))
    const targetLangIds: number[] = (() => {
      const raw = (req.body as { targetLangIds?: string | string[] }).targetLangIds
      if (!raw) return []
      if (Array.isArray(raw)) return raw.map(Number).filter((n) => !isNaN(n) && n > 0)
      return String(raw)
        .split(",")
        .map((s) => parseInt(s.trim()))
        .filter((n) => !isNaN(n) && n > 0)
    })()

    if (targetLangIds.length === 0) {
      if (req.query.json === "1") return res.json({ success: false, msg: "No target languages provided" })
      return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("No target languages provided"))
    }

    const item = getLibraryPathItemById(db, itemId)
    if (!item) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Item not found" })
      return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("Item not found"))
    }

    const subtitle = getActiveSubtitleForLibraryPathItem(db, itemId)
    if (!subtitle) {
      if (req.query.json === "1") return res.json({ success: false, msg: "No existing subtitle to add jobs to" })
      return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("No existing subtitle"))
    }

    const result = addMissingTargetLanguageJobs(db, res.locals.user!, subtitle.id, targetLangIds)
    if (req.query.json === "1") return res.json(result)
    if (!result.success) return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed"))
    res.redirect("/library-requests?toast=success&msg=" + encodeURIComponent(result.msg ?? "Added"))
  })

  // Create a Whisper-generated subtitle for a library path item (movie first)
  router.post(
    "/item/:itemId/create-whisper-subtitle",
    requirePermission("canCreateSubtitlesWithWhisper"),
    async (req, res) => {
      const user = res.locals.user!
      const itemId = parseInt(String(req.params.itemId))
      const item = getLibraryPathItemById(db, itemId)
      if (!item) {
        return res.json({ success: false, msg: "Item not found" })
      }

      const lp = getLibraryPathById(db, item.libraryPathId)
      if (!lp) {
        return res.json({ success: false, msg: "Library path not found" })
      }

      const sourceLang = getLanguageById(db, lp.sourceLangId)
      if (!sourceLang) {
        return res.json({ success: false, msg: "Source language not found" })
      }

      const targetLangIds = getTargetLanguagesForWhisperWorkflow(db, user.id)
      if (targetLangIds.length === 0) {
        return res.json({ success: false, msg: "No target languages configured" })
      }

      let mediaItemId = item.mediaItemId
      if (!mediaItemId) {
        const title = path.basename(item.path, path.extname(item.path)).replace(/[._]/g, " ").trim()
        const mediaResult = await createMediaItem(
          db,
          user,
          title,
          null,
          lp.type,
          null,
          false,
          null,
          null,
          null,
        )
        if (!mediaResult.success || !mediaResult.mediaItem) {
          return res.json({ success: false, msg: mediaResult.msg ?? "Could not create media item" })
        }
        mediaItemId = mediaResult.mediaItem.id
        updateLibraryPathItemMediaItem(db, item.id, mediaItemId)
      }

      if (getActiveWhisperSubtitleForMediaItem(db, mediaItemId)) {
        return res.json({ success: true, msg: "Whisper subtitle workflow already exists" })
      }

      const config = getConfig(db)
      const model = config.whisperModel
      const timestampsLength = config.whisperTimestampsLength
      const useCuda = isWhisperGpuAvailable() && config.whisperUseCuda === 1
      const displayName = getMediaItemById(db, mediaItemId)?.title ?? path.basename(item.path)
      const srtFileName = `${path.basename(item.path, path.extname(item.path))}.whisper.srt`

      const result = createWhisperSubtitle(
        db,
        user,
        mediaItemId,
        item.id,
        item.path,
        lp.sourceLangId,
        srtFileName,
        displayName,
        model,
        timestampsLength,
        useCuda,
        item.season,
        item.episode,
      )

      if (!result.success) {
        return res.json({ success: false, msg: result.msg ?? "Failed to create Whisper subtitle workflow" })
      }

      if (targetLangIds.length > 0) {
        createPlaceholderTranslationJobs(
          db,
          user,
          result.subtitle.id,
          targetLangIds,
          item.season,
          item.episode,
        )
      }

      return res.json({ success: true, msg: "Whisper subtitle workflow created", subtitleId: result.subtitle.id })
    },
  )

  // Translate season: queue translation for all eligible episodes in a season
  router.post("/season/:libraryPathId/translate", async (req, res) => {
    const libraryPathId = parseInt(String(req.params.libraryPathId))
    const season = parseInt(String((req.body as { season?: string }).season ?? ""))
    if (isNaN(season)) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Invalid season" })
      return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("Invalid season"))
    }

    const user = res.locals.user!
    const lp = getLibraryPathById(db, libraryPathId)
    if (!lp) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Library path not found" })
      return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("Library path not found"))
    }

    const items = getLibraryPathItemsWithDetails(db, libraryPathId).filter(
      (i) => i.season === season && !i.blacklist,
    )
    if (items.length === 0) {
      if (req.query.json === "1") return res.json({ success: false, msg: "No items in season" })
      return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("No items in season"))
    }

    const sourceLang = getLanguageById(db, lp.sourceLangId)
    if (!sourceLang) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Source language not found" })
      return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("Source language not found"))
    }

    const userTargetLangs = getUserConfigTranslationLanguages(db, user.id)
    const userTargetLangIds = userTargetLangs.map((tl) => tl.languageId)
    const targetLangIds =
      userTargetLangs.length > 0
        ? userTargetLangs.map((tl) => tl.languageId)
        : getConfigTranslationLanguages(db).map((cl) => cl.languageId)

    let queued = 0
    let skipped = 0
    const failedMessages: string[] = []

    for (const item of items) {
      // If the item already has a subtitle with completed jobs for the user's languages, skip
      if (item.subtitleInfo && !item.subtitleInfo.deleted) {
        const jobRows = getJobLangStatusBySubtitle(db, item.subtitleInfo.subtitleId)
        const completed = new Set(
          jobRows.filter((j) => j.status === "completed").map((j) => j.targetLangId),
        )
        if (userTargetLangIds.length > 0 && userTargetLangIds.every((id) => completed.has(id))) {
          skipped++
          continue
        }
      }

      // Resolve SRT
      let srtSource: { path: string; isTemp: boolean } | null = null
      if (item.path.toLowerCase().endsWith(".srt")) {
        srtSource = { path: item.path, isTemp: false }
      } else {
        srtSource = findCompanionSrt(
          item.path,
          sourceLang.iso639,
          sourceLang.iso6392b ?? null,
          sourceLang.name,
        )
      }
      if (!srtSource) {
        failedMessages.push(path.basename(item.path))
        continue
      }

      // Find admin user
      const adminUser = getHighestRoleUser(db)
      if (!adminUser) {
        if (req.query.json === "1") return res.json({ success: false, msg: "No admin user found" })
        return res.redirect("/library-requests?toast=error&msg=" + encodeURIComponent("No admin user found"))
      }

      const config = getConfig(db)
      const result = await autoTranslateItem(
        db,
        adminUser,
        lp,
        item.id,
        srtSource,
        item.mediaItemId,
        item.season,
        item.episode,
        config.defaultChunkSize,
        targetLangIds,
      )
      if (result.success) queued++
      else failedMessages.push(path.basename(item.path) + " (" + (result.msg || "?") + ")")
    }

    const msg = `Queued ${queued} episode(s), skipped ${skipped} (already done)${failedMessages.length > 0 ? `, failed ${failedMessages.length}` : ""}`
    if (req.query.json === "1") return res.json({ success: true, msg, queued, skipped, failed: failedMessages })
    res.redirect("/library-requests?toast=success&msg=" + encodeURIComponent(msg))
  })

  return router
}
