import { Router } from "express"
import Database from "better-sqlite3"
import { getLogsPagination } from "../repositories/configRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"

export function logsRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, requirePermission("canViewLogs"), (req, res) => {
    const user = res.locals.user!
    const page = Math.max(0, parseInt(String(req.query.page)) || 0)
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit)) || 30))
    const skip = page * limit
    const { logs, total, success, msg } = getLogsPagination(db, user, skip, limit)
    const totalPages = Math.ceil((total ?? 0) / limit)
    const theme = getActiveTheme(db, user.id)

    res.render("logs", {
      user,
      activeNav: "logs",
      logs: success ? logs : [],
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      error: success ? null : msg,
      pagination: {
        page,
        limit,
        total: total ?? 0,
        totalPages,
        hasPrev: page > 0,
        hasNext: page < totalPages - 1,
      },
      theme,
    })
  })

  return router
}
