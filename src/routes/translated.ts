import { Router } from "express"
import Database from "better-sqlite3"
import { getConfig } from "../repositories/configRepository"
import { getFinishedSubtitlesPage, softDeleteSubtitleJob } from "../repositories/subtitleRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"

// Translated page is server-side paginated: only the rows for the requested
// page are fetched (LIMIT/OFFSET), not the whole history, so the page stays
// cheap to load as the history grows.
const TRANSLATED_PAGE_SIZE = 30

export function translatedRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, requirePermission("canViewFinishedTranslatedPage"), (req, res) => {
    const requestedPage = Math.max(0, parseInt(String(req.query.page ?? "0"), 10) || 0)
    const { items, total, page, totalPages } = getFinishedSubtitlesPage(db, {
      page: requestedPage,
      pageSize: TRANSLATED_PAGE_SIZE,
    })
    const config = getConfig(db)
    const theme = getActiveTheme(db, res.locals.user!.id)

    res.render("translated", {
      user: res.locals.user,
      activeNav: "translated",
      subtitles: items,
      pagination: {
        page,
        limit: TRANSLATED_PAGE_SIZE,
        total,
        totalPages,
        hasPrev: page > 0,
        hasNext: page < totalPages - 1,
      },
      config,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  // Remove a single completed/failed translation from the Translated page.
  // Redirects back to the page the user was on.
  router.post("/delete/:jobId", requireAuth, requirePermission("canDeleteTranslation"), (req, res) => {
    const jobId = parseInt(String(req.params.jobId), 10)
    const result = softDeleteSubtitleJob(db, res.locals.user!, jobId)
    const page = String(req.query.page ?? "0")
    const redirectBase = "/translated?page=" + encodeURIComponent(page)
    if (!result.success) {
      return res.redirect(redirectBase + "&toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to remove"))
    }
    res.redirect(redirectBase + "&toast=success&msg=" + encodeURIComponent("Translation removed"))
  })

  return router
}
