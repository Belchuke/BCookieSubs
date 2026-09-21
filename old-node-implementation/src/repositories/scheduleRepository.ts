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
    const { hasPermission: perm } = userHasPermission(db, user?.id ?? -1, "canViewSchedules")
    if (!perm) return { success: false, msg: "Permission denied", schedules: [] }
  }

  return {
    schedules: db.prepare(`SELECT * FROM schedule ORDER BY createdAt ASC`).all() as DBSchedule[],
    success: true,
    msg: null,
  }
}

// Recurrence fields shared by the global `schedule` table rows and the
// per-library-path scan-frequency settings. Extracted so the windowing math is
// single-sourced: the schedule engine and the per-path library scanner answer
// the same question ("is `now` inside this recurrence's active window?") with
// the same code.
export interface RecurrenceFields {
  repeatInterval: number
  repeatUnit: "day" | "week" | "month"
  dayOfTheWeek: number
  startTimeHour: number
  startTimeMinute: number
  durationMinutes: number
  firstStartAt: string | null
  lastRunAt: string | null
}

// Parse a stored timestamp as a Date. SQLite's datetime('now')/CURRENT_TIMESTAMP
// produce "YYYY-MM-DD HH:MM:SS" in UTC, but new Date() parses that naive
// space-separated form as LOCAL time — shifting the instant by the tz offset
// and breaking "how long ago / same UTC day" math. Coerce that form to ISO-UTC
// explicitly. Date-only ("YYYY-MM-DD") and datetime-local ("YYYY-MM-DDTHH:MM")
// forms keep their existing new Date() semantics (UTC midnight / local).
export const parseUtcDate = (value: string | null): Date | null => {
  if (!value) return null
  const sqliteUtc = /^\d{4}-\d{2}-\d{2}[ ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
  const iso = sqliteUtc ? `${value.replace(" ", "T")}Z` : value
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

const utcMidnightMs = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())

const isSameUtcDay = (a: Date, b: Date) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate()

// Pure, DB-free evaluation of a single recurrence against `now`. Returns:
//  - `active`: whether `now` is inside an active occurrence window — the day of
//    week matches, the current UTC time is within [start, start+duration), and
//    the repeat interval (from the firstStartAt anchor) lands on this
//    occurrence. This is exactly what the schedule engine needs to decide
//    "should the worker be running right now".
//  - `occurrenceStartMs`: the UTC ms of the current occurrence's start (the
//    window's left edge), or null when no occurrence is scheduled for today/
//    yesterday. Callers that want "due once per window" (the library scanner)
//    combine `active` with a `lastRunAt < occurrenceStartMs` check.
export function evaluateRecurrence(
  fields: RecurrenceFields,
  now: Date,
): { active: boolean; occurrenceStartMs: number | null } {
  const currentTotalMinutes = now.getUTCHours() * 60 + now.getUTCMinutes()

  const today = (now.getUTCDay() + 6) % 7
  const yesterday = today === 0 ? 6 : today - 1

  // A non-"day" recurrence whose weekday is "yesterday" is mid-overflow: its
  // window started yesterday and spills into today's early hours.
  const treatAsYesterday = fields.repeatUnit !== "day" && fields.dayOfTheWeek === yesterday

  // Day-of-week gate (the "day" unit runs every day).
  if (fields.repeatUnit !== "day") {
    if (fields.dayOfTheWeek !== today && fields.dayOfTheWeek !== yesterday) {
      return { active: false, occurrenceStartMs: null }
    }
  }

  const startMinutes = fields.startTimeHour * 60 + fields.startTimeMinute
  const endMinutes = startMinutes + fields.durationMinutes

  // Occurrence start as a UTC ms timestamp. For treat-as-yesterday overflow the
  // occurrence began yesterday at startTime; otherwise today at startTime.
  const target = new Date(now)
  if (treatAsYesterday) target.setUTCDate(target.getUTCDate() - 1)
  const occurrenceStartMs = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
    fields.startTimeHour,
    fields.startTimeMinute,
  )
  const occurrenceEndMs = occurrenceStartMs + fields.durationMinutes * 60_000

  // In-window check via the same UTC-minute arithmetic the schedule engine has
  // always used (so behavior is byte-for-byte identical). occurrenceStartMs is
  // returned separately so callers that need "due once per window" can compare
  // lastRunAt against the window's left edge.
  let inWindow: boolean
  if (endMinutes <= 1440) {
    if (treatAsYesterday) inWindow = false
    else inWindow = currentTotalMinutes >= startMinutes && currentTotalMinutes < endMinutes
  } else {
    const overflowEnd = endMinutes - 1440
    if (treatAsYesterday) inWindow = currentTotalMinutes < overflowEnd
    else inWindow = currentTotalMinutes >= startMinutes
  }
  void occurrenceEndMs

  if (!inWindow) return { active: false, occurrenceStartMs }

  // Repeat interval from the firstStartAt anchor. If the task already ran this
  // occurrence's UTC day, the interval is considered satisfied (so the window
  // stays "active" for its whole duration even after the first run).
  const anchor = parseUtcDate(fields.firstStartAt)
  if (!anchor) return { active: false, occurrenceStartMs }

  const lastRunAt = parseUtcDate(fields.lastRunAt)
  let intervalOk: boolean
  if (lastRunAt && isSameUtcDay(lastRunAt, target)) {
    intervalOk = true
  } else if (fields.repeatUnit === "day") {
    const diffDays = Math.floor((utcMidnightMs(target) - utcMidnightMs(anchor)) / (24 * 60 * 60 * 1000))
    intervalOk = diffDays >= 0 && diffDays % fields.repeatInterval === 0
  } else if (fields.repeatUnit === "week") {
    const diffDays = Math.floor((utcMidnightMs(target) - utcMidnightMs(anchor)) / (24 * 60 * 60 * 1000))
    const diffWeeks = Math.floor(diffDays / 7)
    intervalOk = diffWeeks >= 0 && diffWeeks % fields.repeatInterval === 0
  } else {
    // month
    const diffMonths =
      (target.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (target.getUTCMonth() - anchor.getUTCMonth())
    intervalOk = diffMonths >= 0 && diffMonths % fields.repeatInterval === 0
  }

  return { active: intervalOk, occurrenceStartMs }
}

// Convenience wrapper returning just the boolean "is the recurrence active
// now", for callers that don't need the occurrence start edge.
export const shouldRunNowByRecurrence = (fields: RecurrenceFields, now: Date): boolean =>
  evaluateRecurrence(fields, now).active

export const getShouldRunNowBySchedule = (
  db: Database.Database,
  currentScheduleId: number | null = null,
): ShouldRunResult => {
  const config = getConfig(db)

  if (!config.scheduleConfigured) {
    return { shouldRun: true, scheduleActive: false, scheduleId: null }
  }

  const now = new Date()
  const today = (now.getUTCDay() + 6) % 7
  const yesterday = today === 0 ? 6 : today - 1

  const schedules = getSchedules(db, null, true).schedules.filter((s) => !!s.enabled)

  if (schedules.length === 0) {
    return { shouldRun: true, scheduleActive: false, scheduleId: null }
  }

  const recurrenceOf = (s: DBSchedule): RecurrenceFields => ({
    repeatInterval: s.repeatInterval,
    repeatUnit: s.repeatUnit,
    dayOfTheWeek: s.dayOfTheWeek,
    startTimeHour: s.startTimeHour,
    startTimeMinute: s.startTimeMinute,
    durationMinutes: s.durationMinutes,
    firstStartAt: s.firstStartAt,
    lastRunAt: s.lastRunAt,
  })

  const touchLastRunAt = (scheduleId: number) => {
    db.prepare(`UPDATE schedule SET lastRunAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(
      scheduleId,
    )
  }

  if (currentScheduleId !== null) {
    const existing = schedules.find((s) => s.id === currentScheduleId)
    if (existing && evaluateRecurrence(recurrenceOf(existing), now).active) {
      touchLastRunAt(existing.id)
      return { shouldRun: true, scheduleActive: true, scheduleId: existing.id }
    }
  }

  const possibleSchedules = schedules.filter((s) => {
    if (s.repeatUnit === "day") return true
    return s.dayOfTheWeek === today || s.dayOfTheWeek === yesterday
  })

  for (const schedule of possibleSchedules.filter((s) => s.repeatUnit === "day")) {
    if (!evaluateRecurrence(recurrenceOf(schedule), now).active) continue
    touchLastRunAt(schedule.id)
    return { shouldRun: true, scheduleActive: true, scheduleId: schedule.id }
  }

  for (const schedule of possibleSchedules.filter((s) => s.repeatUnit !== "day" && s.dayOfTheWeek === yesterday)) {
    if (!evaluateRecurrence(recurrenceOf(schedule), now).active) continue
    touchLastRunAt(schedule.id)
    return { shouldRun: true, scheduleActive: true, scheduleId: schedule.id }
  }

  for (const schedule of possibleSchedules.filter((s) => s.repeatUnit !== "day" && s.dayOfTheWeek === today)) {
    if (!evaluateRecurrence(recurrenceOf(schedule), now).active) continue
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

  createLog(db, "info", "scheduleCreate", "schedule", null, "Created new schedule", { taskName })
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

  createLog(db, "info", "scheduleUpdate", "schedule", scheduleId, "Updated schedule", { taskName })
  return { success: true, msg: null }
}

export const deleteSchedule = (db: Database.Database, user: DBUser, scheduleId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSchedules")
  if (!perm) return { success: false, msg: "User does not have permission to manage schedules" }

  db.prepare(`DELETE FROM schedule WHERE id = ?`).run(scheduleId)
  createLog(db, "info", "scheduleDelete", "schedule", null, "Deleted schedule", { scheduleId })
  return { success: true, msg: null }
}
