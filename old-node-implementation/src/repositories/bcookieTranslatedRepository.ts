// Repository for the `bcookietranslated` table: a per-(library path item, language)
// record that a BCookieSubs-translated subtitle file exists on disk next to the
// media. Populated/reconciled during the library scan by reading companion
// .srt/.ass/.ssa files whose content contains CREDIT_TEXT ("Translated by
// BCookieSubs"). The Library Requests page uses it to show per-episode/per-movie
// "translated" language badges and the series-level "Fully translated" badge.
//
// Cascade on libraryPathItem delete (FK) clears rows when a video is pruned; the
// scan-time reconcile here handles the file-deleted-but-video-remains case.
import Database from "better-sqlite3"

export type BcookieTranslatedRow = {
  languageId: number
  detectedAtPath: string
  fileMtimeMs: number | null
}

// All rows currently recorded for an item. Used by the scan reconcile both as a
// mtime cache (skip re-reading unchanged files) and to know which rows to drop.
export const getBcookieTranslatedRowsForItem = (
  db: Database.Database,
  itemId: number,
): BcookieTranslatedRow[] => {
  return db
    .prepare(`SELECT languageId, detectedAtPath, fileMtimeMs FROM bcookietranslated WHERE libraryPathItemId = ?`)
    .all(itemId) as BcookieTranslatedRow[]
}

// Atomically replace the per-item rows with the given set (delete-all-then-insert
// in one transaction). Per-item row counts are tiny, so this is simple and correct
// — it naturally drops rows for files that are gone, lost their marker, or whose
// language code changed, and inserts new ones.
export const replaceBcookieTranslatedForItem = (
  db: Database.Database,
  itemId: number,
  rows: BcookieTranslatedRow[],
): void => {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM bcookietranslated WHERE libraryPathItemId = ?`).run(itemId)
    if (rows.length === 0) return
    const stmt = db.prepare(
      `INSERT INTO bcookietranslated (libraryPathItemId, languageId, detectedAtPath, fileMtimeMs, updatedAt)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    for (const r of rows) {
      stmt.run(itemId, r.languageId, r.detectedAtPath, r.fileMtimeMs)
    }
  })
  tx()
}

// Batched lookup: language ids recorded as translated for each of the given item
// ids, returned as a Map keyed by itemId (missing keys = none recorded). Single
// query for the whole page so the /data endpoint avoids N+1.
export const getBcookieTranslatedByItemIds = (
  db: Database.Database,
  itemIds: number[],
): Map<number, number[]> => {
  const result = new Map<number, number[]>()
  if (itemIds.length === 0) return result
  const placeholders = itemIds.map(() => "?").join(",")
  const rows = db
    .prepare(`SELECT libraryPathItemId, languageId FROM bcookietranslated WHERE libraryPathItemId IN (${placeholders})`)
    .all(...itemIds) as { libraryPathItemId: number; languageId: number }[]
  for (const r of rows) {
    const list = result.get(r.libraryPathItemId)
    if (list) list.push(r.languageId)
    else result.set(r.libraryPathItemId, [r.languageId])
  }
  return result
}