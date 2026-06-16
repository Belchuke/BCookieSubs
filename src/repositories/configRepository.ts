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
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
  if (!perm) return { success: false, msg: "Permission denied" }

  const showPostersState = nameDetectionActive === true ? showPosters : false
  const theMovieDbActiveState = nameDetectionActive === true ? theMovieDbActive : false

  db.prepare(
    `UPDATE config SET defaultChunkSize = ?, maxRetriesPerChunk = ?, showPosters = ?, nameDetectionActive = ?, theMovieDbActive = ?, finishSingleSubtitleFirst = ?, scanLibraryPaths = ?, scheduleConfigured = ?, clearLogs = ?, clearLogsOlderThanDays = ?, sessionTimeoutMinutes = ?, whisperModel = ?, whisperTimestampsLength = ?, whisperUseCuda = ?, whisperModelRootPath = ?, whisperEnabled = ?, updatedAt = datetime('now') WHERE id = 1`,
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
  )

  createLog(db, "info", "config", null, `Updated config settings by ${user.username}`, {
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
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
  if (!perm) return { success: false, msg: "Permission denied" }

  db.prepare(
    `UPDATE config SET whisperModel = ?, whisperTimestampsLength = ?, whisperUseCuda = ?, whisperModelRootPath = ?, whisperEnabled = ?, updatedAt = datetime('now') WHERE id = 1`,
  ).run(
    whisperModel,
    whisperTimestampsLength,
    whisperUseCuda ? 1 : 0,
    whisperModelRootPath,
    whisperEnabled ? 1 : 0,
  )

  createLog(db, "info", "config", null, `Updated Whisper settings by ${user.username}`, {
    whisperModel,
    whisperTimestampsLength,
    whisperUseCuda,
    whisperEnabled,
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
  createLog(db, "info", "config", null, `Updated default language to ${language} by ${user.username}`, { language })
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

export const getLogsPagination = (
  db: Database.Database,
  user: DBUser,
  skip: number,
  limit: number,
): { logs: DBLog[] | null; total: number } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canViewLogs")
  if (!perm) return { logs: null, success: false, msg: "Permission denied", total: 0 }

  const logs = db
    .prepare(`SELECT * FROM log WHERE deletedAt IS NULL ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
    .all(limit, skip) as DBLog[]

  const total = db.prepare(`SELECT COUNT(*) as count FROM log WHERE deletedAt IS NULL`).get() as { count: number }

  return { logs, total: total.count, success: true, msg: null }
}
