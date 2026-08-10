import { Router } from "express"
import Database from "better-sqlite3"
import * as fs from "fs"
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
  getLanguageById,
  getLanguages,
  getUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { createMediaItem, getMediaItemById } from "../repositories/mediaRepository"
import { searchMediaItemInTheMovieDb } from "../repositories/movieDbRepository"
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
import { getItemSubtitleSources } from "../repositories/subtitleSourceCacheRepository"
import { getBcookieTranslatedByItemIds } from "../repositories/bcookieTranslatedRepository"
import { enqueueOcrJob } from "../repositories/ocrJobRepository"
import {
  listSubtitleSourcesForVideo,
  isVideoFile,
  type SubtitleSourceCandidate,
  type TranslateSourceOverride,
} from "../services/libraryPathService"
import { isSubtitleExtension } from "../services/subtitleFormatDetector"
import { getTranslatePrepWorkerBridge } from "../tasks/translatePrepWorkerBridge"

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
  // Extras only: a display title (filename without extension) and whether the
  // extra has an embedded subtitle track (gates the per-extra Translate button).
  title?: string
  hasEmbedded?: boolean
  // True when the item's previous subtitle was soft-deleted — the episode is
  // re-shown so it can be re-translated. The UI badges it "Deleted — re-add".
  subtitleDeleted?: boolean
  // User target languages that already have a BCookieSubs-translated subtitle
  // file on disk for this item (ordered by the user's target-lang orderNumber).
  // Drives the per-episode/per-movie "translated" language badges.
  translatedTargetLangIds?: number[]
}

type RequestGroup = {
  key: string
  title: string
  year: number | null
  genres: string | null
  posterPath: string | null
  type: "movie" | "series" | "unmatched"
  items: RequestGroupItem[]
  // Movie "extras" (Featurettes/*.mkv attached to the movie as isExtra) render
  // as sub-rows under the movie card. Each carries the same shape as a regular
  // item plus a title/hasEmbedded.
  extras?: RequestGroupItem[]
  // Full filesystem path of the file, surfaced for unmatched items so the user
  // can locate it on disk and fix/rename it (unmatched items are read-only here).
  filePath?: string | null
  // True when at least one translatable item (with a source subtitle) exists
  // and every such item has all of the user's target languages translated.
  fullyTranslated?: boolean
}

// Display name for an OCR queue entry: mediaItem title (+ S##E## for episodes),
// falling back to the file basename.
function ocrJobDisplayName(
  db: Database.Database,
  item: { path: string; mediaItemId: number | null; season: number | null; episode: number | null },
): string {
  const base =
    item.mediaItemId != null ? getMediaItemById(db, item.mediaItemId)?.title ?? path.basename(item.path) : path.basename(item.path)
  if (item.season != null && item.episode != null) {
    return `${base} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`
  }
  return base
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
    const { jobStatusBySub, whisperByItem, translatedByItem } = loadBatchedMaps(enriched)

    // Source language per library path — needed to probe embedded subtitle tracks
    // for movie extras (hasEmbedded gates the per-extra Translate button).
    const langByPathId = new Map<number, { iso639: string; iso6392b: string | null; name: string }>()
    for (const lp of libraryPaths) {
      const lang = getLanguageById(db, lp.sourceLangId)
      if (lang) langByPathId.set(lp.id, { iso639: lang.iso639, iso6392b: lang.iso6392b ?? null, name: lang.name })
    }

    // Groups are keyed by mediaItem id. A movie group is created on the first
    // regular item OR the first extra that still needs work — so a movie whose
    // own file is fully translated but has extras needing work still shows up
    // (with just the Extras sub-rows).
    const groupsMap = new Map<string, RequestGroup>()
    const ensureGroup = (item: any): RequestGroup => {
      const key = String(item.mediaItem.id)
      let g = groupsMap.get(key)
      if (!g) {
        g = {
          key,
          title: item.mediaItem.title ?? item.path.split("/").pop() ?? "Untitled",
          year: item.mediaItem.year ?? null,
          genres: item.mediaItem.genres ?? null,
          posterPath: item.mediaItem.mediaItemPhotoPath ?? null,
          type,
          items: [],
        }
        groupsMap.set(key, g)
      }
      return g
    }

    for (const item of enriched) {
      if (!isMatched(item)) continue // unmatched — handled by buildUnmatchedGroups
      const gi = itemToGroupItem(item, jobStatusBySub, whisperByItem, userTargetLangIds, type, translatedByItem)
      // Movie "extras" (Featurettes/*.mkv attached with isExtra=1) render as
      // sub-rows under the movie card instead of as regular translatable items.
      const isExtraItem = !!item.isExtra && type === "movie"
      if (!gi) continue
      if (isExtraItem) {
        const g = ensureGroup(item)
        g.extras = g.extras ?? []
        g.extras.push({
          ...gi,
          title: path.basename(item.path, path.extname(item.path)),
          hasEmbedded: extraHasEmbedded(item, langByPathId),
        })
      } else {
        const g = ensureGroup(item)
        g.items.push(gi)
        g.items.sort((a, b) => {
          if (a.season != null && b.season != null) {
            if (a.season !== b.season) return a.season - b.season
            return (a.episode ?? 0) - (b.episode ?? 0)
          }
          return a.fileName.localeCompare(b.fileName)
        })
      }
    }

    // Drop groups with nothing left to show (a fully-translated movie with no
    // extras needing work). Everything else keeps current sort behaviour.
    const allGroups: RequestGroup[] = []
    for (const g of groupsMap.values()) {
      if (g.items.length === 0 && (!g.extras || g.extras.length === 0)) continue
      // "Fully translated": at least one translatable item (one with a source
      // subtitle) exists and every translatable item carries all of the user's
      // target languages in its translatedTargetLangIds. Extras don't count.
      const translatable = g.items.filter((it) => it.subtitleId != null)
      if (
        translatable.length > 0 &&
        userTargetLangIds.length > 0 &&
        translatable.every((it) =>
          userTargetLangIds.every((id) => (it.translatedTargetLangIds ?? []).includes(id)),
        )
      ) {
        g.fullyTranslated = true
      }
      allGroups.push(g)
    }
    allGroups.sort((a, b) => a.title.localeCompare(b.title))
    return allGroups
  }

  // Gate the per-extra Translate button on whether the extra's video has an
  // embedded subtitle track (extras are embedded-only — they rarely carry a
  // sidecar .srt). Reads the scan-time source cache first so the request page
  // doesn't re-probe every extra on every load; falls back to a cheap, count-less
  // live probe only when there's no cache. Best-effort: a probe failure hides the
  // button.
  function extraHasEmbedded(
    item: any,
    langByPathId: Map<number, { iso639: string; iso6392b: string | null; name: string }>,
  ): boolean {
    const cached = getItemSubtitleSources(db, item.id)
    if (cached) {
      return cached.sources.some((s: any) => s.type === "embedded")
    }
    const lang = langByPathId.get(item.libraryPathId)
    if (!lang) return false
    try {
      const sources = listSubtitleSourcesForVideo(item.path, lang.iso639, lang.iso6392b, lang.name, {
        withPictureCounts: false,
      })
      return sources.some((s: any) => s.type === "embedded")
    } catch {
      return false
    }
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
    // Batched lookup of BCookieSubs-translated language ids per item — single
    // query for the whole tab so the per-episode/per-movie badges avoid N+1.
    const translatedByItem = getBcookieTranslatedByItemIds(db, itemIds)
    return { jobStatusBySub, whisperByItem, translatedByItem }
  }

  // Shared per-item decision: returns a RequestGroupItem if the item still needs
  // work (translation / missing langs / whisper) OR already has BCookieSubs
  // translations on disk (so it can be badged), or null if it should be hidden.
  function itemToGroupItem(
    item: any,
    jobStatusBySub: Map<number, { targetLangId: number; status: string }[]>,
    whisperByItem: Map<number, any>,
    userTargetLangIds: number[],
    type?: "movie" | "series",
    translatedByItem?: Map<number, number[]>,
  ): RequestGroupItem | null {
    if (item.blacklist) return null
    const whisperStatus = whisperByItem.get(item.id)?.whisperTranscriptionStatus ?? null
    // The user's target languages that already have a translated file on disk
    // for this item, ordered by the user's target-lang orderNumber. The scan
    // stores all detected languages; here we filter to this user's targets.
    const translatedTargetLangIds = orderTranslatedLangs(
      (translatedByItem?.get(item.id) ?? []).filter((id) => userTargetLangIds.includes(id)),
      userTargetLangIds,
    )

    if (item.status === "not_started" || item.status === "no_srts_found") {
      return makeGroupItem(item, null, userTargetLangIds, false, whisperStatus, translatedTargetLangIds)
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
      // For series episodes, keep the row listed even when this subtitle's
      // translations are all complete (or nothing is pending) so the user can
      // add a SECOND subtitle track (e.g. a Signs/Songs track alongside the
      // Dialogue track) without first deleting the existing one.
      const keepForSeries = type === "series"
      // Keep movies/unmatched that already have translated files on disk so the
      // page can badge them (a fully-translated movie is no longer hidden when
      // there's evidence of prior BCookieSubs exports next to it).
      const keepForTranslated = type !== "series" && translatedTargetLangIds.length > 0
      if (allCompleted && !keepForSeries && !keepForTranslated) return null
      if (missingTargetLangIds.length === 0 && !hasActiveJobs && !keepForSeries && !keepForTranslated)
        return null
      return makeGroupItem(
        item,
        item.subtitleInfo.subtitleId,
        missingTargetLangIds,
        hasActiveJobs,
        whisperStatus,
        translatedTargetLangIds,
      )
    }

    // A soft-deleted subtitle means the item's previous translation was removed
    // but the file is still on disk — surface it again under its season so the
    // user can re-translate (which creates a fresh subtitle; nothing blocks
    // re-creation since getSubtitleByFileHash / getActiveSubtitleForLibraryPathItem
    // ignore deletedAt rows). Flag it so the UI can badge it as "Deleted — re-add".
    if (item.subtitleInfo && item.subtitleInfo.deleted) {
      const groupItem = makeGroupItem(item, null, userTargetLangIds, false, whisperStatus, translatedTargetLangIds)
      groupItem.subtitleDeleted = true
      return groupItem
    }
    return null
  }

  // Order the translated language ids to match the user's target-lang order
  // (getUserConfigTranslationLanguages returns rows ordered by orderNumber ASC,
  // so userTargetLangIds is already in display order).
  function orderTranslatedLangs(langIds: number[], userTargetLangIds: number[]): number[] {
    return [...langIds].sort((a, b) => {
      const ia = userTargetLangIds.indexOf(a)
      const ib = userTargetLangIds.indexOf(b)
      return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib)
    })
  }

  function makeGroupItem(
    item: any,
    subtitleId: number | null,
    missingTargetLangIds: number[],
    hasActiveJobs: boolean,
    whisperStatus: string | null,
    translatedTargetLangIds: number[] = [],
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
      translatedTargetLangIds,
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
      // Change-match (unmatched items) + extras picker
      changeMatch: __("libraryrequests.changeMatch"),
      changeMatchItemHint: __("libraryrequests.changeMatchItemHint"),
      searchMatchPlaceholder: __("libraryrequests.searchMatchPlaceholder"),
      noMatchesFound: __("libraryrequests.noMatchesFound"),
      loadingMatches: __("libraryrequests.loadingMatches"),
      extras: __("libraryrequests.extras"),
      extraLabel: __("libraryrequests.extraLabel"),
      chooseTarget: __("libraryrequests.chooseTarget"),
      theMovie: __("libraryrequests.theMovie"),
      // .sub / VobSub OCR source-picker text
      imageBasedBadge: __("libraryrequests.imageBasedBadge"),
      picturesCount: __("libraryrequests.picturesCount"),
      translating: __("libraryrequests.translating"),
      deletedReadd: __("libraryrequests.deletedReadd"),
      queueSelected: __("libraryrequests.queueSelected"),
      selectedCount: __("libraryrequests.selectedCount"),
      queueSelectedNone: __("libraryrequests.queueSelectedNone"),
      unsupportedSubtitle: __("libraryrequests.unsupportedSubtitle"),
      sourceIsTargetLang: __("libraryrequests.sourceIsTargetLang"),
      unsupportedShort: __("libraryrequests.unsupportedShort"),
      microdvdFps: __("libraryrequests.microdvdFps"),
      fullyTranslated: __("libraryrequests.fullyTranslated"),
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
      canChangeMatchForLibraryPaths: can("canChangeMatchForLibraryPaths"),
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
      userTargetLangIds: getUserConfigTranslationLanguages(db, user.id).map((tl) => tl.languageId),
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
  router.get("/item/:itemId/subtitle-sources", async (req, res) => {
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

    // Read from the scan-time source cache first — the library scanner pre-computes
    // each item's subtitle sources (with picture counts) so the picker opens
    // instantly without re-probing/extracting the media file. The cache is keyed
    // by file mtime+size; if the media changed (or there's no cache yet) fall back
    // to the translate-prep worker, which recomputes and rewrites the cache.
    let sources: SubtitleSourceCandidate[]
    const cached = getItemSubtitleSources(db, itemId)
    const fresh =
      cached &&
      fs.existsSync(item.path) &&
      (() => {
        try {
          const st = fs.statSync(item.path)
          return cached.fileMtimeMs === Math.floor(st.mtimeMs) && cached.fileSize === st.size
        } catch {
          return false
        }
      })()
    if (fresh && cached) {
      sources = cached.sources as SubtitleSourceCandidate[]
    } else {
      // Computing real picture counts for embedded image tracks runs a mkvextract
      // pass + parse — offloaded to the translate-prep worker so it doesn't block
      // the event loop. The worker also upserts the cache. Falls back to a sync,
      // count-less list if the worker is unavailable.
      sources =
        (await getTranslatePrepWorkerBridge().listSubtitleSources(
          itemId,
          item.path,
          sourceLang.iso639,
          sourceLang.iso6392b ?? null,
          sourceLang.name,
        )) ??
        listSubtitleSourcesForVideo(item.path, sourceLang.iso639, sourceLang.iso6392b ?? null, sourceLang.name, {
          withPictureCounts: false,
        })
    }
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

  // Search TheMovieDB for a single library path item (used by the Change-match
  // modal on unmatched items). The media type comes from the item's library
  // path, so a movie/series unmatched file searches the right TMDB endpoint.
  router.get("/item/:itemId/search-tmdb", async (req, res) => {
    const q = String(req.query.q || "").trim()
    const itemId = parseInt(String(req.params.itemId))
    if (!q) return res.json({ items: [], success: true })

    const item = getLibraryPathItemById(db, itemId)
    if (!item) return res.json({ items: [], success: false, msg: "Item not found" })

    const libraryPath = getLibraryPathById(db, item.libraryPathId)
    const type: "movie" | "series" = libraryPath?.type === "movie" ? "movie" : "series"

    try {
      const result = await searchMediaItemInTheMovieDb(db, q, type, null)
      const items = result.items.map((i) => ({ ...i, posterBase64: null }))
      return res.json({ ...result, items })
    } catch {
      return res.json({ items: [], success: false, msg: "Search failed" })
    }
  })

  // Apply a TMDB selection to a single library path item (Change-match on an
  // unmatched item). Creates/links a real mediaItem with a theMovieDbId so the
  // item graduates from the Unmatched tab to the Movies/Series tab.
  router.post(
    "/item/:itemId/match",
    requirePermission("canChangeMatchForLibraryPaths"),
    async (req, res) => {
      const user = res.locals.user!
      const itemId = parseInt(String(req.params.itemId))
      const { title, originalTitle, year, isAnime, genres, theMovieDbId, posterUrl, type } = req.body as Record<
        string,
        string
      >

      if (!title) return res.json({ success: false, msg: "Title is required" })

      const item = getLibraryPathItemById(db, itemId)
      if (!item) return res.json({ success: false, msg: "Item not found" })

      const libraryPath = getLibraryPathById(db, item.libraryPathId)
      const mediaType = (type || (libraryPath?.type === "movie" ? "movie" : "series")) as "movie" | "series"

      const parsedYear = parseInt(year) || null
      const result = await createMediaItem(
        db,
        user,
        title,
        originalTitle || null,
        mediaType,
        parsedYear,
        isAnime === "1",
        genres || null,
        theMovieDbId || null,
        posterUrl || null,
      )

      if (!result.success || !result.mediaItem) {
        return res.json({ success: false, msg: result.msg ?? "Failed to create media item" })
      }

      updateLibraryPathItemMediaItem(db, itemId, result.mediaItem.id)
      return res.json({ success: true, msg: "Match selected", mediaItemId: result.mediaItem.id })
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

    const userTargetLangIds = getUserConfigTranslationLanguages(db, user.id).map((tl) => tl.languageId)

    let queued = 0
    let skipped = 0
    const failedMessages: string[] = []
    const batchItems: { itemId: number }[] = []

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
      batchItems.push({ itemId: item.id })
    }

    // Enqueue every chosen episode to the background OCR queue. The OCR worker
    // runs each item's source resolution (findCompanionSrt / embedded-track
    // extraction) + any PGS/VobSub OCR off-thread and creates the translation
    // jobs on success — so a season of image subtitles no longer blocks the
    // request (and the season modal). Text-source episodes pass through quickly
    // (no OCR); image-source episodes do the ~1 min Tesseract pass in the queue.
    // No sourceOverride here: each item uses its default source.
    for (const bi of batchItems) {
      const item = getLibraryPathItemById(db, bi.itemId)
      if (!item) continue
      enqueueOcrJob(db, {
        libraryPathItemId: bi.itemId,
        userId: user.id,
        name: ocrJobDisplayName(db, item),
        sourceOverride: null,
        sourceLanguageHint: null,
        resetStatus: false,
      })
      queued++
    }

    const msg = `Queued ${queued} episode(s) for OCR, skipped ${skipped} (already done)`
    if (req.query.json === "1") return res.json({ success: true, msg, queued, skipped, ocrQueued: queued, failed: failedMessages })
    res.redirect("/library-requests?toast=success&msg=" + encodeURIComponent(msg))
  })

  // Queue one or more (item, chosen source) pairs for translation. Used by the
  // source picker's "Queue selected" action so a user can add several subtitle
  // tracks for a movie/series (e.g. both the Dialogue and Signs/Songs tracks) in
  // a single request. Each item carries an optional sourceOverride identifying
  // the exact track/external file; the translate-prep worker resolves + OCRs
  // each off-thread via translateBatch (which already accepts per-item
  // sourceOverride). Mirrors the season-batch response shape.
  router.post("/items/translate-batch", async (req, res) => {
    const user = res.locals.user!
    const rawItems = (req.body as { items?: any[] }).items
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.json({ success: false, msg: "No items provided", queued: 0, failed: [] })
    }

    const batchItems: {
      itemId: number
      sourceOverride?: TranslateSourceOverride | null
      sourceLanguageHint?: string | null
    }[] = []
    const fileNameByItemId = new Map<number, string>()
    let ocrQueued = 0
    for (const it of rawItems) {
      const itemId = parseInt(String(it.itemId))
      if (isNaN(itemId) || itemId <= 0) continue
      const item = getLibraryPathItemById(db, itemId)
      if (!item) continue
      const so = it.sourceOverride
      const override = so && typeof so === "object" ? (so as TranslateSourceOverride) : null
      const sourceLanguageHint = so && typeof so === "object" && so.language ? String(so.language) : null

      // Image-based sources (PGS/VobSub) go to the background OCR queue so the
      // picker modal doesn't block on the ~1 min Tesseract pass. Text sources
      // stay synchronous — they're sub-second.
      if (override?.imageBased) {
        enqueueOcrJob(db, {
          libraryPathItemId: itemId,
          userId: user.id,
          name: ocrJobDisplayName(db, item),
          sourceOverride: override,
          sourceLanguageHint,
          resetStatus: false,
        })
        ocrQueued++
        continue
      }

      batchItems.push({ itemId, sourceOverride: override, sourceLanguageHint })
      fileNameByItemId.set(itemId, path.basename(item.path))
    }

    if (batchItems.length === 0 && ocrQueued === 0) {
      return res.json({ success: false, msg: "No valid items", queued: 0, ocrQueued: 0, failed: [] })
    }

    // Text-source items resolve synchronously (fast); OCR items were enqueued
    // above and will be processed by the OCR worker.
    let queued = 0
    const failed: string[] = []
    if (batchItems.length > 0) {
      const results = await getTranslatePrepWorkerBridge().translateBatch(batchItems, user.id)
      for (const r of results) {
        if (r.success) queued++
        else failed.push(`${fileNameByItemId.get(r.itemId) ?? `item ${r.itemId}`} (${r.msg || "?"})`)
      }
    }
    const msg =
      (queued > 0 ? `Queued ${queued}` : "") +
      (ocrQueued > 0 ? `${queued > 0 ? ", " : ""}sent ${ocrQueued} to OCR` : "") +
      (failed.length > 0 ? `, failed ${failed.length}` : "")
    return res.json({ success: failed.length === 0, msg, queued, ocrQueued, failed })
  })

  return router
}
