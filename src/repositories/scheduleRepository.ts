import Database from "better-sqlite3"
import { DBUser, DBSchedule } from "../types/dbTypes"
import { DefaultResponse, ShouldRunResult } from "../types/modelTypes"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"
import { getConfig } from "./configRepository"

export const getSchedules = (
  db: Database.Database,
  user: DBUser | null,
  job = false,
): { schedules: DBSchedule[] } & DefaultResponse => {
  if (!job) {
    const { hasPermission: perm } = userHasPermission(db, user?.id ?? -1, "canManageSchedules")
    if (!perm) return { success: false, msg: "User does not have permission to manage schedules", schedules: [] }
  }

  return {
    schedules: db.prepare(`SELECT * FROM schedule ORDER BY createdAt ASC`).all() as DBSchedule[],
    success: true,
    msg: null,
  }
}

export const getShouldRunNowBySchedule = (
  db: Database.Database,
  currentScheduleId: number | null = null,
): ShouldRunResult => {
  const config = getConfig(db)

  if (!config.scheduleConfigured) {
    return { shouldRun: true, scheduleActive: false, scheduleId: null }
  }

  const now = new Date()
  const currentHour = now.getUTCHours()
  const currentMinute = now.getUTCMinutes()
  const currentTotalMinutes = currentHour * 60 + currentMinute

    const today = (now.getUTCDay() + 6) % 7
  const yesterday = today === 0 ? 6 : today - 1

  const schedules = getSchedules(db, null, true).schedules.filter((s) => !!s.enabled)

  if (schedules.length === 0) {
    return { shouldRun: true, scheduleActive: false, scheduleId: null }
  }

  const parseDate = (value: string | null) => {
    if (!value) return null
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }

  const getUtcMidnightMs = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())

  const isSameUtcDay = (a: Date, b: Date) =>
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()

  const getStartMinutes = (schedule: DBSchedule) => schedule.startTimeHour * 60 + schedule.startTimeMinute

  const getTargetDate = (treatAsYesterday: boolean) => {
    const d = new Date(now)
    if (treatAsYesterday) d.setUTCDate(d.getUTCDate() - 1)
    return d
  }

  const isWithinWindow = (schedule: DBSchedule, treatAsYesterday: boolean) => {
    const startMinutes = getStartMinutes(schedule)
    const endMinutes = startMinutes + schedule.durationMinutes

    if (endMinutes <= 1440) {
      if (treatAsYesterday) return false
      return currentTotalMinutes >= startMinutes && currentTotalMinutes < endMinutes
    }

    const overflowEnd = endMinutes - 1440
    if (treatAsYesterday) return currentTotalMinutes < overflowEnd
    return currentTotalMinutes >= startMinutes
  }

  const passesRepeatInterval = (schedule: DBSchedule, treatAsYesterday: boolean) => {
    const anchor = parseDate(schedule.firstStartAt)
    if (!anchor) return false

    const targetDate = getTargetDate(treatAsYesterday)
    const lastRunAt = parseDate(schedule.lastRunAt)

    if (lastRunAt && isSameUtcDay(lastRunAt, targetDate)) return true

    if (schedule.repeatUnit === "day") {
      const diffDays = Math.floor((getUtcMidnightMs(targetDate) - getUtcMidnightMs(anchor)) / (24 * 60 * 60 * 1000))
      return diffDays >= 0 && diffDays % schedule.repeatInterval === 0
    }

    if (schedule.repeatUnit === "week") {
      const diffDays = Math.floor((getUtcMidnightMs(targetDate) - getUtcMidnightMs(anchor)) / (24 * 60 * 60 * 1000))
      const diffWeeks = Math.floor(diffDays / 7)
      return diffWeeks >= 0 && diffWeeks % schedule.repeatInterval === 0
    }

    if (schedule.repeatUnit === "month") {
      const diffMonths =
        (targetDate.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (targetDate.getUTCMonth() - anchor.getUTCMonth())
      return diffMonths >= 0 && diffMonths % schedule.repeatInterval === 0
    }

    return false
  }

  const scheduleMatchesNow = (schedule: DBSchedule) => {
    const treatAsYesterday = schedule.repeatUnit !== "day" && schedule.dayOfTheWeek === yesterday

    if (schedule.repeatUnit !== "day") {
      if (schedule.dayOfTheWeek !== today && schedule.dayOfTheWeek !== yesterday) return false
    }

    if (!isWithinWindow(schedule, treatAsYesterday)) return false
    if (!passesRepeatInterval(schedule, treatAsYesterday)) return false

    return true
  }

  const touchLastRunAt = (scheduleId: number) => {
    db.prepare(`UPDATE schedule SET lastRunAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(
      scheduleId,
    )
  }

  if (currentScheduleId !== null) {
    const existing = schedules.find((s) => s.id === currentScheduleId)
    if (existing && scheduleMatchesNow(existing)) {
      touchLastRunAt(existing.id)
      return { shouldRun: true, scheduleActive: true, scheduleId: existing.id }
    }
  }

  const possibleSchedules = schedules.filter((s) => {
    if (s.repeatUnit === "day") return true
    return s.dayOfTheWeek === today || s.dayOfTheWeek === yesterday
  })

  for (const schedule of possibleSchedules.filter((s) => s.repeatUnit === "day")) {
    if (!scheduleMatchesNow(schedule)) continue
    touchLastRunAt(schedule.id)
    return { shouldRun: true, scheduleActive: true, scheduleId: schedule.id }
  }

  for (const schedule of possibleSchedules.filter((s) => s.repeatUnit !== "day" && s.dayOfTheWeek === yesterday)) {
    if (!scheduleMatchesNow(schedule)) continue
    touchLastRunAt(schedule.id)
    return { shouldRun: true, scheduleActive: true, scheduleId: schedule.id }
  }

  for (const schedule of possibleSchedules.filter((s) => s.repeatUnit !== "day" && s.dayOfTheWeek === today)) {
    if (!scheduleMatchesNow(schedule)) continue
    touchLastRunAt(schedule.id)
    return { shouldRun: true, scheduleActive: true, scheduleId: schedule.id }
  }

  return { shouldRun: false, scheduleActive: false, scheduleId: null }
}

export const createSchedule = (
  db: Database.Database,
  user: DBUser,
  taskName: string,
  enabled: boolean,
  dayOfTheWeek: number,
  startTimeHour: number,
  startTimeMinute: number,
  durationMinutes: number,
  repeatUnit: "day" | "week" | "month",
  repeatInterval: number,
  firstStartAt: string,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSchedules")
  if (!perm) return { success: false, msg: "User does not have permission to manage schedules" }

  db.prepare(
    `INSERT INTO schedule (taskName, enabled, dayOfTheWeek, startTimeHour, startTimeMinute, durationMinutes, repeatUnit, repeatInterval, firstStartAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskName,
    enabled ? 1 : 0,
    dayOfTheWeek,
    startTimeHour,
    startTimeMinute,
    durationMinutes,
    repeatUnit,
    repeatInterval,
    firstStartAt,
  )

  createLog(db, "info", "schedule", null, "Created new schedule", { taskName })
  return { success: true, msg: null }
}

export const updateSchedule = (
  db: Database.Database,
  user: DBUser,
  scheduleId: number,
  taskName: string,
  enabled: boolean,
  dayOfTheWeek: number,
  startTimeHour: number,
  startTimeMinute: number,
  durationMinutes: number,
  repeatUnit: "day" | "week" | "month",
  repeatInterval: number,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSchedules")
  if (!perm) return { success: false, msg: "User does not have permission to manage schedules" }

  db.prepare(
    `UPDATE schedule SET taskName = ?, enabled = ?, dayOfTheWeek = ?, startTimeHour = ?, startTimeMinute = ?, durationMinutes = ?, repeatUnit = ?, repeatInterval = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(
    taskName,
    enabled ? 1 : 0,
    dayOfTheWeek,
    startTimeHour,
    startTimeMinute,
    durationMinutes,
    repeatUnit,
    repeatInterval,
    scheduleId,
  )

  createLog(db, "info", "schedule", scheduleId, "Updated schedule", { taskName })
  return { success: true, msg: null }
}

export const deleteSchedule = (db: Database.Database, user: DBUser, scheduleId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSchedules")
  if (!perm) return { success: false, msg: "User does not have permission to manage schedules" }

  db.prepare(`DELETE FROM schedule WHERE id = ?`).run(scheduleId)
  createLog(db, "info", "schedule", null, "Deleted schedule", { scheduleId })
  return { success: true, msg: null }
}
