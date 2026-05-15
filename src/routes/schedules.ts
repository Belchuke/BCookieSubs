import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import { createSchedule, deleteSchedule, getSchedules, updateSchedule } from "../repositories/scheduleRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"

const upload = multer()

export function schedulesRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, (req, res) => {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canManageSchedules) {
      return res.status(403).redirect("/dashboard")
    }
    const schedules = getSchedules(db, user)
    const theme = getActiveTheme(db)

    res.render("schedules", {
      user,
      activeNav: "schedules",
      schedules: schedules.success ? schedules.schedules : [],
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  router.post("/add", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canManageSchedules) {
      return res.redirect("/schedules?toast=error&msg=" + encodeURIComponent("Permission denied"))
    }
    const {
      taskName, enabled, dayOfTheWeek, startTimeHour, startTimeMinute,
      durationMinutes, repeatUnit, repeatInterval, firstStartAt,
    } = req.body as Record<string, string>

    const result = createSchedule(
      db, user,
      taskName || "translation",
      enabled === "1",
      parseInt(dayOfTheWeek) || 0,
      parseInt(startTimeHour) || 0,
      parseInt(startTimeMinute) || 0,
      parseInt(durationMinutes) || 60,
      (repeatUnit as "day" | "week" | "month") || "week",
      parseInt(repeatInterval) || 1,
      firstStartAt || new Date().toISOString().slice(0, 10),
    )

    if (!result.success) {
      return res.redirect("/schedules?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create schedule"))
    }
    res.redirect("/schedules?toast=success&msg=" + encodeURIComponent("Schedule created"))
  })

  router.post("/update/:id", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canManageSchedules) {
      return res.redirect("/schedules?toast=error&msg=" + encodeURIComponent("Permission denied"))
    }
    const {
      taskName, enabled, dayOfTheWeek, startTimeHour, startTimeMinute,
      durationMinutes, repeatUnit, repeatInterval,
    } = req.body as Record<string, string>

    const result = updateSchedule(
      db, user,
      parseInt(String(req.params.id)),
      taskName || "translation",
      enabled === "1",
      parseInt(dayOfTheWeek) || 0,
      parseInt(startTimeHour) || 0,
      parseInt(startTimeMinute) || 0,
      parseInt(durationMinutes) || 60,
      (repeatUnit as "day" | "week" | "month") || "week",
      parseInt(repeatInterval) || 1,
    )

    if (!result.success) {
      return res.redirect("/schedules?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to update schedule"))
    }
    res.redirect("/schedules?toast=success&msg=" + encodeURIComponent("Schedule updated"))
  })

  router.post("/delete/:id", requireAuth, (req, res) => {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canManageSchedules) {
      return res.redirect("/schedules?toast=error&msg=" + encodeURIComponent("Permission denied"))
    }
    const result = deleteSchedule(db, user, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/schedules?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to delete schedule"))
    }
    res.redirect("/schedules?toast=success&msg=" + encodeURIComponent("Schedule deleted"))
  })

  return router
}
