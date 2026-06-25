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

// Enabled paths that are due for a routine scan: never scanned, last scanned
// longer ago than intervalMinutes, or manually queued (lastRunAt cleared). Paths
// already scanning are excluded so an in-progress scan isn't double-started.
export const getLibraryPathsDueForScan = (db: Database.Database, intervalMinutes: number): DBLibraryPath[] => {
  return db
    .prepare(
      `SELECT * FROM libraryPath
       WHERE enabled = 1 AND state != 'scanning'
         AND (lastRunAt IS NULL OR lastRunAt < datetime('now', ?))
       ORDER BY id ASC`,
    )
    .all(`-${intervalMinutes} minutes`) as DBLibraryPath[]
}

// All library paths that have a non-null filesystem path (used to validate that
// a target file lies within a configured library before writing to disk).
export const getLibraryPathsWithFilesystemPath = (db: Database.Database): DBLibraryPath[] => {
  return db.prepare(`SELECT * FROM libraryPath WHERE path IS NOT NULL`).all() as DBLibraryPath[]
}

// Distinct media items tracked under a library path, with their video item info.
// Used by the offset page to let the user pick a media item from a library.
export type OffsetLibraryMediaRow = {
  lpiId: number
  mediaItemId: number
  videoPath: string
  season: number | null
  episode: number | null
  title: string | null
  type: string | null
  year: number | null
}

export const getLibraryMediaItemsForOffset = (
  db: Database.Database,
  libraryPathId: number,
): OffsetLibraryMediaRow[] => {
  return db
    .prepare(
      `SELECT lpi.id as lpiId, lpi.mediaItemId, lpi.path as videoPath, lpi.season, lpi.episode,
              mi.title, mi.type, mi.year
       FROM libraryPathItem lpi
       LEFT JOIN mediaItem mi ON mi.id = lpi.mediaItemId
       WHERE lpi.libraryPathId = ? AND lpi.mediaItemId IS NOT NULL
       ORDER BY mi.title ASC, lpi.id ASC`,
    )
    .all(libraryPathId) as OffsetLibraryMediaRow[]
}

// Lightweight id+status list for active (non-blacklisted) items, for polling.
export const getActiveLibraryPathItemStatuses = (
  db: Database.Database,
): { id: number; status: string }[] => {
  return db
    .prepare(
      `SELECT lpi.id, lpi.status
       FROM libraryPathItem lpi
       LEFT JOIN libraryPathItemBlacklist lpb ON lpb.libraryPathItemId = lpi.id
       WHERE lpb.id IS NULL`,
    )
    .all() as { id: number; status: string }[]
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
  const { hasPermission } = userHasPermission(db, user.id, "canAddPathForLibraryPaths")
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
  const { hasPermission } = userHasPermission(db, user.id, "canEditLibraryPath")
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
  const { hasPermission } = userHasPermission(db, user.id, "canDisableAndDeleteALibraryPath")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const lp = getLibraryPathById(db, id)
  if (!lp) return { success: false, msg: "Library path not found" }

  db.prepare(`UPDATE libraryPath SET enabled = ?, updatedAt = datetime('now') WHERE id = ?`).run(lp.enabled ? 0 : 1, id)
  return { success: true, msg: null }
}

// Reset a library path back to "idle" so the scanner worker re-runs it on its
// next tick. Primarily used to recover a path wedged in "scanning" after a
// crashed scan (the worker skips paths still marked "scanning"), but also works
// as a manual "scan now" for idle/errored paths.
export const rescanLibraryPath = (db: Database.Database, user: DBUser, id: number): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canEditLibraryPath")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const lp = getLibraryPathById(db, id)
  if (!lp) return { success: false, msg: "Library path not found" }

  const previousState = lp.state
  // Reset to idle and clear lastRunAt so the worker treats it as due on its next
  // tick (rather than waiting out the routine scan interval).
  db.prepare(`UPDATE libraryPath SET state = 'idle', lastRunAt = NULL, updatedAt = datetime('now') WHERE id = ?`).run(id)
  createLog(db, "info", "libraryPath", id, `Rescan requested for library path "${lp.name}"`, {
    name: lp.name,
    previousState,
    requestedByUserId: user.id,
    requestedByUsername: user.username,
  })
  return { success: true, msg: "Rescan scheduled — the scanner will pick it up shortly" }
}

export const deleteLibraryPath = (db: Database.Database, user: DBUser, id: number): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canDisableAndDeleteALibraryPath")
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

export const setLibraryPathItemMediaItemAndStatus = (
  db: Database.Database,
  id: number,
  mediaItemId: number,
  status: DBLibraryPathItem["status"] = "not_started",
): void => {
  db.prepare(
    `UPDATE libraryPathItem SET mediaItemId = ?, status = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(mediaItemId, status, id)
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
      `SELECT lpc.*, mi.title as mediaTitle, mi.year as mediaYear, mi.mediaItemPhotoPath as mediaPoster, mi.type as mediaType
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

// Remove a library path item from the inventory. Candidate and blacklist rows
// cascade on delete (FK ON DELETE CASCADE); subtitle.libraryPathItem is FK
// ON DELETE SET NULL, so any translation history is preserved (detached from
// the now-removed file) rather than destroyed. Used by the scanner to prune
// items whose source file has been removed from the library folder.
export const deleteLibraryPathItem = (db: Database.Database, libraryPathItemId: number): void => {
  db.prepare(`DELETE FROM libraryPathItem WHERE id = ?`).run(libraryPathItemId)
}

// All inventory items belonging to a library path (used by the scanner to
// detect items whose source file no longer exists on disk).
export const getLibraryPathItemIdsByLibraryPath = (db: Database.Database, libraryPathId: number): { id: number; path: string }[] => {
  return db
    .prepare(`SELECT id, path FROM libraryPathItem WHERE libraryPathId = ?`)
    .all(libraryPathId) as { id: number; path: string }[]
}

export const getLibraryPathsStuckInScanning = (db: Database.Database): DBLibraryPath[] => {
  return db
    .prepare(
      `SELECT * FROM libraryPath WHERE state = 'scanning' AND initialScanCompleted = 1 AND lastRunAt < datetime('now', '-10 minutes')`,
    )
    .all() as DBLibraryPath[]
}

export const setInitialScanCompleted = (db: Database.Database, id: number): void => {
  db.prepare(`UPDATE libraryPath SET initialScanCompleted = 1, updatedAt = datetime('now') WHERE id = ?`).run(id)
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

// ── Batched loaders (eliminate N+1 for large libraries) ───────────────────
// SQLite limits statements to ~999 bound parameters, so IN (...) lists are
// chunked. Returns the same row shape the per-item loaders produce, assembled
// from a handful of bulk queries regardless of item count.
const SQLITE_PARAM_CHUNK = 900

function chunkedInQuery<T>(db: Database.Database, ids: number[], sqlTemplate: (placeholders: string) => string): T[] {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += SQLITE_PARAM_CHUNK) {
    const slice = ids.slice(i, i + SQLITE_PARAM_CHUNK)
    if (slice.length === 0) continue
    const placeholders = slice.map(() => "?").join(",")
    const rows = db.prepare(sqlTemplate(placeholders)).all(...slice) as T[]
    for (const r of rows) out.push(r)
  }
  return out
}

export const getLibraryPathsByType = (db: Database.Database, type: "movie" | "series"): DBLibraryPath[] => {
  return db.prepare(`SELECT * FROM libraryPath WHERE type = ? ORDER BY name ASC`).all(type) as DBLibraryPath[]
}

export const getLibraryPathItemsForPaths = (db: Database.Database, pathIds: number[]): DBLibraryPathItem[] => {
  if (pathIds.length === 0) return []
  return chunkedInQuery<DBLibraryPathItem>(db, pathIds, (p) => `SELECT * FROM libraryPathItem WHERE libraryPathId IN (${p}) ORDER BY createdAt DESC`)
}

type CandidateRow = DBLibraryPathItemCandidate & {
  mediaTitle: string | null
  mediaYear: number | null
  mediaPoster: string | null
  mediaType: string | null
}

const getLibraryPathItemCandidatesBulk = (db: Database.Database, itemIds: number[]): CandidateRow[] => {
  if (itemIds.length === 0) return []
  return chunkedInQuery<CandidateRow>(
    db,
    itemIds,
    (p) =>
      `SELECT lpc.*, mi.title as mediaTitle, mi.year as mediaYear, mi.mediaItemPhotoPath as mediaPoster, mi.type as mediaType
        FROM libraryPathItemCandidate lpc
        LEFT JOIN mediaItem mi ON lpc.mediaItemId = mi.id
        WHERE lpc.libraryPathItemId IN (${p})
        ORDER BY lpc.createdAt ASC`,
  )
}

// Bulk subtitle info: latest subtitle per item, then active jobs for those.
const getSubtitleInfoBulk = (db: Database.Database, itemIds: number[]): Map<number, LibraryItemSubtitleInfo> => {
  const map = new Map<number, LibraryItemSubtitleInfo>()
  if (itemIds.length === 0) return map

  const subs = chunkedInQuery<{ id: number; libraryPathItem: number; deletedAt: string | null }>(
    db,
    itemIds,
    (p) => `SELECT id, libraryPathItem, deletedAt FROM subtitle WHERE libraryPathItem IN (${p})`,
  )
  // Latest subtitle per item (highest id).
  const latestByItem = new Map<number, { id: number; deletedAt: string | null }>()
  for (const s of subs) {
    const cur = latestByItem.get(s.libraryPathItem)
    if (!cur || s.id > cur.id) latestByItem.set(s.libraryPathItem, { id: s.id, deletedAt: s.deletedAt })
  }

  const activeSubIds = [...latestByItem.values()].filter((s) => !s.deletedAt).map((s) => s.id)
  const jobs = activeSubIds.length
    ? chunkedInQuery<{ subtitleId: number; jobId: number; jobStatus: string; langName: string | null; langFlag: string | null; langIso: string | null }>(
        db,
        activeSubIds,
        (p) =>
          `SELECT sj.subtitleId, sj.id AS jobId, sj.status AS jobStatus,
                  l.name AS langName, l.flag AS langFlag, l.iso639 AS langIso
           FROM subtitleJob sj
           LEFT JOIN language l ON l.id = sj.targetLangId
           WHERE sj.subtitleId IN (${p}) AND sj.deletedAt IS NULL
           ORDER BY sj.id ASC`,
      )
    : []
  const jobsBySub = new Map<number, typeof jobs>()
  for (const j of jobs) {
    const arr = jobsBySub.get(j.subtitleId)
    if (arr) arr.push(j)
    else jobsBySub.set(j.subtitleId, [j])
  }

  for (const [itemId, latest] of latestByItem) {
    if (latest.deletedAt) {
      map.set(itemId, { subtitleId: latest.id, deleted: true, activeJobs: [] })
      continue
    }
    const itemJobs = jobsBySub.get(latest.id) ?? []
    if (itemJobs.length === 0) {
      map.set(itemId, { subtitleId: latest.id, deleted: true, activeJobs: [] })
    } else {
      map.set(itemId, {
        subtitleId: latest.id,
        deleted: false,
        activeJobs: itemJobs.map((j) => ({
          jobId: j.jobId,
          langName: j.langName || "",
          langFlag: j.langFlag || null,
          langIso: j.langIso || "",
          jobStatus: j.jobStatus,
        })),
      })
    }
  }
  return map
}

const getBlacklistEntriesBulk = (db: Database.Database, itemIds: number[]): Map<number, DBLibraryPathItemBlacklist> => {
  const map = new Map<number, DBLibraryPathItemBlacklist>()
  if (itemIds.length === 0) return map
  const rows = chunkedInQuery<DBLibraryPathItemBlacklist>(
    db,
    itemIds,
    (p) => `SELECT * FROM libraryPathItemBlacklist WHERE libraryPathItemId IN (${p})`,
  )
  for (const r of rows) map.set(r.libraryPathItemId, r)
  return map
}

// Enriched item shape (same fields as getLibraryPathItemsWithDetails rows).
export type EnrichedLibraryPathItem = DBLibraryPathItem & {
  candidates: CandidateRow[]
  mediaItem: any
  subtitleInfo: LibraryItemSubtitleInfo | null
  blacklist: DBLibraryPathItemBlacklist | null
}

// Full view data for one media type: library paths with their groups/items, all
// enriched, built with ~6 bulk queries instead of N+1.
export type LibraryPathViewGroup = {
  mediaItemId: number | null
  mediaItem: any
  items: EnrichedLibraryPathItem[]
}

export type LibraryPathViewPath = DBLibraryPath & {
  sourceLangName: string | null
  groups: LibraryPathViewGroup[]
}

export const enrichItems = (db: Database.Database, items: DBLibraryPathItem[]): EnrichedLibraryPathItem[] => {
  const itemIds = items.map((i) => i.id)
  const candidatesByItem = new Map<number, CandidateRow[]>()
  for (const c of getLibraryPathItemCandidatesBulk(db, itemIds)) {
    const arr = candidatesByItem.get(c.libraryPathItemId)
    if (arr) arr.push(c)
    else candidatesByItem.set(c.libraryPathItemId, [c])
  }
  const mediaIds = [...new Set(items.map((i) => i.mediaItemId).filter((v): v is number => v != null))]
  const mediaById = new Map<number, any>()
  for (const m of chunkedInQuery<any>(db, mediaIds, (p) => `SELECT * FROM mediaItem WHERE id IN (${p})`)) {
    mediaById.set(m.id, m)
  }
  const subByItem = getSubtitleInfoBulk(db, itemIds)
  const blByItem = getBlacklistEntriesBulk(db, itemIds)

  return items.map((item) => ({
    ...item,
    candidates: candidatesByItem.get(item.id) ?? [],
    mediaItem: item.mediaItemId ? (mediaById.get(item.mediaItemId) ?? null) : null,
    subtitleInfo: subByItem.get(item.id) ?? null,
    blacklist: blByItem.get(item.id) ?? null,
  }))
}

// Group + sort enriched items exactly like the GET / route did (librarypaths.ts).
const groupItems = (items: EnrichedLibraryPathItem[]): LibraryPathViewGroup[] => {
  const buckets = new Map<number | null, EnrichedLibraryPathItem[]>()
  for (const item of items) {
    const key = item.mediaItemId ?? null
    const arr = buckets.get(key)
    if (arr) arr.push(item)
    else buckets.set(key, [item])
  }
  const groups: LibraryPathViewGroup[] = Array.from(buckets.entries()).map(([mediaItemId, grpItems]) => {
    const sorted = [...grpItems].sort((a, b) => {
      if (a.season != null && b.season != null) {
        if (a.season !== b.season) return a.season - b.season
        return (a.episode ?? 0) - (b.episode ?? 0)
      }
      return a.path.localeCompare(b.path)
    })
    return {
      mediaItemId,
      mediaItem: sorted[0]?.mediaItem ?? null,
      items: sorted,
    }
  })
  groups.sort((a, b) => {
    // Unmatched group (no mediaItem) floats to the top so it's easy to spot and
    // act on; matched groups follow, sorted alphabetically by title.
    if (!a.mediaItem && b.mediaItem) return -1
    if (a.mediaItem && !b.mediaItem) return 1
    if (a.mediaItem && b.mediaItem) return a.mediaItem.title.localeCompare(b.mediaItem.title)
    return 0
  })
  return groups
}

export const getLibraryPathsViewData = (db: Database.Database, type: "movie" | "series"): LibraryPathViewPath[] => {
  const paths = getLibraryPathsByType(db, type)
  if (paths.length === 0) return []

  const pathIds = paths.map((p) => p.id)
  const itemsByPath = new Map<number, EnrichedLibraryPathItem[]>()
  const enriched = enrichItems(db, getLibraryPathItemsForPaths(db, pathIds))
  for (const item of enriched) {
    const arr = itemsByPath.get(item.libraryPathId)
    if (arr) arr.push(item)
    else itemsByPath.set(item.libraryPathId, [item])
  }

  const langIds = [...new Set(paths.map((p) => p.sourceLangId).filter((v) => v != null))]
  const langById = new Map<number, string>()
  for (const l of chunkedInQuery<{ id: number; name: string }>(db, langIds, (p) => `SELECT id, name FROM language WHERE id IN (${p})`)) {
    langById.set(l.id, l.name)
  }

  return paths.map((lp) => ({
    ...lp,
    sourceLangName: langById.get(lp.sourceLangId) ?? null,
    groups: groupItems(itemsByPath.get(lp.id) ?? []),
  }))
}

// Type-filtered lightweight id+status list for polling (only the active tab).
export const getActiveLibraryPathItemStatusesByType = (
  db: Database.Database,
  type: "movie" | "series",
): { id: number; status: string }[] => {
  return db
    .prepare(
      `SELECT lpi.id, lpi.status
       FROM libraryPathItem lpi
       INNER JOIN libraryPath lp ON lp.id = lpi.libraryPathId
       LEFT JOIN libraryPathItemBlacklist lpb ON lpb.libraryPathItemId = lpi.id
       WHERE lp.type = ? AND lpb.id IS NULL`,
    )
    .all(type) as { id: number; status: string }[]
}

// Full enriched items by id — used to render newly-discovered items from the poll.
export const getLibraryPathItemsByIds = (db: Database.Database, ids: number[]): EnrichedLibraryPathItem[] => {
  if (ids.length === 0) return []
  const items = chunkedInQuery<DBLibraryPathItem>(db, ids, (p) => `SELECT * FROM libraryPathItem WHERE id IN (${p})`)
  return enrichItems(db, items)
}

export const isLibraryPathItemBlacklisted = (db: Database.Database, libraryPathItemId: number): boolean => {
  const row = db.prepare(`SELECT 1 FROM libraryPathItemBlacklist WHERE libraryPathItemId = ?`).get(libraryPathItemId)
  return !!row
}

export const getBlacklistEntryForItem = (
  db: Database.Database,
  libraryPathItemId: number,
): DBLibraryPathItemBlacklist | null => {
  return (
    (db.prepare(`SELECT * FROM libraryPathItemBlacklist WHERE libraryPathItemId = ?`).get(libraryPathItemId) as
      | DBLibraryPathItemBlacklist
      | undefined) ?? null
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
  const { hasPermission } = userHasPermission(db, user.id, "canBlackListALibraryPathItem")
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
  const { hasPermission } = userHasPermission(db, user.id, "canBlackListALibraryPathItem")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const item = getLibraryPathItemById(db, libraryPathItemId)
  if (!item) return { success: false, msg: "Library item not found" }

  const result = db.prepare(`DELETE FROM libraryPathItemBlacklist WHERE libraryPathItemId = ?`).run(libraryPathItemId)

  if (result.changes === 0) return { success: false, msg: "Item was not blacklisted" }

  createLog(db, "info", "libraryPath", item.libraryPathId, `Removed library item from blacklist: ${item.path}`, {
    libraryPathItemId,
    libraryPathId: item.libraryPathId,
    removedByUserId: user.id,
    removedByUsername: user.username,
  })
  return { success: true, msg: "Item removed from blacklist" }
}
