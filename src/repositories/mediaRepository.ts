import Database from "better-sqlite3"
import { DBUser, DBMediaItem } from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"
import { userHasPermission } from "./userRepository"

export const getMediaItemById = (db: Database.Database, id: number): DBMediaItem | null => {
  return (db.prepare(`SELECT * FROM mediaItem WHERE id = ?`).get(id) as DBMediaItem | undefined) ?? null
}

export const getMediaItems = (db: Database.Database): DBMediaItem[] => {
  return db.prepare(`SELECT * FROM mediaItem ORDER BY title ASC`).all() as DBMediaItem[]
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

export const createMediaItem = (
  db: Database.Database,
  user: DBUser,
  title: string,
  originalTitle: string | null,
  type: "movie" | "series" | "unknown",
  year: number | null,
  isAnime: boolean,
  genres: string | null,
  theMovieDbId: string | null = null,
  posterBase64: string | null = null,
): { mediaItem: DBMediaItem | null } & DefaultResponse => {
  const permission = userHasPermission(db, user.id, "canAddSubtitles")
  if (!permission.hasPermission)
    return { mediaItem: null, success: false, msg: "User does not have permission to add subtitles" }

  const existing = getMediaItemByKeys(db, title, type, year, theMovieDbId)
  if (existing) {
    if (posterBase64 && !existing.posterBase64) {
      db.prepare(`UPDATE mediaItem SET posterBase64 = ? WHERE id = ?`).run(posterBase64, existing.id)
    }
    return { success: true, msg: "Media item already exists", mediaItem: getMediaItemById(db, existing.id) }
  }

  const result = db
    .prepare(
      `INSERT INTO mediaItem (title, originalTitle, type, year, isAnime, genres, theMovieDbId, posterBase64) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(title, originalTitle, type, year, isAnime ? 1 : 0, genres, theMovieDbId, posterBase64)

  return {
    success: true,
    msg: "Media item created successfully",
    mediaItem: getMediaItemById(db, result.lastInsertRowid as number),
  }
}
