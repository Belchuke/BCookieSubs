import Database from "better-sqlite3"
import {
  DBUser,
  DBLibraryPath,
  DBLibraryPathItem,
  DBLibraryPathItemCandidate,
  DBLibraryPathItemBlacklist,
} from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"
import { userHasPermission } from "./userRepository"
import { createLog } from "./logRepository"

export const getLibraryPaths = (db: Database.Database): DBLibraryPath[] => {
  return db.prepare(`SELECT * FROM libraryPath ORDER BY name ASC`).all() as DBLibraryPath[]
}

export const getLibraryPathById = (db: Database.Database, id: number): DBLibraryPath | null => {
  return (db.prepare(`SELECT * FROM libraryPath WHERE id = ?`).get(id) as DBLibraryPath | undefined) ?? null
}

export const getEnabledLibraryPaths = (db: Database.Database): DBLibraryPath[] => {
  return db.prepare(`SELECT * FROM libraryPath WHERE enabled = 1 ORDER BY id ASC`).all() as DBLibraryPath[]
}

export const createLibraryPath = (
  db: Database.Database,
  user: DBUser,
  name: string,
  path: string,
  sourceLangId: number,
  type: "movie" | "series",
  enabled: boolean,
  autoTranslate: boolean,
  autoExtract: boolean,
): { libraryPath: DBLibraryPath | null } & DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageLibraryPath")
  if (!hasPermission) return { libraryPath: null, success: false, msg: "Permission denied" }

  if (!name.trim()) return { libraryPath: null, success: false, msg: "Name is required" }
  if (!path.trim()) return { libraryPath: null, success: false, msg: "Path is required" }

  const langExists = db.prepare(`SELECT id FROM language WHERE id = ?`).get(sourceLangId)
  if (!langExists) return { libraryPath: null, success: false, msg: "Source language not found" }

  const existing = db.prepare(`SELECT id FROM libraryPath WHERE name = ?`).get(name.trim())
  if (existing) return { libraryPath: null, success: false, msg: "A library path with that name already exists" }

  try {
    const result = db
      .prepare(
        `INSERT INTO libraryPath (name, path, sourceLangId, type, enabled, autoTranslate, autoExtract) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name.trim(), path.trim(), sourceLangId, type, enabled ? 1 : 0, autoTranslate ? 1 : 0, autoExtract ? 1 : 0)

    const lp = getLibraryPathById(db, result.lastInsertRowid as number)
    createLog(db, "info", "libraryPath", lp?.id ?? null, "Created library path", { name, path, type })
    return { success: true, msg: null, libraryPath: lp }
  } catch (e: any) {
    if (String(e).includes("UNIQUE")) return { libraryPath: null, success: false, msg: "Path already exists" }
    throw e
  }
}

export const updateLibraryPath = (
  db: Database.Database,
  user: DBUser,
  id: number,
  name: string,
  path: string,
  sourceLangId: number,
  type: "movie" | "series",
  enabled: boolean,
  autoTranslate: boolean,
  autoExtract: boolean,
): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageLibraryPath")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  if (!name.trim()) return { success: false, msg: "Name is required" }
  if (!path.trim()) return { success: false, msg: "Path is required" }

  const langExists = db.prepare(`SELECT id FROM language WHERE id = ?`).get(sourceLangId)
  if (!langExists) return { success: false, msg: "Source language not found" }

  const dup = db.prepare(`SELECT id FROM libraryPath WHERE name = ? AND id != ?`).get(name.trim(), id)
  if (dup) return { success: false, msg: "A library path with that name already exists" }

  try {
    db.prepare(
      `UPDATE libraryPath SET name = ?, path = ?, sourceLangId = ?, type = ?, enabled = ?, autoTranslate = ?, autoExtract = ?, updatedAt = datetime('now') WHERE id = ?`,
    ).run(name.trim(), path.trim(), sourceLangId, type, enabled ? 1 : 0, autoTranslate ? 1 : 0, autoExtract ? 1 : 0, id)

    createLog(db, "info", "libraryPath", id, "Updated library path", { name, path })
    return { success: true, msg: null }
  } catch (e: any) {
    if (String(e).includes("UNIQUE")) return { success: false, msg: "Path already exists" }
    throw e
  }
}

export const toggleLibraryPath = (db: Database.Database, user: DBUser, id: number): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageLibraryPath")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const lp = getLibraryPathById(db, id)
  if (!lp) return { success: false, msg: "Library path not found" }

  db.prepare(`UPDATE libraryPath SET enabled = ?, updatedAt = datetime('now') WHERE id = ?`).run(lp.enabled ? 0 : 1, id)
  return { success: true, msg: null }
}

export const deleteLibraryPath = (db: Database.Database, user: DBUser, id: number): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageLibraryPath")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const lp = getLibraryPathById(db, id)
  if (!lp) return { success: false, msg: "Library path not found" }

  db.prepare(`DELETE FROM libraryPath WHERE id = ?`).run(id)
  createLog(db, "info", "libraryPath", id, "Deleted library path", { name: lp.name })
  return { success: true, msg: null }
}

export const setLibraryPathState = (
  db: Database.Database,
  id: number,
  state: DBLibraryPath["state"],
  updateLastRunAt = false,
): void => {
  if (updateLastRunAt) {
    db.prepare(
      `UPDATE libraryPath SET state = ?, lastRunAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?`,
    ).run(state, id)
  } else {
    db.prepare(`UPDATE libraryPath SET state = ?, updatedAt = datetime('now') WHERE id = ?`).run(state, id)
  }
}

export const getLibraryPathItems = (db: Database.Database, libraryPathId: number): DBLibraryPathItem[] => {
  return db
    .prepare(`SELECT * FROM libraryPathItem WHERE libraryPathId = ? ORDER BY createdAt DESC`)
    .all(libraryPathId) as DBLibraryPathItem[]
}

export const getLibraryPathItemById = (db: Database.Database, id: number): DBLibraryPathItem | null => {
  return (db.prepare(`SELECT * FROM libraryPathItem WHERE id = ?`).get(id) as DBLibraryPathItem | undefined) ?? null
}

export const findLibraryPathItemByExtractFileName = (
  db: Database.Database,
  libraryPathId: number,
  extractFileName: string,
): DBLibraryPathItem | null => {
  return (
    (db
      .prepare(`SELECT * FROM libraryPathItem WHERE libraryPathId = ? AND extractFileName = ?`)
      .get(libraryPathId, extractFileName) as DBLibraryPathItem | undefined) ?? null
  )
}

export const findLibraryPathItemByPath = (
  db: Database.Database,
  libraryPathId: number,
  path: string,
): DBLibraryPathItem | null => {
  return (
    (db.prepare(`SELECT * FROM libraryPathItem WHERE libraryPathId = ? AND path = ?`).get(libraryPathId, path) as
      | DBLibraryPathItem
      | undefined) ?? null
  )
}

export const createLibraryPathItem = (
  db: Database.Database,
  libraryPathId: number,
  path: string,
  extractFileName: string,
  mediaItemId: number | null,
  status: DBLibraryPathItem["status"],
  season: number | null,
  episode: number | null,
): DBLibraryPathItem | null => {
  try {
    const result = db
      .prepare(
        `INSERT INTO libraryPathItem (libraryPathId, path, extractFileName, mediaItemId, status, season, episode) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(libraryPathId, path, extractFileName, mediaItemId, status, season, episode)
    return getLibraryPathItemById(db, result.lastInsertRowid as number)
  } catch (e: any) {
    if (String(e).includes("UNIQUE")) return null
    throw e
  }
}

export const updateLibraryPathItemStatus = (
  db: Database.Database,
  id: number,
  status: DBLibraryPathItem["status"],
): void => {
  db.prepare(`UPDATE libraryPathItem SET status = ?, updatedAt = datetime('now') WHERE id = ?`).run(status, id)
}

export const updateLibraryPathItemMediaItem = (db: Database.Database, id: number, mediaItemId: number): void => {
  db.prepare(`UPDATE libraryPathItem SET mediaItemId = ?, updatedAt = datetime('now') WHERE id = ?`).run(
    mediaItemId,
    id,
  )
}

export const updateLibraryPathItemExtractFileName = (
  db: Database.Database,
  id: number,
  extractFileName: string,
): void => {
  db.prepare(`UPDATE libraryPathItem SET extractFileName = ?, updatedAt = datetime('now') WHERE id = ?`).run(
    extractFileName,
    id,
  )
}

export const getLibraryPathItemCandidates = (
  db: Database.Database,
  libraryPathItemId: number,
): (DBLibraryPathItemCandidate & {
  mediaTitle: string | null
  mediaYear: number | null
  mediaPoster: string | null
  mediaType: string | null
})[] => {
  return db
    .prepare(
      `SELECT lpc.*, mi.title as mediaTitle, mi.year as mediaYear, mi.posterBase64 as mediaPoster, mi.type as mediaType
        FROM libraryPathItemCandidate lpc
        LEFT JOIN mediaItem mi ON lpc.mediaItemId = mi.id
        WHERE lpc.libraryPathItemId = ?
        ORDER BY lpc.createdAt ASC`,
    )
    .all(libraryPathItemId) as any[]
}

export const createLibraryPathItemCandidate = (
  db: Database.Database,
  libraryPathItemId: number,
  path: string,
  mediaItemId: number,
): DBLibraryPathItemCandidate | null => {
  const existing = db
    .prepare(`SELECT id FROM libraryPathItemCandidate WHERE libraryPathItemId = ? AND mediaItemId = ?`)
    .get(libraryPathItemId, mediaItemId)
  if (existing) return null

  const result = db
    .prepare(`INSERT INTO libraryPathItemCandidate (libraryPathItemId, path, mediaItemId) VALUES (?, ?, ?)`)
    .run(libraryPathItemId, path, mediaItemId)
  return (
    (db.prepare(`SELECT * FROM libraryPathItemCandidate WHERE id = ?`).get(result.lastInsertRowid as number) as
      | DBLibraryPathItemCandidate
      | undefined) ?? null
  )
}

export const deleteLibraryPathItemCandidates = (db: Database.Database, libraryPathItemId: number): void => {
  db.prepare(`DELETE FROM libraryPathItemCandidate WHERE libraryPathItemId = ?`).run(libraryPathItemId)
}

export const getLibraryPathsStuckInScanning = (db: Database.Database): DBLibraryPath[] => {
    return db
    .prepare(`SELECT * FROM libraryPath WHERE state = 'scanning' AND lastRunAt < datetime('now', '-10 minutes')`)
    .all() as DBLibraryPath[]
}

export type LibraryItemSubtitleInfo = {
  subtitleId: number
  deleted: boolean
  activeJobs: { jobId: number; langName: string; langFlag: string | null; langIso: string; jobStatus: string }[]
}

export const getSubtitleInfoForLibraryPathItem = (
  db: Database.Database,
  itemId: number,
): LibraryItemSubtitleInfo | null => {
  const subtitle = db
    .prepare(`SELECT id, deletedAt FROM subtitle WHERE libraryPathItem = ? ORDER BY id DESC LIMIT 1`)
    .get(itemId) as { id: number; deletedAt: string | null } | undefined

  if (!subtitle) return null

  if (subtitle.deletedAt) return { subtitleId: subtitle.id, deleted: true, activeJobs: [] }

  const jobs = db
    .prepare(
      `SELECT sj.id AS jobId, sj.status AS jobStatus,
              l.name AS langName, l.flag AS langFlag, l.iso639 AS langIso
       FROM subtitleJob sj
       LEFT JOIN language l ON l.id = sj.targetLangId
       WHERE sj.subtitleId = ? AND sj.deletedAt IS NULL
       ORDER BY sj.id ASC`,
    )
    .all(subtitle.id) as any[]

  if (jobs.length === 0) return { subtitleId: subtitle.id, deleted: true, activeJobs: [] }

  return {
    subtitleId: subtitle.id,
    deleted: false,
    activeJobs: jobs.map((j) => ({
      jobId: j.jobId,
      langName: j.langName || "",
      langFlag: j.langFlag || null,
      langIso: j.langIso || "",
      jobStatus: j.jobStatus,
    })),
  }
}

export const getLibraryPathItemsWithDetails = (db: Database.Database, libraryPathId: number) => {
  const items = getLibraryPathItems(db, libraryPathId)
  return items.map((item) => {
    const candidates = getLibraryPathItemCandidates(db, item.id)
    const mediaItem = item.mediaItemId
      ? (db.prepare(`SELECT * FROM mediaItem WHERE id = ?`).get(item.mediaItemId) as any)
      : null
    const subtitleInfo = getSubtitleInfoForLibraryPathItem(db, item.id)
    const blacklist = getBlacklistEntryForItem(db, item.id)
    return { ...item, candidates, mediaItem, subtitleInfo, blacklist }
  })
}

export const isLibraryPathItemBlacklisted = (db: Database.Database, libraryPathItemId: number): boolean => {
  const row = db
    .prepare(`SELECT 1 FROM libraryPathItemBlacklist WHERE libraryPathItemId = ?`)
    .get(libraryPathItemId)
  return !!row
}

export const getBlacklistEntryForItem = (
  db: Database.Database,
  libraryPathItemId: number,
): DBLibraryPathItemBlacklist | null => {
  return (
    (db
      .prepare(`SELECT * FROM libraryPathItemBlacklist WHERE libraryPathItemId = ?`)
      .get(libraryPathItemId) as DBLibraryPathItemBlacklist | undefined) ?? null
  )
}

export type BlacklistedItemRow = DBLibraryPathItemBlacklist & {
  libraryPathId: number
  libraryPathName: string | null
  itemPath: string
  itemExtractFileName: string
  season: number | null
  episode: number | null
  blacklistedByUsername: string | null
  mediaTitle: string | null
  mediaYear: number | null
}

export const getBlacklistedItems = (db: Database.Database): BlacklistedItemRow[] => {
  return db
    .prepare(
      `SELECT
         bl.*,
         lpi.libraryPathId AS libraryPathId,
         lp.name AS libraryPathName,
         lpi.path AS itemPath,
         lpi.extractFileName AS itemExtractFileName,
         lpi.season AS season,
         lpi.episode AS episode,
         u.username AS blacklistedByUsername,
         mi.title AS mediaTitle,
         mi.year AS mediaYear
       FROM libraryPathItemBlacklist bl
       INNER JOIN libraryPathItem lpi ON lpi.id = bl.libraryPathItemId
       LEFT JOIN libraryPath lp ON lp.id = lpi.libraryPathId
       LEFT JOIN user u ON u.id = bl.blacklistedByUserId
       LEFT JOIN mediaItem mi ON mi.id = lpi.mediaItemId
       ORDER BY bl.createdAt DESC`,
    )
    .all() as BlacklistedItemRow[]
}

export const blacklistLibraryPathItem = (
  db: Database.Database,
  user: DBUser,
  libraryPathItemId: number,
  reason: string | null,
): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageLibraryPath")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const item = getLibraryPathItemById(db, libraryPathItemId)
  if (!item) return { success: false, msg: "Library item not found" }

  const trimmed = reason?.trim() || null

  const existing = getBlacklistEntryForItem(db, libraryPathItemId)
  if (existing) {
        db.prepare(
      `UPDATE libraryPathItemBlacklist
         SET reason = ?, blacklistedByUserId = ?, updatedAt = datetime('now')
       WHERE libraryPathItemId = ?`,
    ).run(trimmed, user.id, libraryPathItemId)
    return { success: true, msg: "Blacklist entry updated" }
  }

  db.prepare(
    `INSERT INTO libraryPathItemBlacklist (libraryPathItemId, blacklistedByUserId, reason) VALUES (?, ?, ?)`,
  ).run(libraryPathItemId, user.id, trimmed)

  createLog(db, "info", "libraryPath", item.libraryPathId, `Blacklisted library item from translation: ${item.path}`, {
    libraryPathItemId,
    libraryPathId: item.libraryPathId,
    blacklistedByUserId: user.id,
    blacklistedByUsername: user.username,
    reason: trimmed,
  })
  return { success: true, msg: "Item blacklisted" }
}

export const unblacklistLibraryPathItem = (
  db: Database.Database,
  user: DBUser,
  libraryPathItemId: number,
): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canManageLibraryPath")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const item = getLibraryPathItemById(db, libraryPathItemId)
  if (!item) return { success: false, msg: "Library item not found" }

  const result = db
    .prepare(`DELETE FROM libraryPathItemBlacklist WHERE libraryPathItemId = ?`)
    .run(libraryPathItemId)

  if (result.changes === 0) return { success: false, msg: "Item was not blacklisted" }

  createLog(db, "info", "libraryPath", item.libraryPathId, `Removed library item from blacklist: ${item.path}`, {
    libraryPathItemId,
    libraryPathId: item.libraryPathId,
    removedByUserId: user.id,
    removedByUsername: user.username,
  })
  return { success: true, msg: "Item removed from blacklist" }
}
