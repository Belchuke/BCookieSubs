import { Router, Request } from "express"
import Database from "better-sqlite3"
import { getLogsPagination, getLogTypes, getLogsForExport } from "../repositories/configRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"

// Normalize a date/datetime bound from the export modal. A bare YYYY-MM-DD is
// expanded to the full day (from → 00:00:00, to → 23:59:59) so a day picker
// yields an inclusive day range when compared against createdAt (UTC datetime).
function normalizeBound(raw: string | null | undefined, endOfDay: boolean): string | null {
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return endOfDay ? `${s} 23:59:59` : `${s} 00:00:00`
  return s
}

export function logsRouter(db: Database.Database) {
  const router = Router()

  // Read the active level/type filters from the query string, validated.
  function readFilters(req: Request): { level: string | null; type: string | null; search: string | null } {
    const level = typeof req.query.level === "string" ? req.query.level : null
    const type = typeof req.query.type === "string" ? req.query.type : null
    const validLevels = ["debug", "info", "warning", "error"]
    const rawSearch = typeof req.query.q === "string" ? req.query.q : null
    const search = rawSearch ? rawSearch.trim() : null
    return {
      level: level && validLevels.includes(level) ? level : null,
      type: type || null,
      search: search || null,
    }
  }

  router.get("/", requireAuth, requirePermission("canViewLogs"), (req, res) => {
    const user = res.locals.user!
    const { level, type, search } = readFilters(req)
    const page = Math.max(0, parseInt(String(req.query.page)) || 0)
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit)) || 30))
    const skip = page * limit
    const { logs, total, success, msg } = getLogsPagination(db, user, skip, limit, level, type, search)
    const totalPages = Math.ceil((total ?? 0) / limit)
    const theme = getActiveTheme(db, user.id)
    const { types } = getLogTypes(db, user)

    res.render("logs", {
      user,
      activeNav: "logs",
      logs: success ? logs : [],
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      error: success ? null : msg,
      level,
      type,
      search: search ?? "",
      types,
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

  // Polled row refresh. Returns the rows for the current filters/page as JSON
  // plus the distinct type list (so the dropdown can pick up new types). The
  // client swaps the row container only — filters/pagination in the DOM are
  // preserved and drive the next request.
  router.get("/poll", requireAuth, requirePermission("canViewLogs"), (req, res) => {
    const user = res.locals.user!
    const { level, type, search } = readFilters(req)
    const page = Math.max(0, parseInt(String(req.query.page)) || 0)
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit)) || 30))
    const skip = page * limit
    const { logs, total, success, msg } = getLogsPagination(db, user, skip, limit, level, type, search)
    if (!success) return res.json({ success: false, msg })
    const totalPages = Math.ceil((total ?? 0) / limit)
    const { types } = getLogTypes(db, user)
    res.json({
      success: true,
      logs: logs ?? [],
      types,
      pagination: {
        page,
        limit,
        total: total ?? 0,
        totalPages,
        hasPrev: page > 0,
        hasNext: page < totalPages - 1,
      },
    })
  })

  // Export all logs matching the current level/type filters + optional
  // timeframe, streamed as txt/json/csv.
  router.get("/export", requireAuth, requirePermission("canViewLogs"), (req, res) => {
    const user = res.locals.user!
    const { level, type, search } = readFilters(req)
    const from = normalizeBound(typeof req.query.from === "string" ? req.query.from : null, false)
    const to = normalizeBound(typeof req.query.to === "string" ? req.query.to : null, true)
    const formatRaw = typeof req.query.format === "string" ? req.query.format : "txt"
    const format = ["txt", "json", "csv"].includes(formatRaw) ? (formatRaw as "txt" | "json" | "csv") : "txt"

    const { logs } = getLogsForExport(db, user, { level, type, from, to, search })
    const rows = logs ?? []
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")
    const baseName = `logs-${stamp}`

    if (format === "json") {
      const payload = rows.map((l) => ({
        createdAt: l.createdAt,
        level: l.level,
        type: l.type,
        entityType: l.entityType,
        entityId: l.entityId,
        message: l.message,
        metadata: l.metadata ? safeParse(l.metadata) : null,
      }))
      res.setHeader("Content-Type", "application/json; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${baseName}.json"`)
      return res.send(JSON.stringify(payload, null, 2))
    }

    if (format === "csv") {
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v)
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
        return s
      }
      const header = ["createdAt", "level", "type", "entityType", "entityId", "message", "metadata"].join(",")
      const lines = rows.map((l) =>
        [l.createdAt, l.level, l.type, l.entityType, l.entityId, l.message, l.metadata].map(esc).join(","),
      )
      res.setHeader("Content-Type", "text/csv; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${baseName}.csv"`)
      return res.send([header, ...lines].join("\n"))
    }

    // txt
    const txtLines = rows.map((l) => {
      const ent = l.entityType ? ` [${l.entityType}${l.entityId ? ":" + l.entityId : ""}]` : ""
      const tp = l.type ? ` [${l.type}]` : ""
      const meta = l.metadata ? `  ${l.metadata}` : ""
      return `[${l.createdAt}] [${l.level.toUpperCase()}]${tp}${ent} ${l.message}${meta ? "\n" + meta : ""}`
    })
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}.txt"`)
    return res.send(txtLines.join("\n"))
  })

  return router
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}