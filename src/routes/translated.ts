import { Router } from "express"
import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import { getFinishedSubtitles } from "../repositories/subtitleRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"

export function translatedRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, requirePermission("canViewFinishedTranslatedPage"), (req, res) => {
    const subtitles = getFinishedSubtitles(db)
    const config = getConfig(db)
    const theme = getActiveTheme(db, res.locals.user!.id)

    res.render("translated", {
      user: res.locals.user,
      activeNav: "translated",
      subtitles,
      config,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  return router
}
