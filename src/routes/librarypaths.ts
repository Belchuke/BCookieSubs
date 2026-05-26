import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import * as fs from "fs"
import * as path from "path"
import { requireAuth } from "../middleware/auth"
import { requireAnyPermission } from "../services/permissionService"
import { getConfig } from "../repositories/configRepository"
import {
  getConfigTranslationLanguages,
  getLanguageById,
  getLanguages,
  getUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import {
  blacklistLibraryPathItem,
  createLibraryPath,
  deleteLibraryPath,
  getBlacklistedItems,
  getLibraryPathById,
  getLibraryPaths,
  getLibraryPathItemById,
  getLibraryPathItemsWithDetails,
  isLibraryPathItemBlacklisted,
  toggleLibraryPath,
  unblacklistLibraryPathItem,
  updateLibraryPath,
  updateLibraryPathItemMediaItem,
  updateLibraryPathItemStatus,
} from "../repositories/libraryPathRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { autoTranslateItem, findCompanionSrt } from "../services/libraryPathService"
import { searchMediaItemInTheMovieDb } from "../repositories/movieDbRepository"
import { createMediaItem, getMediaItemPhotoPath, updateMediaItemPhotoPath } from "../repositories/mediaRepository"

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
    const libraryPaths = getLibraryPaths(db)
    const languages = getLanguages(db)
    const theme = getActiveTheme(db, user.id)

    const enriched = libraryPaths.map((lp) => {
      const items = getLibraryPathItemsWithDetails(db, lp.id)

      const buckets = new Map<number | null, typeof items>()
      for (const item of items) {
        const key = item.mediaItemId ?? null
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key)!.push(item)
      }

      const groups = Array.from(buckets.entries()).map(([mediaItemId, grpItems]) => {
        const sorted = [...grpItems].sort((a, b) => {
          if (a.season != null && b.season != null) {
            if (a.season !== b.season) return a.season - b.season
            return (a.episode ?? 0) - (b.episode ?? 0)
          }
          return a.path.localeCompare(b.path)
        })
        return {
          mediaItemId,
          mediaItem: sorted[0]?.mediaItem ?? null,
          items: sorted,
        }
      })

      groups.sort((a, b) => {
        if (a.mediaItem && !b.mediaItem) return -1
        if (!a.mediaItem && b.mediaItem) return 1
        if (a.mediaItem && b.mediaItem) return a.mediaItem.title.localeCompare(b.mediaItem.title)
        return 0
      })

      return { ...lp, groups }
    })

    const config = getConfig(db)
    const showPosters = config.showPosters && user.showPosters !== 0
    const blacklisted = getBlacklistedItems(db)
    res.render("librarypaths", {
      user,
      activeNav: "library-paths",
      libraryPaths: enriched,
      languages,
      rootLibraryPath: config.rootLibraryPath ?? null,
      showPosters,
      blacklisted,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
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
    if (item.path.toLowerCase().endsWith(".srt")) {
      srtSource = { path: item.path, isTemp: false }
    } else {
      const sourceLang = getLanguageById(db, libraryPath.sourceLangId)
      srtSource = sourceLang
        ? findCompanionSrt(item.path, sourceLang.iso639, sourceLang.iso6392b ?? null, sourceLang.name ?? "")
        : null
    }

    if (!srtSource) return { success: false, msg: "No SRT file found next to video file" }

    const adminUser = db
      .prepare(
        `
      SELECT u.* FROM user u
      JOIN userRole ur ON ur.userId = u.id
      JOIN role r ON r.id = ur.roleId
      WHERE r.name = 'Owner' AND u.deletedAt IS NULL
      LIMIT 1
    `,
      )
      .get() as any
    if (!adminUser) return { success: false, msg: "No admin user found" }

    const config = getConfig(db)

    const userTargetLangs = getUserConfigTranslationLanguages(db, user.id)
    const targetLangIds =
      userTargetLangs.length > 0
        ? userTargetLangs.map((tl) => tl.languageId)
        : getConfigTranslationLanguages(db).map((cl) => cl.languageId)

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
      )
    } catch {
      return { success: false, msg: "Failed to queue translation" }
    }
  }

  router.post("/item/:itemId/translate", upload.none(), async (req, res) => {
    const result = await queueTranslationForItem(parseInt(String(req.params.itemId)), false, res.locals.user!)
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
    const paths = getLibraryPaths(db).map((lp) => ({ id: lp.id, state: lp.state }))
    const items = db
      .prepare(
        `
      SELECT lpi.id, lpi.status
      FROM libraryPathItem lpi
      LEFT JOIN libraryPathItemBlacklist lpb ON lpb.libraryPathItemId = lpi.id
      WHERE lpi.status != 'no_srts_found' AND lpb.id IS NULL
    `,
      )
      .all() as { id: number; status: string }[]
    res.json({ paths, items })
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
