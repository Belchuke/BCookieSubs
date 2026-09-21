import * as fs from "fs"
import * as path from "path"
import Database from "better-sqlite3"
import { DBUser, DBMediaItem } from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"
import { userHasPermission } from "./userRepository"

export const MEDIA_PHOTOS_DIR = path.join(process.cwd(), "mediaItemPhotos")
try {
  fs.mkdirSync(MEDIA_PHOTOS_DIR, { recursive: true })
} catch {}

async function downloadPosterToFile(posterUrl: string, uniqueId: string): Promise<string | null> {
  try {
    const response = await fetch(posterUrl)
    if (!response.ok) return null
    const contentType = response.headers.get("content-type") || "image/jpeg"
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg"
    const safeId = uniqueId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120)
    const filename = `${safeId}.${ext}`
    const filePath = path.join(MEDIA_PHOTOS_DIR, filename)
    const buffer = await response.arrayBuffer()
    fs.writeFileSync(filePath, Buffer.from(buffer))
    return filename
  } catch {
    return null
  }
}

// Copy a poster image that already exists on disk (e.g. a Jellyfin/Kodi
// folder.jpg referenced by an .nfo) into the served media-photos directory so
// it can be reused instead of being re-downloaded from TheMovieDatabase. The
// NFO's poster path is an absolute path from the original media server and
// will not exist locally — callers resolve it to the actual file next to the
// NFO before passing it here.
function copyLocalPosterToFile(srcPath: string, uniqueId: string): string | null {
  try {
    if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) return null
    const ext = path.extname(srcPath).toLowerCase() || ".jpg"
    const safeId = uniqueId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120)
    const filename = `${safeId}${ext}`
    const destPath = path.join(MEDIA_PHOTOS_DIR, filename)
    fs.copyFileSync(srcPath, destPath)
    return filename
  } catch {
    return null
  }
}

export const getMediaItemPhotoPath = (db: Database.Database, id: number): string | null | undefined => {
  const row = db
    .prepare(`SELECT mediaItemPhotoPath FROM mediaItem WHERE id = ?`)
    .get(id) as { mediaItemPhotoPath: string | null } | undefined
  return row?.mediaItemPhotoPath
}

export const updateMediaItemPhotoPath = (db: Database.Database, id: number, filename: string): void => {
  db.prepare(`UPDATE mediaItem SET mediaItemPhotoPath = ? WHERE id = ?`).run(filename, id)
}

export const getMediaItemById = (db: Database.Database, id: number): DBMediaItem | null => {
  return (db.prepare(`SELECT * FROM mediaItem WHERE id = ?`).get(id) as DBMediaItem | undefined) ?? null
}

export const getMediaItems = (db: Database.Database): DBMediaItem[] => {
  return db.prepare(`SELECT * FROM mediaItem ORDER BY title ASC`).all() as DBMediaItem[]
}

export const getMediaItemByTmdbId = (
  db: Database.Database,
  tmdbId: number | string,
  type: "movie" | "series",
): DBMediaItem | null => {
  return (
    (db
      .prepare(`SELECT * FROM mediaItem WHERE theMovieDbId = ? AND type = ?`)
      .get(String(tmdbId), type) as DBMediaItem | undefined) ?? null
  )
}

export const getMediaItemByKeys = (
  db: Database.Database,
  title: string,
  type: string,
  year: number | null,
  theMovieDbId: string | null,
): DBMediaItem | null => {
  if (theMovieDbId) {
    const r = db.prepare(`SELECT * FROM mediaItem WHERE theMovieDbId = ?`).get(theMovieDbId) as DBMediaItem | undefined
    if (r) return r
  }
  return (
    (db
      .prepare(`SELECT * FROM mediaItem WHERE title = ? AND type = ? AND year IS ? ORDER BY createdAt DESC LIMIT 1`)
      .get(title, type, year) as DBMediaItem | undefined) ?? null
  )
}

export const createMediaItem = async (
  db: Database.Database,
  user: DBUser,
  title: string,
  originalTitle: string | null,
  type: "movie" | "series" | "unknown",
  year: number | null,
  isAnime: boolean,
  genres: string | null,
  theMovieDbId: string | null = null,
  posterUrl: string | null = null,
  localPosterPath: string | null = null,
): Promise<{ mediaItem: DBMediaItem | null } & DefaultResponse> => {
  const permission = userHasPermission(db, user.id, "canAddSubtitleToTranslateFromLibrary")
  if (!permission.hasPermission) return { mediaItem: null, success: false, msg: "Permission denied" }

  const existing = getMediaItemByKeys(db, title, type, year, theMovieDbId)
  if (existing) {
    // Upgrade a filename-derived placeholder (no theMovieDbId) to a real
    // TMDB-matched item when the caller supplies a theMovieDbId. Without this,
    // the Change-match "Correct Match" selection dedupes back to the existing
    // placeholder and the manual match never persists — the item stays
    // unmatched because its mediaItem still has no theMovieDbId. Upgrading in
    // place (rather than inserting a second row) also means every other item
    // already linked to this placeholder graduates to the matched tab too.
    const existingTmdb = existing.theMovieDbId ? String(existing.theMovieDbId).trim() : ""
    if (theMovieDbId && !existingTmdb) {
      db.prepare(
        `UPDATE mediaItem SET
           theMovieDbId = ?,
           originalTitle = COALESCE(NULLIF(originalTitle, ''), ?),
           year = COALESCE(year, ?),
           isAnime = ?,
           genres = COALESCE(NULLIF(genres, ''), ?)
         WHERE id = ?`,
      ).run(String(theMovieDbId), originalTitle, year, isAnime ? 1 : 0, genres, existing.id)
    }
    if (!existing.mediaItemPhotoPath) {
      const uniqueId = theMovieDbId ? `tmdb_${theMovieDbId}` : `media_${existing.id}`
      let photoPath: string | null = null
      if (localPosterPath) photoPath = copyLocalPosterToFile(localPosterPath, uniqueId)
      if (!photoPath && posterUrl) photoPath = await downloadPosterToFile(posterUrl, uniqueId)
      if (photoPath) {
        db.prepare(`UPDATE mediaItem SET mediaItemPhotoPath = ? WHERE id = ?`).run(photoPath, existing.id)
      }
    }
    return { success: true, msg: "Media item already exists", mediaItem: getMediaItemById(db, existing.id) }
  }

  let mediaItemPhotoPath: string | null = null
  const uniqueId = theMovieDbId ? `tmdb_${theMovieDbId}` : `media_${Date.now()}`
  if (localPosterPath) mediaItemPhotoPath = copyLocalPosterToFile(localPosterPath, uniqueId)
  if (!mediaItemPhotoPath && posterUrl) mediaItemPhotoPath = await downloadPosterToFile(posterUrl, uniqueId)

  const result = db
    .prepare(
      `INSERT INTO mediaItem (title, originalTitle, type, year, isAnime, genres, theMovieDbId, mediaItemPhotoPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(title, originalTitle, type, year, isAnime ? 1 : 0, genres, theMovieDbId, mediaItemPhotoPath)

  return {
    success: true,
    msg: "Media item created successfully",
    mediaItem: getMediaItemById(db, result.lastInsertRowid as number),
  }
}
