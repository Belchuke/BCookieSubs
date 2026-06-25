import Database from "better-sqlite3"
import { DBUser, DBConfig, DBLog } from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"

export const getConfig = (db: Database.Database): DBConfig => {
  return db.prepare(`SELECT * FROM config ORDER BY id DESC LIMIT 1`).get() as DBConfig
}

export const updateConfig = (
  db: Database.Database,
  user: DBUser,
  defaultChunkSize: number,
  maxRetriesPerChunk: number,
  showPosters: boolean,
  nameDetectionActive: boolean,
  theMovieDbActive: boolean,
  finishSingleSubtitleFirst: boolean,
  scanLibraryPaths: boolean,
  scheduleConfigured: boolean,
  clearLogs: boolean,
  clearLogsOlderThanDays: number,
  sessionTimeoutMinutes: number,
  whisperModel: string,
  whisperTimestampsLength: number,
  whisperUseCuda: boolean,
  whisperModelRootPath: string | null,
  whisperEnabled: boolean,
  whisperRunAsSeparateTask: boolean,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
  if (!perm) return { success: false, msg: "Permission denied" }

  const showPostersState = nameDetectionActive === true ? showPosters : false
  const theMovieDbActiveState = nameDetectionActive === true ? theMovieDbActive : false

  db.prepare(
    `UPDATE config SET defaultChunkSize = ?, maxRetriesPerChunk = ?, showPosters = ?, nameDetectionActive = ?, theMovieDbActive = ?, finishSingleSubtitleFirst = ?, scanLibraryPaths = ?, scheduleConfigured = ?, clearLogs = ?, clearLogsOlderThanDays = ?, sessionTimeoutMinutes = ?, whisperModel = ?, whisperTimestampsLength = ?, whisperUseCuda = ?, whisperModelRootPath = ?, whisperEnabled = ?, whisperRunAsSeparateTask = ?, updatedAt = datetime('now') WHERE id = 1`,
  ).run(
    defaultChunkSize,
    maxRetriesPerChunk,
    showPostersState ? 1 : 0,
    nameDetectionActive ? 1 : 0,
    theMovieDbActiveState ? 1 : 0,
    finishSingleSubtitleFirst ? 1 : 0,
    scanLibraryPaths ? 1 : 0,
    scheduleConfigured ? 1 : 0,
    clearLogs ? 1 : 0,
    clearLogsOlderThanDays,
    sessionTimeoutMinutes,
    whisperModel,
    whisperTimestampsLength,
    whisperUseCuda ? 1 : 0,
    whisperModelRootPath,
    whisperEnabled ? 1 : 0,
    whisperRunAsSeparateTask ? 1 : 0,
  )

  createLog(db, "info", "configUpdate", "config", null, `Updated config settings by ${user.username}`, {
    showPosters,
    nameDetectionActive,
    finishSingleSubtitleFirst,
    scanLibraryPaths,
    scheduleConfigured,
  })

  return { success: true, msg: null }
}

// Partial update: only the Whisper-related columns. Lets the Whisper settings
// form save without touching (clobbering) the rest of the configuration.
export const updateWhisperConfig = (
  db: Database.Database,
  user: DBUser,
  whisperModel: string,
  whisperTimestampsLength: number,
  whisperUseCuda: boolean,
  whisperModelRootPath: string | null,
  whisperEnabled: boolean,
  whisperRunAsSeparateTask: boolean,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
  if (!perm) return { success: false, msg: "Permission denied" }

  db.prepare(
    `UPDATE config SET whisperModel = ?, whisperTimestampsLength = ?, whisperUseCuda = ?, whisperModelRootPath = ?, whisperEnabled = ?, whisperRunAsSeparateTask = ?, updatedAt = datetime('now') WHERE id = 1`,
  ).run(
    whisperModel,
    whisperTimestampsLength,
    whisperUseCuda ? 1 : 0,
    whisperModelRootPath,
    whisperEnabled ? 1 : 0,
    whisperRunAsSeparateTask ? 1 : 0,
  )

  createLog(db, "info", "configUpdate", "config", null, `Updated Whisper settings by ${user.username}`, {
    whisperModel,
    whisperTimestampsLength,
    whisperUseCuda,
    whisperEnabled,
    whisperRunAsSeparateTask,
  })

  return { success: true, msg: null }
}

export const isSetupCompleted = (db: Database.Database): boolean => {
  const row = db.prepare(`SELECT setupCompleted FROM config WHERE id = 1`).get() as { setupCompleted: number } | undefined
  return (row?.setupCompleted ?? 0) === 1
}

export const markSetupCompleted = (db: Database.Database): void => {
  db.prepare(`UPDATE config SET setupCompleted = 1, updatedAt = datetime('now') WHERE id = 1`).run()
}

export const enableNameDetection = (db: Database.Database): void => {
  db.prepare(`UPDATE config SET nameDetectionActive = 1, updatedAt = datetime('now') WHERE id = 1`).run()
}

export const isWhisperGpuAvailable = (): boolean => {
  return process.env.WHISPER_GPU_AVAILABLE === "1" || process.env.WHISPER_GPU_AVAILABLE === "true"
}

export const updateRootLibraryPath = (
  db: Database.Database,
  user: DBUser,
  rootLibraryPath: string | null,
): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageSettings")
  if (!hasPermission) return { success: false, msg: "Permission denied" }
  db.prepare(`UPDATE config SET rootLibraryPath = ?, updatedAt = datetime('now') WHERE id = 1`).run(
    rootLibraryPath || null,
  )
  return { success: true, msg: null }
}

export const updateDefaultLanguage = (db: Database.Database, user: DBUser, language: string): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageSettings")
  if (!hasPermission) return { success: false, msg: "Permission denied" }
  db.prepare(`UPDATE config SET defaultLanguage = ?, updatedAt = datetime('now') WHERE id = 1`).run(language)
  createLog(db, "info", "languageConfig", "config", null, `Updated default language to ${language} by ${user.username}`, { language })
  return { success: true, msg: null }
}

export const getLogs = (
  db: Database.Database,
  user: DBUser,
  limit = 200,
): { logs: DBLog[] | null } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canViewLogsDashboard")
  if (!perm) return { logs: null, success: false, msg: "Permission denied" }

  const logs = db
    .prepare(`SELECT * FROM log WHERE deletedAt IS NULL ORDER BY createdAt DESC LIMIT ?`)
    .all(limit) as DBLog[]
  return { logs, success: true, msg: null }
}

const LOG_LEVELS = ["debug", "info", "warning", "error"]

// Build the WHERE clause + bind params for the log list filters. `level` is
// whitelisted against the CHECK constraint values; `type` is a free-form string
// but always bound as a parameter (never interpolated), so it is SQL-safe.
function logFilterClause(level?: string | null, type?: string | null): { clause: string; params: any[] } {
  const conds = ["deletedAt IS NULL"]
  const params: any[] = []
  if (level && LOG_LEVELS.includes(level)) {
    conds.push("level = ?")
    params.push(level)
  }
  if (type) {
    conds.push("type = ?")
    params.push(type)
  }
  return { clause: conds.join(" AND "), params }
}

export const getLogsPagination = (
  db: Database.Database,
  user: DBUser,
  skip: number,
  limit: number,
  level?: string | null,
  type?: string | null,
): { logs: DBLog[] | null; total: number } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canViewLogs")
  if (!perm) return { logs: null, success: false, msg: "Permission denied", total: 0 }

  const { clause, params } = logFilterClause(level, type)

  const logs = db
    .prepare(`SELECT * FROM log WHERE ${clause} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, skip) as DBLog[]

  const total = db.prepare(`SELECT COUNT(*) as count FROM log WHERE ${clause}`).get(...params) as { count: number }

  return { logs, total: total.count, success: true, msg: null }
}

// Distinct log `type` values currently present in the DB, for the type filter
// dropdown. Only types that actually occur are offered, so an empty log DB
// yields an empty list (no stale options).
export const getLogTypes = (db: Database.Database, user: DBUser): { types: string[] } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canViewLogs")
  if (!perm) return { types: [], success: false, msg: "Permission denied" }

  const rows = db
    .prepare(`SELECT DISTINCT type FROM log WHERE deletedAt IS NULL AND type IS NOT NULL ORDER BY type ASC`)
    .all() as { type: string }[]
  return { types: rows.map((r) => r.type), success: true, msg: null }
}

// All logs matching the filters + optional timeframe, ordered oldest-first
// (chronological) for export. No pagination — the caller streams the full set.
export const getLogsForExport = (
  db: Database.Database,
  user: DBUser,
  opts: { level?: string | null; type?: string | null; from?: string | null; to?: string | null },
): { logs: DBLog[] | null } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canViewLogs")
  if (!perm) return { logs: null, success: false, msg: "Permission denied" }

  const { clause, params } = logFilterClause(opts.level, opts.type)
  const conds = [clause]
  if (opts.from) {
    conds.push("createdAt >= ?")
    params.push(opts.from)
  }
  if (opts.to) {
    conds.push("createdAt <= ?")
    params.push(opts.to)
  }
  const where = conds.join(" AND ")

  const logs = db.prepare(`SELECT * FROM log WHERE ${where} ORDER BY createdAt ASC`).all(...params) as DBLog[]
  return { logs, success: true, msg: null }
}
