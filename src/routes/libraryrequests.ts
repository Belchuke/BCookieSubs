import { Router } from "express"
import Database from "better-sqlite3"
import * as path from "path"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"
import { getConfig, isWhisperGpuAvailable } from "../repositories/configRepository"
import {
  getLibraryPathsByType,
  getLibraryPathItemsForPaths,
  getLibraryPathItemsWithDetails,
  getLibraryPathItemById,
  getLibraryPathById,
  enrichItems,
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
  getActiveWhisperSubtitlesByLibraryPathItems,
  createPlaceholderTranslationJobs,
  getTargetLanguagesForWhisperWorkflow,
  getJobLangStatusBySubtitle,
  getJobLangStatusBySubtitles,
} from "../repositories/subtitleRepository"
import { getHighestRoleUser } from "../repositories/userRepository"
import {
  findCompanionSrt,
  listSubtitleSourcesForVideo,
  isVideoFile,
} from "../services/libraryPathService"
import { autoTranslateItem } from "../services/libraryPathService"
import { isSubtitleExtension } from "../services/subtitleFormatDetector"

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
  type: "movie" | "series" | "unmatched"
  items: RequestGroupItem[]
  // Full filesystem path of the file, surfaced for unmatched items so the user
  // can locate it on disk and fix/rename it (unmatched items are read-only here).
  filePath?: string | null
}

export function libraryRequestsRouter(db: Database.Database) {
  const router = Router()

  router.use(requireAuth, requirePermission("canAddSubtitleToTranslateFromLibrary"))

  // An item counts as "matched" only when its media item is a real TheMovieDB
  // match (has a theMovieDbId). Filename-derived placeholder media items — auto
  // -created by the scanner when AI matching fails, or by the Whisper flow — have
  // no theMovieDbId and belong on the Unmatched tab, not Movies/Series.
  function isMatched(item: any): boolean {
    const mi = item.mediaItem
    return !!(mi && mi.theMovieDbId != null && String(mi.theMovieDbId).trim() !== "")
  }

  // Build the request groups for one media type using batched (non-N+1) queries.
  // Mirrors the original per-item filtering logic but runs ~5 bulk queries total
  // instead of 4+ queries per item. Unmatched items (no media item) are excluded
  // here — they go to the dedicated "unmatched" tab via buildUnmatchedGroups.
  function buildRequestGroups(
    type: "movie" | "series",
    userTargetLangIds: number[],
  ): RequestGroup[] {
    const libraryPaths = getLibraryPathsByType(db, type).filter((lp) => lp.enabled)
    if (libraryPaths.length === 0) return []

    const pathIds = libraryPaths.map((lp) => lp.id)
    const enriched = enrichItems(db, getLibraryPathItemsForPaths(db, pathIds))
    const { jobStatusBySub, whisperByItem } = loadBatchedMaps(enriched)

    const groupsMap = new Map<string, RequestGroup>()
    for (const item of enriched) {
      if (!isMatched(item)) continue // unmatched — handled by buildUnmatchedGroups
      const gi = itemToGroupItem(item, jobStatusBySub, whisperByItem, userTargetLangIds)
      if (!gi) continue
      const key = String(item.mediaItem.id)
      const existing = groupsMap.get(key)
      if (existing) {
        existing.items.push(gi)
        existing.items.sort((a, b) => {
          if (a.season != null && b.season != null) {
            if (a.season !== b.season) return a.season - b.season
            return (a.episode ?? 0) - (b.episode ?? 0)
          }
          return a.fileName.localeCompare(b.fileName)
        })
        continue
      }
      groupsMap.set(key, {
        key,
        title: item.mediaItem.title ?? item.path.split("/").pop() ?? "Untitled",
        year: item.mediaItem.year ?? null,
        genres: item.mediaItem.genres ?? null,
        posterPath: item.mediaItem.mediaItemPhotoPath ?? null,
        type,
        items: [gi],
      })
    }

    const allGroups = Array.from(groupsMap.values())
    allGroups.sort((a, b) => a.title.localeCompare(b.title))
    return allGroups
  }

  // Unmatched items (no linked media item) across every enabled library path,
  // both movies and series. Each becomes its own flat card titled by filename.
  function buildUnmatchedGroups(userTargetLangIds: number[]): RequestGroup[] {
    const paths = [
      ...getLibraryPathsByType(db, "movie"),
      ...getLibraryPathsByType(db, "series"),
    ].filter((lp) => lp.enabled)
    if (paths.length === 0) return []

    const pathIds = paths.map((lp) => lp.id)
    const enriched = enrichItems(db, getLibraryPathItemsForPaths(db, pathIds))
    const { jobStatusBySub, whisperByItem } = loadBatchedMaps(enriched)

    const groups: RequestGroup[] = []
    for (const item of enriched) {
      if (isMatched(item)) continue // matched — lives on the movie/series tab
      const gi = itemToGroupItem(item, jobStatusBySub, whisperByItem, userTargetLangIds)
      if (!gi) continue
      groups.push({
        key: `unmatched-${item.id}`,
        title: item.path.split("/").pop() ?? "Untitled",
        year: null,
        genres: null,
        posterPath: null,
        type: "unmatched",
        items: [gi],
        filePath: item.path,
      })
    }
    groups.sort((a, b) => a.title.localeCompare(b.title))
    return groups
  }

  // Batched job-lang + Whisper status maps for a set of enriched items.
  // Whisper status is keyed by the item's own libraryPathItem id (the specific
  // episode file), NOT by mediaItemId — episodes of a series share a mediaItemId
  // but a Whisper subtitle is created for only the episode that kicked off
  // transcription. Keying by libraryPathItem keeps "transcribing" from leaking
  // onto every sibling episode.
  function loadBatchedMaps(enriched: any[]) {
    const activeSubIds = enriched
      .filter((it) => it.subtitleInfo && !it.subtitleInfo.deleted)
      .map((it) => it.subtitleInfo!.subtitleId)
    const jobStatusBySub = getJobLangStatusBySubtitles(db, activeSubIds)
    const itemIds = enriched.map((it) => it.id).filter((v): v is number => v != null)
    const whisperByItem = getActiveWhisperSubtitlesByLibraryPathItems(db, itemIds)
    return { jobStatusBySub, whisperByItem }
  }

  // Shared per-item decision: returns a RequestGroupItem if the item still needs
  // work (translation / missing langs / whisper), or null if it should be hidden.
  function itemToGroupItem(
    item: any,
    jobStatusBySub: Map<number, { targetLangId: number; status: string }[]>,
    whisperByItem: Map<number, any>,
    userTargetLangIds: number[],
  ): RequestGroupItem | null {
    if (item.blacklist) return null
    const whisperStatus = whisperByItem.get(item.id)?.whisperTranscriptionStatus ?? null

    if (item.status === "not_started" || item.status === "no_srts_found") {
      return makeGroupItem(item, null, userTargetLangIds, false, whisperStatus)
    }

    if (item.subtitleInfo && !item.subtitleInfo.deleted) {
      const jobRows = jobStatusBySub.get(item.subtitleInfo.subtitleId) ?? []
      const finishedLangIds = new Set(
        jobRows.filter((j) => j.status === "completed").map((j) => j.targetLangId),
      )
      const hasActiveJobs = jobRows.some((j) => j.status === "queued" || j.status === "running")
      const missingTargetLangIds =
        userTargetLangIds.length === 0
          ? []
          : userTargetLangIds.filter((id) => !finishedLangIds.has(id))
      const allCompleted =
        userTargetLangIds.length > 0 && userTargetLangIds.every((id) => finishedLangIds.has(id))
      if (allCompleted) return null
      if (missingTargetLangIds.length === 0 && !hasActiveJobs) return null
      return makeGroupItem(
        item,
        item.subtitleInfo.subtitleId,
        missingTargetLangIds,
        hasActiveJobs,
        whisperStatus,
      )
    }
    return null
  }

  function makeGroupItem(
    item: any,
    subtitleId: number | null,
    missingTargetLangIds: number[],
    hasActiveJobs: boolean,
    whisperStatus: string | null,
  ): RequestGroupItem {
    return {
      itemId: item.id,
      season: item.season,
      episode: item.episode,
      fileName: item.path.split("/").pop() ?? "",
      libraryPathName: "",
      libraryPathId: item.libraryPathId ?? 0,
      subtitleId,
      missingTargetLangIds,
      hasActiveJobs,
      whisperStatus,
      isVideo: isVideoFile(item.path),
      hasSrt: item.status !== "no_srts_found",
    }
  }

  router.get("/", (req, res) => {
    const user = res.locals.user!
    const theme = getActiveTheme(db, user.id)
    const config = getConfig(db)
    const showPosters = !!config.showPosters && user.showPosters !== 0
    const languages = getLanguages(db)
    const langById = Object.fromEntries(
      languages.map((l) => [l.id, { id: l.id, name: l.name, iso639: l.iso639, flagCode: l.flagCode }]),
    )

    const __ = res.locals.__ as (key: string) => string
    const can = res.locals.can as (key: string) => boolean
    const i18n = {
      title: __("libraryrequests.title"),
      searchPlaceholder: __("libraryrequests.searchPlaceholder"),
      allGenres: __("libraryrequests.allGenres"),
      movies: __("libraryrequests.movies"),
      series: __("libraryrequests.series"),
      unmatched: __("libraryrequests.unmatched"),
      noMovies: __("libraryrequests.noMovies"),
      noSeries: __("libraryrequests.noSeries"),
      noUnmatched: __("libraryrequests.noUnmatched"),
      translate: __("libraryrequests.translate"),
      translateSeason: __("libraryrequests.translateSeason"),
      seasonPickTracks: __("libraryrequests.seasonPickTracks"),
      noTracksWhisper: __("libraryrequests.noTracksWhisper"),
      createSubtitle: __("libraryrequests.createSubtitle"),
      creatingSubtitle: __("libraryrequests.creatingSubtitle"),
      selectSource: __("libraryrequests.selectSource"),
      chooseSubtitleSource: __("libraryrequests.chooseSubtitleSource"),
      unknownSeason: __("libraryrequests.unknownSeason"),
      season: __("libraryrequests.season"),
      episodeCount: __("libraryrequests.episodeCount"),
      cancel: __("common.cancel"),
      loading: __("common.loading") ?? "Loading…",
      noEpisodes: __("libraryrequests.noTracksWhisper"),
      whisperStatus: {
        queued_for_transcription: __("libraryrequests.whisperStatus.queued_for_transcription"),
        transcribing: __("libraryrequests.whisperStatus.transcribing"),
        transcription_failed: __("libraryrequests.whisperStatus.transcription_failed"),
        transcription_completed: __("libraryrequests.whisperStatus.transcription_completed"),
        queued_for_translation: __("libraryrequests.whisperStatus.queued_for_translation"),
        translating: __("libraryrequests.whisperStatus.translating"),
      },
    }
    const perms = {
      canAddSubtitleToTranslateFromLibrary: can("canAddSubtitleToTranslateFromLibrary"),
      canCreateSubtitlesWithWhisper: can("canCreateSubtitlesWithWhisper"),
    }

    res.render("libraryrequests", {
      user,
      activeNav: "library-requests",
      showPosters,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
      languages,
      langById,
      i18n,
      perms,
    })
  })

  // Tab data: request groups for one media type (or the unmatched tab), built
  // with batched queries.
  router.get("/data", (req, res) => {
    const user = res.locals.user!
    const rawType = String(req.query.type || "movie")
    const userTargetLangIds = getUserConfigTranslationLanguages(db, user.id).map((tl) => tl.languageId)
    const groups =
      rawType === "unmatched"
        ? buildUnmatchedGroups(userTargetLangIds)
        : buildRequestGroups(rawType === "series" ? "series" : "movie", userTargetLangIds)

    const allGenres: string[] = []
    for (const group of groups) {
      if (group.genres) {
        group.genres.split(",").forEach((g) => {
          const trimmed = g.trim()
          if (trimmed && allGenres.indexOf(trimmed) === -1) allGenres.push(trimmed)
        })
      }
    }
    allGenres.sort()

    res.json({ groups, allGenres })
  })

  // Tab counts only — lets the page preload the badge numbers on first load
  // instead of waiting until each tab is visited. Reuses the same group builders
  // as /data (the count is "groups that still need work" after filtering), so the
  // numbers always match what a tab render would show.
  router.get("/counts", (req, res) => {
    const user = res.locals.user!
    const userTargetLangIds = getUserConfigTranslationLanguages(db, user.id).map((tl) => tl.languageId)
    res.json({
      movie: buildRequestGroups("movie", userTargetLangIds).length,
      series: buildRequestGroups("series", userTargetLangIds).length,
      unmatched: buildUnmatchedGroups(userTargetLangIds).length,
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

    // Only list sources for video files (not standalone subtitle files)
    if (isSubtitleExtension(item.path)) {
      return res.json({ success: true, sources: [], message: "Standalone subtitle — no source selection needed" })
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

      // Resolve subtitle source: standalone subtitle files are used directly;
      // video files need a companion or embedded track extracted.
      let srtSource: { path: string; isTemp: boolean } | null = null
      if (isSubtitleExtension(item.path)) {
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
