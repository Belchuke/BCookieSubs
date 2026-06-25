import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import * as fs from "fs"
import * as path from "path"
import { requireAuth } from "../middleware/auth"
import { requireAnyPermission, requirePermission } from "../services/permissionService"
import { getConfig } from "../repositories/configRepository"
import {
  getConfigTranslationLanguages,
  getLanguageById,
  getLanguageByIso,
  getLanguages,
  getUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import {
  blacklistLibraryPathItem,
  createLibraryPath,
  deleteLibraryPath,
  getBlacklistedItems,
  getLibraryPathById,
  getLibraryPathItemById,
  isLibraryPathItemBlacklisted,
  rescanLibraryPath,
  toggleLibraryPath,
  unblacklistLibraryPathItem,
  updateLibraryPath,
  updateLibraryPathItemMediaItem,
  updateLibraryPathItemStatus,
  getLibraryPathsViewData,
  getActiveLibraryPathItemStatusesByType,
  getLibraryPathItemsByIds,
  getLibraryPathsByType,
} from "../repositories/libraryPathRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { autoTranslateItem, findCompanionSrt } from "../services/libraryPathService"
import { isSubtitleExtension } from "../services/subtitleFormatDetector"
import { searchMediaItemInTheMovieDb } from "../repositories/movieDbRepository"
import { createMediaItem, getMediaItemPhotoPath, updateMediaItemPhotoPath } from "../repositories/mediaRepository"
import { getHighestRoleUser } from "../repositories/userRepository"

const upload = multer()

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const resolved = path.resolve(candidatePath)
  const root = path.resolve(rootPath)
  return resolved === root || resolved.startsWith(root + path.sep)
}

export function libraryPathsRouter(db: Database.Database) {
  const router = Router()

  router.use(
    requireAuth,
    requireAnyPermission([
      "canViewLibraryPathsPage",
      "canAddPathForLibraryPaths",
      "canEditLibraryPath",
      "canDisableAndDeleteALibraryPath",
      "canBlackListALibraryPathItem",
      "canChangeMatchForLibraryPaths",
      "canAddSubtitleToTranslateFromLibrary",
    ]),
  )

  router.get("/browse", (req, res) => {
    const config = getConfig(db)
    const root = config.rootLibraryPath ? path.resolve(config.rootLibraryPath) : null

    let requestedPath = String(req.query.path || root || "/")
    let resolved = path.resolve(requestedPath)

    if (root && !isPathInsideRoot(resolved, root)) resolved = root

    let entries: { name: string; fullPath: string }[] = []
    let error: string | null = null

    try {
      const dirents = fs.readdirSync(resolved, { withFileTypes: true })
      entries = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => ({ name: d.name, fullPath: path.join(resolved, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (e: any) {
      error = e.code === "ENOENT" ? "Directory not found" : e.code === "EACCES" ? "Permission denied" : String(e)
    }

    const rawParent = resolved !== path.dirname(resolved) ? path.dirname(resolved) : null
    const parent = root && rawParent && !isPathInsideRoot(rawParent, root) ? null : rawParent

    res.json({ path: resolved, parent, dirs: entries, error })
  })

  router.get("/", (req, res) => {
    const user = res.locals.user!
    const languages = getLanguages(db)
    const theme = getActiveTheme(db, user.id)
    const config = getConfig(db)
    const showPosters = config.showPosters && user.showPosters !== 0

    const __ = res.locals.__ as (key: string) => string
    const can = res.locals.can as (key: string) => boolean
    const i18n = {
      searchPlaceholder: __("libraryrequests.searchPlaceholder"),
      allGenres: __("libraryrequests.allGenres"),
      enabledBadge: __("librarypaths.enabledBadge"),
      disabledBadge: __("librarypaths.disabledBadge"),
      enable: __("librarypaths.enable"),
      disable: __("librarypaths.disable"),
      rescan: __("librarypaths.rescan"),
      edit: __("common.edit"),
      delete: __("common.delete"),
      blacklistBtn: __("librarypaths.blacklistBtn"),
      changeMatch: __("librarypaths.changeMatch"),
      removeFromBlacklist: __("librarypaths.removeFromBlacklist"),
      readd: __("librarypaths.readd"),
      translate: __("librarypaths.translate"),
      createSubtitle: __("librarypaths.createSubtitle"),
      noBlacklisted: __("librarypaths.noBlacklisted"),
      noPathsConfigured: __("librarypaths.noPathsConfigured"),
      filesystemPath: __("librarypaths.filesystemPath"),
      library: __("librarypaths.library"),
      match: __("common.match"),
      blacklistedBy: __("librarypaths.blacklistedBy"),
      when: __("common.when"),
      blacklistReason: __("librarypaths.blacklistReason"),
      actions: __("common.actions"),
    }
    const perms = {
      canEditLibraryPath: can("canEditLibraryPath"),
      canBlackListALibraryPathItem: can("canBlackListALibraryPathItem"),
      canChangeMatchForLibraryPaths: can("canChangeMatchForLibraryPaths"),
      canAddSubtitleToTranslateFromLibrary: can("canAddSubtitleToTranslateFromLibrary"),
      canCreateSubtitlesWithWhisper: can("canCreateSubtitlesWithWhisper"),
    }

    res.render("librarypaths", {
      user,
      activeNav: "library-paths",
      languages,
      rootLibraryPath: config.rootLibraryPath ?? null,
      showPosters,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
      i18n,
      perms,
    })
  })

  // Tab data: all library paths of a media type with groups/items, batched.
  router.get("/data", (req, res) => {
    const type = req.query.type === "series" ? "series" : "movie"
    res.json({ paths: getLibraryPathsViewData(db, type) })
  })

  // Blacklist tab data (rendered client-side).
  router.get("/blacklist-data", (_req, res) => {
    res.json({ blacklisted: getBlacklistedItems(db) })
  })

  // Full enriched items by id — used to render newly-discovered items from the poll.
  router.get("/items", (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n) && n > 0)
    res.json({ items: getLibraryPathItemsByIds(db, ids) })
  })

  router.post("/create", upload.none(), (req, res) => {
    const {
      name,
      path: p,
      sourceLangId,
      type,
      enabled,
      autoTranslate,
      autoExtract,
    } = req.body as Record<string, string>

    if (!["movie", "series"].includes(type)) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Type must be movie or series"))
    }

    const config = getConfig(db)
    if (config.rootLibraryPath && p && !isPathInsideRoot(p, config.rootLibraryPath)) {
      return res.redirect(
        "/library-paths?toast=error&msg=" +
          encodeURIComponent(`Path must be inside the configured root folder: ${config.rootLibraryPath}`),
      )
    }

    const result = createLibraryPath(
      db,
      res.locals.user!,
      name ?? "",
      p ?? "",
      parseInt(sourceLangId) || 0,
      type as "movie" | "series",
      enabled === "1",
      autoTranslate === "1",
      autoExtract === "1",
    )

    if (!result.success) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create"))
    }
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent("Library path created"))
  })

  router.post("/update/:id", upload.none(), (req, res) => {
    const id = parseInt(String(req.params.id))
    const {
      name,
      path: p,
      sourceLangId,
      type,
      enabled,
      autoTranslate,
      autoExtract,
    } = req.body as Record<string, string>

    if (!["movie", "series"].includes(type)) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Type must be movie or series"))
    }

    const config = getConfig(db)
    if (config.rootLibraryPath && p && !isPathInsideRoot(p, config.rootLibraryPath)) {
      return res.redirect(
        "/library-paths?toast=error&msg=" +
          encodeURIComponent(`Path must be inside the configured root folder: ${config.rootLibraryPath}`),
      )
    }

    const result = updateLibraryPath(
      db,
      res.locals.user!,
      id,
      name ?? "",
      p ?? "",
      parseInt(sourceLangId) || 0,
      type as "movie" | "series",
      enabled === "1",
      autoTranslate === "1",
      autoExtract === "1",
    )

    if (!result.success) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to update"))
    }
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent("Library path updated"))
  })

  router.post("/toggle/:id", (req, res) => {
    const result = toggleLibraryPath(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed"))
    }
    res.redirect("/library-paths")
  })

  router.post("/rescan/:id", (req, res) => {
    const result = rescanLibraryPath(db, res.locals.user!, parseInt(String(req.params.id)))
    if (req.query.json === "1") return res.json(result)
    if (!result.success) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed"))
    }
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent(result.msg ?? "Rescan scheduled"))
  })

  router.post("/delete/:id", (req, res) => {
    const result = deleteLibraryPath(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to delete"))
    }
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent("Library path deleted"))
  })

  router.post("/item/:itemId/select-candidate", upload.none(), (req, res) => {
    const itemId = parseInt(String(req.params.itemId))
    const { mediaItemId } = req.body as { mediaItemId: string }
    const resolvedMediaItemId = parseInt(mediaItemId)

    if (isNaN(resolvedMediaItemId)) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Invalid media item" })
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Invalid media item"))
    }

    const item = getLibraryPathItemById(db, itemId)
    if (!item) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Item not found" })
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Item not found"))
    }

    updateLibraryPathItemMediaItem(db, itemId, resolvedMediaItemId)
    if (item.status !== "no_srts_found") updateLibraryPathItemStatus(db, itemId, "not_started")

    if (req.query.json === "1") return res.json({ success: true, msg: "Media match selected" })
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent("Media match selected"))
  })

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

  // Bulk TMDB search (does not require a specific item; uses the type from query)
  router.get("/bulk-search-tmdb", async (req, res) => {
    const q = String(req.query.q || "").trim()
    const type: "movie" | "series" = req.query.type === "series" ? "series" : "movie"
    if (!q) return res.json({ items: [], success: true })
    try {
      const result = await searchMediaItemInTheMovieDb(db, q, type, null)
      const items = result.items.map((i) => ({ ...i, posterBase64: null }))
      return res.json({ ...result, items })
    } catch {
      return res.json({ items: [], success: false, msg: "Search failed" })
    }
  })

  // Bulk change match: applies the same TMDB selection to multiple items
  router.post(
    "/bulk-change-match",
    requireAuth,
    requirePermission("canChangeMatchForLibraryPaths"),
    upload.none(),
    async (req, res) => {
      try {
        const user = res.locals.user!
        const body = req.body as { itemIds?: string | string[]; type?: string; tmdb?: any }
        const itemIdsRaw = body.itemIds
        const itemIds: number[] = Array.isArray(itemIdsRaw)
          ? itemIdsRaw.map((s) => parseInt(String(s))).filter((n) => !isNaN(n) && n > 0)
          : String(itemIdsRaw || "")
              .split(",")
              .map((s) => parseInt(s.trim()))
              .filter((n) => !isNaN(n) && n > 0)
        if (itemIds.length === 0) return res.json({ success: false, msg: "No items selected" })
        const tmdb = body.tmdb
        if (!tmdb || !tmdb.name) return res.json({ success: false, msg: "Invalid TMDB result" })
        const mediaType: "movie" | "series" = body.type === "series" ? "series" : "movie"
        const parsedYear = parseInt(String(tmdb.year || tmdb.releaseDate || "")) || null

        const result = await createMediaItem(
          db,
          user,
          String(tmdb.name),
          tmdb.originalTitle ? String(tmdb.originalTitle) : null,
          mediaType,
          parsedYear,
          tmdb.isAnime === true || tmdb.isAnime === "1" || tmdb.isAnime === 1,
          tmdb.genres ? String(tmdb.genres) : null,
          tmdb.theMovieDbId ? String(tmdb.theMovieDbId) : null,
          tmdb.posterUrl ? String(tmdb.posterUrl) : null,
        )
        if (!result.success || !result.mediaItem) {
          return res.json({ success: false, msg: result.msg ?? "Failed to create media item" })
        }

        let updated = 0
        const skipped: number[] = []
        for (const itemId of itemIds) {
          const item = getLibraryPathItemById(db, itemId)
          if (!item) {
            skipped.push(itemId)
            continue
          }
          // Items in the same group should preserve season/episode - this is per-item, not per-group
          // Only the media item link is shared; season/episode are kept on the item row.
          updateLibraryPathItemMediaItem(db, itemId, result.mediaItem.id)
          if (item.status !== "no_srts_found") updateLibraryPathItemStatus(db, itemId, "not_started")
          updated++
        }
        return res.json({
          success: true,
          msg: `Updated ${updated} item(s)${skipped.length > 0 ? `, skipped ${skipped.length}` : ""}`,
          mediaItemId: result.mediaItem.id,
          updated,
          skipped: skipped.length,
        })
      } catch (e) {
        return res.json({ success: false, msg: (e as Error).message || "Bulk change failed" })
      }
    },
  )

  router.post("/item/:itemId/select-tmdb-result", requireAuth, upload.none(), async (req, res) => {
    const user = res.locals.user!
    const itemId = parseInt(String(req.params.itemId))
    const { title, originalTitle, year, isAnime, genres, theMovieDbId, posterUrl, type } = req.body as Record<
      string,
      string
    >

    if (!title) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Title is required" })
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Title is required"))
    }

    const item = getLibraryPathItemById(db, itemId)
    if (!item) {
      if (req.query.json === "1") return res.json({ success: false, msg: "Item not found" })
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Item not found"))
    }

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
      if (req.query.json === "1") return res.json({ success: false, msg: result.msg ?? "Failed to create media item" })
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed"))
    }

    updateLibraryPathItemMediaItem(db, itemId, result.mediaItem.id)
    if (item.status !== "no_srts_found") updateLibraryPathItemStatus(db, itemId, "not_started")

    if (req.query.json === "1")
      return res.json({ success: true, msg: "Match selected", mediaItemId: result.mediaItem.id })
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent("Match selected"))
  })

  async function queueTranslationForItem(
    itemId: number,
    resetStatus: boolean,
    user: any,
    sourceOverride?: { type: string; path: string; language: string; codec: string } | null,
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

    let srtSource: { path: string; isTemp: boolean } | null = null
    if (isSubtitleExtension(item.path)) {
      srtSource = { path: item.path, isTemp: false }
    } else if (sourceOverride && sourceOverride.path) {
      // Use the user-selected source (embedded or external)
      if (sourceOverride.type === "external" && fs.existsSync(sourceOverride.path)) {
        srtSource = { path: sourceOverride.path, isTemp: false }
      } else if (sourceOverride.type === "embedded") {
        // Re-extract from the media file (since embedded temp files are per-scan)
        const sourceLang = getLanguageById(db, libraryPath.sourceLangId)
        srtSource = sourceLang
          ? findCompanionSrt(item.path, sourceLang.iso639, sourceLang.iso6392b ?? null, sourceLang.name ?? "")
          : null
        // If language-specific track was chosen, try to find the specific track
        if (srtSource && sourceOverride.language) {
          // Use a more specific extraction if a particular language was chosen
          // (findCompanionSrt already prefers matching tracks)
        }
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

    const userTargetLangs = getUserConfigTranslationLanguages(db, user.id)
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
      )
    } catch {
      return { success: false, msg: "Failed to queue translation" }
    }
  }

  router.post("/item/:itemId/translate", upload.none(), async (req, res) => {
    const body = req.body as { sourceType?: string; sourcePath?: string; sourceLanguage?: string; sourceCodec?: string }
    const sourceOverride =
      body && body.sourcePath
        ? {
            type: body.sourceType || "",
            path: body.sourcePath || "",
            language: body.sourceLanguage || "",
            codec: body.sourceCodec || "",
          }
        : null
    const result = await queueTranslationForItem(
      parseInt(String(req.params.itemId)),
      false,
      res.locals.user!,
      sourceOverride,
      body.sourceLanguage || null,
    )
    if (req.query.json === "1") return res.json(result)
    if (!result.success) return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg))
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent(result.msg))
  })

  router.post("/item/:itemId/readd", upload.none(), async (req, res) => {
    const result = await queueTranslationForItem(parseInt(String(req.params.itemId)), true, res.locals.user!)
    if (req.query.json === "1") return res.json(result)
    if (!result.success) return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg))
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent(result.msg))
  })

  router.get("/poll", (req, res) => {
    const type = req.query.type === "series" ? "series" : "movie"
    const pathStates = getLibraryPathsByType(db, type).map((lp) => ({ id: lp.id, state: lp.state }))
    const items = getActiveLibraryPathItemStatusesByType(db, type)
    res.json({ pathStates, items })
  })

  router.get("/blacklist", (req, res) => {
    res.redirect("/library-paths?tab=blacklist")
  })

  router.post("/item/:itemId/blacklist", upload.none(), (req, res) => {
    const itemId = parseInt(String(req.params.itemId))
    const reason = (req.body as { reason?: string }).reason ?? null
    const result = blacklistLibraryPathItem(db, res.locals.user!, itemId, reason)
    if (req.query.json === "1") {
      return res.json({
        success: result.success,
        msg: result.msg ?? (result.success ? "Item blacklisted" : "Failed to blacklist"),
      })
    }
    const isBlacklistTab = String(req.query.from || "") === "blacklist"
    const redirectTo = isBlacklistTab ? "/library-paths?tab=blacklist" : "/library-paths"
    const sep = isBlacklistTab ? "&" : "?"
    if (!result.success) {
      return res.redirect(
        redirectTo + sep + "toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to blacklist"),
      )
    }
    res.redirect(redirectTo + sep + "toast=success&msg=" + encodeURIComponent("Item blacklisted"))
  })

  router.post("/item/:itemId/unblacklist", upload.none(), (req, res) => {
    const itemId = parseInt(String(req.params.itemId))
    const result = unblacklistLibraryPathItem(db, res.locals.user!, itemId)
    const isBlacklistTab = String(req.query.from || "") === "blacklist"
    const redirectTo = isBlacklistTab ? "/library-paths?tab=blacklist" : "/library-paths"
    const sep = isBlacklistTab ? "&" : "?"
    if (!result.success) {
      return res.redirect(redirectTo + sep + "toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to remove"))
    }
    res.redirect(redirectTo + sep + "toast=success&msg=" + encodeURIComponent("Item removed from blacklist"))
  })

  router.post("/group/blacklist", upload.none(), (req, res) => {
    const user = res.locals.user!
    const { itemIds, reason } = req.body as Record<string, string>
    const ids: number[] = (() => {
      try {
        const p = JSON.parse(itemIds || "[]")
        return Array.isArray(p) ? p.map(Number).filter((n) => !isNaN(n)) : []
      } catch {
        return []
      }
    })()
    if (ids.length === 0) {
      if (req.query.json === "1") return res.json({ success: false, msg: "No items specified" })
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("No items specified"))
    }
    let failed = 0
    for (const id of ids) {
      const result = blacklistLibraryPathItem(db, user, id, reason ?? null)
      if (!result.success) failed++
    }
    const successCount = ids.length - failed
    const msg =
      failed > 0
        ? `${successCount} of ${ids.length} items blacklisted (${failed} failed)`
        : `${successCount} item${successCount !== 1 ? "s" : ""} blacklisted`
    if (req.query.json === "1") return res.json({ success: true, msg, itemIds: ids })
    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent(msg))
  })

  router.post("/group/select-candidate", upload.none(), (req, res) => {
    const { itemIds, mediaItemId } = req.body as Record<string, string>
    const ids: number[] = (() => {
      try {
        return JSON.parse(itemIds || "[]")
      } catch {
        return []
      }
    })()
    const resolvedMediaItemId = parseInt(mediaItemId)
    if (isNaN(resolvedMediaItemId) || ids.length === 0) {
      return res.json({ success: false, msg: "Invalid request" })
    }
    for (const id of ids) {
      const item = getLibraryPathItemById(db, id)
      if (!item) continue
      updateLibraryPathItemMediaItem(db, id, resolvedMediaItemId)
      if (item.status !== "no_srts_found") updateLibraryPathItemStatus(db, id, "not_started")
    }
    return res.json({ success: true, msg: "Match selected" })
  })

  router.post("/group/select-tmdb-result", requireAuth, upload.none(), async (req, res) => {
    const user = res.locals.user!
    const { itemIds, title, originalTitle, year, isAnime, genres, theMovieDbId, posterUrl, type } = req.body as Record<
      string,
      string
    >
    const ids: number[] = (() => {
      try {
        return JSON.parse(itemIds || "[]")
      } catch {
        return []
      }
    })()
    if (!title || ids.length === 0) {
      return res.json({ success: false, msg: "Missing required fields" })
    }
    const parsedYear = parseInt(year) || null
    const mediaType = (type === "movie" ? "movie" : "series") as "movie" | "series"
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
    for (const id of ids) {
      const item = getLibraryPathItemById(db, id)
      if (!item) continue
      updateLibraryPathItemMediaItem(db, id, result.mediaItem.id)
      if (item.status !== "no_srts_found") updateLibraryPathItemStatus(db, id, "not_started")
    }
    return res.json({ success: true, msg: "Match selected", mediaItemId: result.mediaItem.id })
  })

  const _photoUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, path.join(process.cwd(), "mediaItemPhotos")),
      filename: (req, file, cb) => {
        const allowedExts = [".jpg", ".jpeg", ".png", ".webp"]
        const ext = allowedExts.includes(path.extname(file.originalname).toLowerCase())
          ? path.extname(file.originalname).toLowerCase()
          : ".jpg"
        cb(null, `custom-${req.params.mediaItemId}-${Date.now()}${ext}`)
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
  })

  router.post("/media-item/:mediaItemId/upload-photo", requireAuth, (req, res) => {
    _photoUpload.single("photo")(req, res, (err) => {
      if (err) return res.json({ success: false, msg: (err as Error).message || "Upload failed" })
      const mediaItemId = parseInt(String(req.params.mediaItemId))
      if (!req.file) return res.json({ success: false, msg: "No file uploaded" })
      const existingPhotoPath = getMediaItemPhotoPath(db, mediaItemId)
      if (existingPhotoPath?.startsWith("custom-")) {
        try {
          fs.unlinkSync(path.join(process.cwd(), "mediaItemPhotos", existingPhotoPath))
        } catch {}
      }
      updateMediaItemPhotoPath(db, mediaItemId, req.file.filename)
      return res.json({ success: true, msg: "Photo updated", photoPath: req.file.filename })
    })
  })

  return router
}
