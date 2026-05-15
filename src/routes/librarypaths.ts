import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import * as fs from "fs"
import * as path from "path"
import { requireAuth } from "../middleware/auth"
import { getConfig } from "../repositories/configRepository"
import { getLanguages } from "../repositories/languageRepository"
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

const upload = multer()

function canAccess(user: any, config: any): boolean {
  if (!config?.scanLibraryPaths) return false
  return !!(user?.isAdmin || user?.canManageLibraryPath)
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const resolved = path.resolve(candidatePath)
  const root = path.resolve(rootPath)
  return resolved === root || resolved.startsWith(root + path.sep)
}

export function libraryPathsRouter(db: Database.Database) {
  const router = Router()

    router.use(requireAuth, (req, res, next) => {
    const config = getConfig(db)
    const user = res.locals.user!
    if (!canAccess(user, config)) {
      return res.status(403).redirect("/dashboard")
    }
    next()
  })

  
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
    const theme = getActiveTheme(db)

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
    res.render("librarypaths", {
      user,
      activeNav: "library-paths",
      libraryPaths: enriched,
      languages,
      rootLibraryPath: config.rootLibraryPath ?? null,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  
  router.post("/create", upload.none(), (req, res) => {
    const { name, path: p, sourceLangId, type, enabled, autoTranslate, autoExtract } = req.body as Record<string, string>

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
    const { name, path: p, sourceLangId, type, enabled, autoTranslate, autoExtract } = req.body as Record<string, string>

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
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Invalid media item"))
    }

    const item = getLibraryPathItemById(db, itemId)
    if (!item) {
      return res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Item not found"))
    }

    updateLibraryPathItemMediaItem(db, itemId, resolvedMediaItemId)
    updateLibraryPathItemStatus(db, itemId, "not_started")

    res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent("Media match selected"))
  })

  
  async function queueTranslationForItem(
    itemId: number,
    resetStatus: boolean,
    res: any,
  ): Promise<void> {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canAddSubtitles) {
      res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Permission denied"))
      return
    }

    const item = getLibraryPathItemById(db, itemId)
    if (!item) {
      res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Item not found"))
      return
    }

    if (isLibraryPathItemBlacklisted(db, itemId)) {
      res.redirect(
        "/library-paths?toast=error&msg=" +
          encodeURIComponent("Item is blacklisted — remove it from the blacklist first"),
      )
      return
    }

    const libraryPath = getLibraryPathById(db, item.libraryPathId)
    if (!libraryPath) {
      res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Library path not found"))
      return
    }

    if (resetStatus) updateLibraryPathItemStatus(db, itemId, "not_started")

    let srtSource: { path: string; isTemp: boolean } | null = null
    if (item.path.toLowerCase().endsWith(".srt")) {
      srtSource = { path: item.path, isTemp: false }
    } else {
      const sourceLang = db.prepare(`SELECT * FROM language WHERE id = ?`).get(libraryPath.sourceLangId) as any
      srtSource = sourceLang
        ? findCompanionSrt(item.path, sourceLang.iso639, sourceLang.iso6392b ?? null, sourceLang.name ?? "")
        : null
    }

    if (!srtSource) {
      res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("No SRT file found next to video file"))
      return
    }

    const adminUser = db.prepare(`SELECT * FROM user WHERE isAdmin = 1 AND deletedAt IS NULL LIMIT 1`).get() as any
    if (!adminUser) {
      res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("No admin user found"))
      return
    }

    const config = getConfig(db)

    try {
      const result = await autoTranslateItem(
        db,
        adminUser,
        libraryPath,
        itemId,
        srtSource,
        item.mediaItemId,
        item.season,
        item.episode,
        config.defaultChunkSize,
      )
      if (!result.success) {
        res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent(result.msg))
        return
      }
      res.redirect("/library-paths?toast=success&msg=" + encodeURIComponent(result.msg))
    } catch (e) {
      res.redirect("/library-paths?toast=error&msg=" + encodeURIComponent("Failed to queue translation"))
    }
  }

  
  router.post("/item/:itemId/translate", upload.none(), async (req, res) => {
    await queueTranslationForItem(parseInt(String(req.params.itemId)), false, res)
  })

  
  router.post("/item/:itemId/readd", upload.none(), async (req, res) => {
    await queueTranslationForItem(parseInt(String(req.params.itemId)), true, res)
  })

  
  router.get("/poll", (req, res) => {
    const paths = getLibraryPaths(db).map((lp) => ({ id: lp.id, state: lp.state }))
    const items = (db.prepare(`SELECT id, status FROM libraryPathItem`).all() as { id: number; status: string }[])
    res.json({ paths, items })
  })

  
  router.get("/blacklist", (req, res) => {
    const user = res.locals.user!
    const blacklisted = getBlacklistedItems(db)
    const theme = getActiveTheme(db)
    res.render("librarypaths_blacklist", {
      user,
      activeNav: "library-paths",
      blacklisted,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  router.post("/item/:itemId/blacklist", upload.none(), (req, res) => {
    const itemId = parseInt(String(req.params.itemId))
    const reason = (req.body as { reason?: string }).reason ?? null
    const result = blacklistLibraryPathItem(db, res.locals.user!, itemId, reason)
    const redirectTo = String(req.query.from || "") === "blacklist" ? "/library-paths/blacklist" : "/library-paths"
    if (!result.success) {
      return res.redirect(redirectTo + "?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to blacklist"))
    }
    res.redirect(redirectTo + "?toast=success&msg=" + encodeURIComponent("Item blacklisted"))
  })

  router.post("/item/:itemId/unblacklist", upload.none(), (req, res) => {
    const itemId = parseInt(String(req.params.itemId))
    const result = unblacklistLibraryPathItem(db, res.locals.user!, itemId)
    const redirectTo = String(req.query.from || "") === "blacklist" ? "/library-paths/blacklist" : "/library-paths"
    if (!result.success) {
      return res.redirect(redirectTo + "?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to remove"))
    }
    res.redirect(redirectTo + "?toast=success&msg=" + encodeURIComponent("Item removed from blacklist"))
  })

  return router
}
