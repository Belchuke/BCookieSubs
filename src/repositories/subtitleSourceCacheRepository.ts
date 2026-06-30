// Cache of the pre-computed subtitle source list (SubtitleSourceCandidate[] as
// JSON) for a library path item. Populated by the library scanner
// (cacheItemSubtitleSources) and by the translate-prep worker's live-fallback
// path, so the source picker reads from cache instead of probing/extracting the
// media file on every open. See src/setup.ts: libraryPathItemSubtitleSource.
//
// The sources are stored as opaque JSON here (typed `unknown` on the way back)
// so this repository has no dependency on the service-layer candidate type —
// callers cast to SubtitleSourceCandidate[].
import Database from "better-sqlite3"

export type CachedSubtitleSources = {
  sources: unknown[]
  fileMtimeMs: number
  fileSize: number
}

// Insert or replace the cached source list for an item. The PK is the item id,
// so this is an upsert. mtime/size are the staleness key the reader compares
// against the live file stat.
export function upsertItemSubtitleSources(
  db: Database.Database,
  itemId: number,
  sources: unknown[],
  fileMtimeMs: number,
  fileSize: number,
): void {
  db
    .prepare(
      `INSERT INTO libraryPathItemSubtitleSource (libraryPathItemId, sourcesJson, fileMtimeMs, fileSize, scannedAt)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(libraryPathItemId) DO UPDATE SET
         sourcesJson = excluded.sourcesJson,
         fileMtimeMs = excluded.fileMtimeMs,
         fileSize = excluded.fileSize,
         scannedAt = CURRENT_TIMESTAMP`,
    )
    .run(itemId, JSON.stringify(sources), fileMtimeMs, fileSize)
}

// Read the cached source list for an item, or null if none. The caller checks
// fileMtimeMs/fileSize against the live file stat to decide freshness.
export function getItemSubtitleSources(db: Database.Database, itemId: number): CachedSubtitleSources | null {
  const row = db
    .prepare("SELECT sourcesJson, fileMtimeMs, fileSize FROM libraryPathItemSubtitleSource WHERE libraryPathItemId = ?")
    .get(itemId) as { sourcesJson: string; fileMtimeMs: number; fileSize: number } | undefined
  if (!row) return null
  try {
    return { sources: JSON.parse(row.sourcesJson) as unknown[], fileMtimeMs: row.fileMtimeMs, fileSize: row.fileSize }
  } catch {
    return null
  }
}

// Drop the cached sources for one item (cascade delete on libraryPathItem
// already handles item removal, but this is used when invalidating explicitly).
export function deleteItemSubtitleSources(db: Database.Database, itemId: number): void {
  db.prepare("DELETE FROM libraryPathItemSubtitleSource WHERE libraryPathItemId = ?").run(itemId)
}

// Drop cached sources for every item under a library path (e.g. a forced full
// rescan that should recompute every file's sources).
export function deleteLibraryPathSubtitleSources(db: Database.Database, libraryPathId: number): void {
  db
    .prepare(
      `DELETE FROM libraryPathItemSubtitleSource
       WHERE libraryPathItemId IN (SELECT id FROM libraryPathItem WHERE libraryPathId = ?)`,
    )
    .run(libraryPathId)
}