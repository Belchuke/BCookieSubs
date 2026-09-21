import Database from "better-sqlite3"
import {
  DBUser,
  DBLanguage,
  DBMediaItem,
  DBSubtitle,
  DBSubtitleJob,
  DBSubtitleChunk,
  DBSubtitleChunkCandidate,
} from "../types/dbTypes"
import { DefaultResponse, FinishedSubtitle } from "../types/modelTypes"
import { SubtitleFormat } from "../types/subtitleTypes"
import { createLog } from "./logRepository"
import { getConfig } from "./configRepository"
import { userHasPermission } from "./userRepository"
import {
  getLanguageById,
  getLanguages,
  getConfigTranslationLanguageByLanguageId,
  getUserConfigTranslationLanguages,
  getConfigTranslationLanguages,
} from "./languageRepository"
import { getFileHash, parseLLMResponse } from "./shared"
import { serializeSrt, SrtEntry } from "../services/srtService"
import { detectSubtitleFormat } from "../services/subtitleFormatDetector"
import { parseSubtitleRows, serializeSubtitle } from "../services/subtitleAdapter"
import { subtitleExportExtension } from "../services/subtitleExportService"

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items.slice()]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export const getSubtitleById = (db: Database.Database, id: number): DBSubtitle | null => {
  return (
    (db.prepare(`SELECT * FROM subtitle WHERE id = ? AND deletedAt IS NULL`).get(id) as DBSubtitle | undefined) ?? null
  )
}

export const getSubtitleByFileHash = (db: Database.Database, fileHash: string): DBSubtitle | null => {
  return (
    (db.prepare(`SELECT * FROM subtitle WHERE originalFileHash = ? AND deletedAt IS NULL`).get(fileHash) as
      | DBSubtitle
      | undefined) ?? null
  )
}

// Next whisper-source subtitle awaiting transcription. When Whisper runs as a
// separate task, order by the dedicated `whisperOrderNumber` (the whisper
// queue's own ordering); otherwise order by `orderNumber` so the main
// translation queue's reordering controls what gets transcribed next.
export const getNextWhisperSubtitleForTranscription = (db: Database.Database): DBSubtitle | null => {
  const separate = getConfig(db).whisperRunAsSeparateTask === 1
  const orderCol = separate ? "whisperOrderNumber" : "orderNumber"
  return (
    (db
      .prepare(
        `SELECT * FROM subtitle
         WHERE source = 'whisper'
           AND deletedAt IS NULL
           AND status NOT IN ('cancelled', 'failed')
           AND whisperTranscriptionStatus NOT IN ('transcription_completed', 'transcription_failed')
         ORDER BY COALESCE(${orderCol}, orderNumber) ASC, id ASC
         LIMIT 1`,
      )
      .get() as DBSubtitle | undefined) ?? null
  )
}

// Next order number for the dedicated whisper queue (separate from the
// translation queue's `orderNumber`).
export const getNextWhisperOrderNumber = (db: Database.Database): number => {
  const result = db
    .prepare(`SELECT MAX(whisperOrderNumber) as maxOrder FROM subtitle WHERE deletedAt IS NULL AND source = 'whisper'`)
    .get() as { maxOrder: number | null }
  return (result.maxOrder ?? 0) + 1
}

// Number of completed chunks for a job (drives job progress).
export const countCompletedChunks = (db: Database.Database, jobId: number): number => {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM subtitleChunk WHERE subtitleJobId = ? AND status = 'completed'`)
    .get(jobId) as { cnt: number }
  return row.cnt
}

// Release worker-claimed chunks back to the queue: drop their candidate rows and
// reset any still-running chunk to 'queued'.
export const releaseRunningChunks = (db: Database.Database, chunkIds: number[]): void => {
  if (chunkIds.length === 0) return
  const placeholders = chunkIds.map(() => "?").join(",")
  db.prepare(`DELETE FROM subtitleChunkCandidate WHERE subtitleChunkId IN (${placeholders})`).run(...chunkIds)
  db.prepare(
    `UPDATE subtitleChunk SET status = 'queued', startedAt = NULL, updatedAt = datetime('now') WHERE id IN (${placeholders}) AND status = 'running'`,
  ).run(...chunkIds)
}

// Startup watchdog: chunks left "running" from a crashed/killed worker process
// are never re-queued (getNextQueuedChunkForWorker only picks status='queued'),
// so without this sweep they would stay running forever. Only chunks whose
// startedAt is older than `staleSeconds` are reset — that avoids clobbering a
// chunk another live worker just started if multiple workers ever run. Returns
// the number of chunks reset so the caller can log it.
export const resetStaleRunningChunks = (db: Database.Database, staleSeconds: number): number => {
  const result = db
    .prepare(
      `UPDATE subtitleChunk
       SET status = 'queued', startedAt = NULL, updatedAt = datetime('now')
       WHERE status = 'running'
         AND startedAt IS NOT NULL
         AND startedAt < datetime('now', ?)`,
    )
    .run(`-${staleSeconds} seconds`)
  return result.changes
}

// Completed subtitles that originate from a library path item (for auto-export).
export const getCompletedLibrarySubtitlesForExport = (
  db: Database.Database,
): { id: number; libraryPathItemId: number; mediaItemId: number | null }[] => {
  return db
    .prepare(
      `SELECT DISTINCT s.id, s.libraryPathItem as libraryPathItemId, s.mediaItemId
       FROM subtitle s
       INNER JOIN subtitleJob sj ON sj.subtitleId = s.id
       WHERE s.libraryPathItem IS NOT NULL AND sj.status = 'completed'`,
    )
    .all() as { id: number; libraryPathItemId: number; mediaItemId: number | null }[]
}

// Per-target-language job status for a subtitle (used to decide which languages
// are still missing/active for a library item).
export const getJobLangStatusBySubtitle = (
  db: Database.Database,
  subtitleId: number,
): { targetLangId: number; status: string }[] => {
  return db
    .prepare(`SELECT sj.targetLangId, sj.status FROM subtitleJob sj WHERE sj.subtitleId = ? AND sj.deletedAt IS NULL`)
    .all(subtitleId) as { targetLangId: number; status: string }[]
}

export const getActiveSubtitleForLibraryPathItem = (
  db: Database.Database,
  libraryPathItemId: number,
): DBSubtitle | null => {
  return (
    (db
      .prepare(`SELECT * FROM subtitle WHERE libraryPathItem = ? AND deletedAt IS NULL ORDER BY id DESC LIMIT 1`)
      .get(libraryPathItemId) as DBSubtitle | undefined) ?? null
  )
}

export const getActiveWhisperSubtitleForMediaItem = (
  db: Database.Database,
  mediaItemId: number,
): DBSubtitle | null => {
  return (
    (db
      .prepare(
        `SELECT * FROM subtitle WHERE mediaItemId = ? AND source = 'whisper' AND deletedAt IS NULL AND status NOT IN ('cancelled', 'failed') ORDER BY id DESC LIMIT 1`,
      )
      .get(mediaItemId) as DBSubtitle | undefined) ?? null
  )
}

// ── Batched variants (eliminate N+1 for the library-requests view) ──────────
// SQLite limits statements to ~999 bound parameters, so IN (...) lists are chunked.
const SQLITE_PARAM_CHUNK = 900

function chunkedInQuery<T>(
  db: Database.Database,
  ids: number[],
  sqlTemplate: (placeholders: string) => string,
): T[] {
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

// Per-target-language job status for many subtitles at once. Mirrors
// getJobLangStatusBySubtitle but in one (chunked) query instead of one per item.
export const getJobLangStatusBySubtitles = (
  db: Database.Database,
  subtitleIds: number[],
): Map<number, { targetLangId: number; status: string }[]> => {
  const map = new Map<number, { targetLangId: number; status: string }[]>()
  if (subtitleIds.length === 0) return map
  const rows = chunkedInQuery<{ subtitleId: number; targetLangId: number; status: string }>(
    db,
    subtitleIds,
    (p) =>
      `SELECT subtitleId, targetLangId, status FROM subtitleJob WHERE subtitleId IN (${p}) AND deletedAt IS NULL`,
  )
  for (const r of rows) {
    const arr = map.get(r.subtitleId)
    if (arr) arr.push({ targetLangId: r.targetLangId, status: r.status })
    else map.set(r.subtitleId, [{ targetLangId: r.targetLangId, status: r.status }])
  }
  return map
}

// Active Whisper subtitle for many library path items at once, keyed by the
// subtitle's `libraryPathItem` (the specific episode) rather than by media
// item. A Whisper subtitle is created per clicked episode but guarded to one
// per series (media item), so only the episode that actually kicked off
// transcription has a Whisper subtitle row. Keying by libraryPathItem here is
// what makes the library-requests view show "transcribing" on that one episode
// alone instead of bleeding onto every sibling episode that shares the
// series media item.
export const getActiveWhisperSubtitlesByLibraryPathItems = (
  db: Database.Database,
  libraryPathItemIds: number[],
): Map<number, DBSubtitle> => {
  const map = new Map<number, DBSubtitle>()
  if (libraryPathItemIds.length === 0) return map
  const rows = chunkedInQuery<DBSubtitle>(
    db,
    libraryPathItemIds,
    (p) =>
      `SELECT * FROM subtitle
       WHERE libraryPathItem IN (${p}) AND source = 'whisper'
         AND deletedAt IS NULL AND status NOT IN ('cancelled', 'failed')
       ORDER BY id DESC`,
  )
  for (const r of rows) {
    // Keep only the latest per library path item (ORDER BY id DESC, so the
    // first row seen for a given libraryPathItem is the newest).
    if (!map.has(r.libraryPathItem!)) map.set(r.libraryPathItem!, r as DBSubtitle)
  }
  return map
}

export const setWhisperTranscriptionStatus = (
  db: Database.Database,
  subtitleId: number,
  status: DBSubtitle["whisperTranscriptionStatus"],
): void => {
  db.prepare(
    `UPDATE subtitle SET whisperTranscriptionStatus = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(status, subtitleId)
}

export const setWhisperProgress = (
  db: Database.Database,
  subtitleId: number,
  progress: number,
  positionMs = 0,
  durationMs = 0,
): void => {
  db.prepare(
    `UPDATE subtitle SET whisperProgress = ?, whisperPositionMs = ?, whisperDurationMs = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(
    Math.max(0, Math.min(100, Math.round(progress))),
    Math.max(0, Math.round(positionMs)),
    Math.max(0, Math.round(durationMs)),
    subtitleId,
  )
}

export const getWhisperProgress = (db: Database.Database, subtitleId: number): number => {
  const row = db.prepare(`SELECT whisperProgress FROM subtitle WHERE id = ?`).get(subtitleId) as
    | { whisperProgress: number }
    | undefined
  return row?.whisperProgress ?? 0
}

export const resetWhisperProgress = (db: Database.Database, subtitleId: number): void => {
  db.prepare(
    `UPDATE subtitle SET whisperProgress = 0, whisperPositionMs = 0, whisperDurationMs = 0, updatedAt = datetime('now') WHERE id = ?`,
  ).run(subtitleId)
}

// Persist a Whisper checkpoint captured when a transcription is stopped/preempted mid-run.
// `srt` is the serialized SRT of every fully-streamed segment so far; `ms` is the end-time of
// the last such segment. On resume the media is seek-trimmed from `ms` and only the tail is
// re-transcribed, then merged back with this checkpoint.
export const saveWhisperCheckpoint = (
  db: Database.Database,
  subtitleId: number,
  srt: string,
  ms: number,
): void => {
  db.prepare(
    `UPDATE subtitle SET whisperResumeSrt = ?, whisperResumeMs = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(srt, Math.max(0, Math.round(ms)), subtitleId)
}

export const createWhisperSubtitle = (
  db: Database.Database,
  user: DBUser,
  mediaItemId: number,
  libraryPathItemId: number | null,
  mediaPath: string,
  sourceLangId: number,
  srtFileName: string,
  displayName: string,
  model: string,
  timestampsLength: number,
  useCuda: boolean,
  season: number | null,
  episode: number | null,
): { subtitle: DBSubtitle; success: boolean; msg: string | null } => {
  const existing = getActiveWhisperSubtitleForMediaItem(db, mediaItemId)
  if (existing) {
    return { subtitle: existing, success: true, msg: "Existing Whisper subtitle workflow found" }
  }

  const nextOrderNumber = getNextOrderNumberForSubtitle(db)
  const nextWhisperOrderNumber = getNextWhisperOrderNumber(db)

  const result = db
    .prepare(
      `INSERT INTO subtitle (
        userId, sourceLangId, mediaItemId, libraryPathItem, name, originalFileHash,
        originalTextSRTName, originalText, orderNumber, whisperOrderNumber, source, sourcePath, mediaPath,
        status, whisperTranscriptionStatus, whisperModel, whisperTimestampsLength, whisperUseCuda,
        season, episode
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      sourceLangId,
      mediaItemId,
      libraryPathItemId,
      displayName,
      "",
      srtFileName,
      "",
      nextOrderNumber,
      nextWhisperOrderNumber,
      "whisper",
      null,
      mediaPath,
      "queued",
      "queued_for_transcription",
      model,
      timestampsLength,
      useCuda ? 1 : 0,
      season,
      episode,
    )

  const subtitleId = result.lastInsertRowid as number
  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) {
    return { subtitle: null as any, success: false, msg: "Failed to create Whisper subtitle" }
  }
  createLog(db, "info", "subtitleCreate", "subtitle", subtitle.id, "Created Whisper subtitle workflow", {
    mediaItemId,
    libraryPathItemId,
    model,
  })
  return { subtitle, success: true, msg: "Whisper subtitle workflow created" }
}

export const getTargetLanguagesForWhisperWorkflow = (
  db: Database.Database,
  userId: number,
): number[] => {
  const userTargetLangs = getUserConfigTranslationLanguages(db, userId)
  if (userTargetLangs.length > 0) {
    return userTargetLangs.map((tl) => tl.languageId)
  }
  return getConfigTranslationLanguages(db).map((cl) => cl.languageId)
}

export const finalizeWhisperTranscription = (
  db: Database.Database,
  subtitleId: number,
  rawSrt: string,
  entries: SrtEntry[],
  srtFileName: string,
): void => {
  // Persist the de-duplicated/normalized SRT (runs of >3 identical consecutive
  // lines grouped with an extended duration). `entries` is already deduped and
  // re-numbered by deduplicateSrtEntries; the raw whisper output is only used
  // for the file hash so re-runs of identical media stay idempotent.
  const dedupedSrt = serializeSrt(entries)
  const originalFileHash = getFileHash(rawSrt)
  db.prepare(
    `UPDATE subtitle SET
      originalText = ?,
      originalFileHash = ?,
      originalTextSRTName = ?,
      whisperTranscriptionStatus = 'transcription_completed',
      whisperResumeSrt = NULL,
      whisperResumeMs = 0,
      updatedAt = datetime('now')
     WHERE id = ?`,
  ).run(dedupedSrt, originalFileHash, srtFileName, subtitleId)
}

// Translating a subtitle into its own source language is never useful — it
// would just re-run the model on already-correct text. Every job-creation
// entry point below drops the source language from its requested target list
// before queuing anything, so re-requesting it (e.g. because it's part of a
// user's default target-language set) is a silent no-op instead of a wasted
// translation run. Compared by language row id, not iso code, since a source
// and target could otherwise be distinct locale rows sharing a code.
function excludingSourceLanguage(targetLangIds: number[], sourceLangId: number): number[] {
  return targetLangIds.filter((id) => id !== sourceLangId)
}

export const createPlaceholderTranslationJobs = (
  db: Database.Database,
  user: DBUser,
  subtitleId: number,
  targetLangIds: number[],
  season: number | null,
  episode: number | null,
): { success: boolean; msg: string | null } => {
  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }
  targetLangIds = excludingSourceLanguage(targetLangIds, subtitle.sourceLangId)

  const existingJobs = getSubtitleJobsBySubtitleId(db, subtitleId)
  const existingLangIds = new Set(existingJobs.map((j) => j.targetLangId))
  const newLangs = targetLangIds
    .map((id) => getLanguageById(db, id))
    .filter((l): l is DBLanguage => !!l && !existingLangIds.has(l.id))

  if (newLangs.length === 0) return { success: true, msg: "All requested languages already exist" }

  const maxOrder = existingJobs.reduce((max, j) => (j.orderNumber > max ? j.orderNumber : max), -1)

  const transaction = db.transaction(() => {
    newLangs.forEach((lang, index) => {
      db.prepare(
        `INSERT INTO subtitleJob (subtitleId, userId, targetLangId, chunkSetting, chunkSizeTotal, chunkCurrent, season, episode, orderNumber, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        subtitle.id,
        user.id,
        lang.id,
        10,
        0,
        0,
        season,
        episode,
        maxOrder + 1 + index,
        "queued",
      )
    })
  })
  transaction()

  createLog(db, "info", "subtitleCreate", "subtitle", subtitle.id, "Created placeholder translation jobs for Whisper workflow", {
    addedLangs: newLangs.map((l) => l.name),
  })
  return { success: true, msg: `Added ${newLangs.length} placeholder translation job(s)` }
}

export const createTranslationJobsForSubtitle = (
  db: Database.Database,
  user: DBUser,
  subtitleId: number,
  targetLangIds: number[],
  chunkSetting: number,
  season: number | null,
  episode: number | null,
): DefaultResponse => {
  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }
  targetLangIds = excludingSourceLanguage(targetLangIds, subtitle.sourceLangId)

  const parsedSubtitles = parseSubtitleRows(subtitle.originalText, subtitle.sourceFormat)
  if (parsedSubtitles.length === 0) {
    return { success: false, msg: "Original SRT could not be parsed" }
  }

  const chunks = chunkArray(parsedSubtitles, chunkSetting)
  const existingJobs = getSubtitleJobsBySubtitleId(db, subtitleId)
  const existingLangIds = new Set(existingJobs.map((j) => j.targetLangId))

  const targetLangs = targetLangIds
    .map((id) => getLanguageById(db, id))
    .filter((l): l is DBLanguage => !!l)

  const newLangs = targetLangs.filter((l) => !existingLangIds.has(l.id))
  const placeholderJobs = existingJobs.filter(
    (j) => j.status === "queued" && j.chunkSizeTotal === 0 && targetLangIds.includes(j.targetLangId),
  )

  if (newLangs.length === 0 && placeholderJobs.length === 0) {
    return { success: true, msg: "All requested languages already exist" }
  }

  const maxOrder = existingJobs.reduce((max, j) => (j.orderNumber > max ? j.orderNumber : max), -1)

  const transaction = db.transaction(() => {
    // Convert placeholder jobs into real jobs by adding chunks.
    placeholderJobs.forEach((job) => {
      db.prepare(
        `UPDATE subtitleJob SET chunkSetting = ?, chunkSizeTotal = ?, chunkCurrent = 0, season = ?, episode = ?, updatedAt = datetime('now') WHERE id = ?`,
      ).run(chunkSetting, chunks.length, season, episode, job.id)

      chunks.forEach((chunk, chunkIndex) => {
        db.prepare(
          `INSERT INTO subtitleChunk (subtitleId, subtitleJobId, targetLangId, chunkIndex, srtIdFrom, srtIdTo, chunkTextRaw) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          subtitle.id,
          job.id,
          job.targetLangId,
          chunkIndex,
          parseInt(chunk[0].id),
          parseInt(chunk[chunk.length - 1].id),
          JSON.stringify(chunk),
        )
      })
    })

    // Create brand new jobs for languages that weren't placeholders.
    newLangs.forEach((lang, index) => {
      const jobResult = db
        .prepare(
          `INSERT INTO subtitleJob (subtitleId, userId, targetLangId, chunkSetting, chunkSizeTotal, season, episode, orderNumber) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          subtitle.id,
          user.id,
          lang.id,
          chunkSetting,
          chunks.length,
          season,
          episode,
          maxOrder + 1 + index,
        )

      const subtitleJobId = jobResult.lastInsertRowid as number

      chunks.forEach((chunk, chunkIndex) => {
        db.prepare(
          `INSERT INTO subtitleChunk (subtitleId, subtitleJobId, targetLangId, chunkIndex, srtIdFrom, srtIdTo, chunkTextRaw) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          subtitle.id,
          subtitleJobId,
          lang.id,
          chunkIndex,
          parseInt(chunk[0].id),
          parseInt(chunk[chunk.length - 1].id),
          JSON.stringify(chunk),
        )
      })
    })

    db.prepare(
      `UPDATE subtitle SET status = 'queued', updatedAt = datetime('now') WHERE id = ? AND status IN ('completed', 'cancelled', 'failed')`,
    ).run(subtitle.id)
  })
  transaction()

  const allAdded = [...placeholderJobs.map((j) => j.targetLangId), ...newLangs.map((l) => l.id)]
  const addedLangNames = targetLangs
    .filter((l) => allAdded.includes(l.id))
    .map((l) => l.name)

  createLog(db, "info", "subtitleCreate", "subtitle", subtitle.id, "Created translation jobs from Whisper-generated SRT", {
    addedLangs: addedLangNames,
  })
  return { success: true, msg: `Added ${addedLangNames.length} translation job(s)` }
}

export const getSubtitleJobById = (db: Database.Database, id: number): DBSubtitleJob | null => {
  return (
    (db.prepare(`SELECT * FROM subtitleJob WHERE id = ? AND deletedAt IS NULL`).get(id) as DBSubtitleJob | undefined) ??
    null
  )
}

export const getSubtitleJobsBySubtitleId = (db: Database.Database, subtitleId: number): DBSubtitleJob[] => {
  return db
    .prepare(`SELECT * FROM subtitleJob WHERE subtitleId = ? AND deletedAt IS NULL ORDER BY orderNumber ASC`)
    .all(subtitleId) as DBSubtitleJob[]
}

export const getChunksByJobId = (db: Database.Database, jobId: number): DBSubtitleChunk[] => {
  return db
    .prepare(`SELECT * FROM subtitleChunk WHERE subtitleJobId = ? ORDER BY chunkIndex ASC`)
    .all(jobId) as DBSubtitleChunk[]
}

export const getCandidatesByChunkId = (db: Database.Database, chunkId: number): DBSubtitleChunkCandidate[] => {
  return db
    .prepare(`SELECT * FROM subtitleChunkCandidate WHERE subtitleChunkId = ? ORDER BY createdAt ASC`)
    .all(chunkId) as DBSubtitleChunkCandidate[]
}

export const getNextOrderNumberForSubtitle = (db: Database.Database): number => {
  const result = db.prepare(`SELECT MAX(orderNumber) as maxOrder FROM subtitle WHERE deletedAt IS NULL`).get() as {
    maxOrder: number | null
  }
  return (result.maxOrder ?? 0) + 1
}

export const addMissingTargetLanguageJobs = (
  db: Database.Database,
  user: DBUser,
  subtitleId: number,
  newTargetLangIds: number[],
): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canAddSubtitleToTranslateFromLibrary")
  if (!hasPermission) return { success: false, msg: "Permission denied" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }
  newTargetLangIds = excludingSourceLanguage(newTargetLangIds, subtitle.sourceLangId)

  if (newTargetLangIds.length === 0) return { success: true, msg: "No new languages to add" }

  const existingJobs = getSubtitleJobsBySubtitleId(db, subtitleId)
  const existingLangIds = new Set(existingJobs.map((j) => j.targetLangId))

  const newLangs = newTargetLangIds
    .map((id) => getLanguageById(db, id))
    .filter((l): l is DBLanguage => !!l && !existingLangIds.has(l.id))

  if (newLangs.length === 0) return { success: true, msg: "All requested languages already exist" }

  const parsedSubtitles = parseSubtitleRows(subtitle.originalText, subtitle.sourceFormat)
  if (parsedSubtitles.length === 0) return { success: false, msg: "Original subtitle could not be parsed" }

  const existingChunkSetting = existingJobs[0]?.chunkSetting ?? 10
  const existingSeason = existingJobs[0]?.season ?? null
  const existingEpisode = existingJobs[0]?.episode ?? null

  const chunks = chunkArray(parsedSubtitles, existingChunkSetting)

  // Place these jobs at the front of the queue (priority)
  const minOrder = db
    .prepare(`SELECT MIN(orderNumber) as minOrder FROM subtitleJob WHERE deletedAt IS NULL`)
    .get() as { minOrder: number | null }
  const priorityStart = (minOrder.minOrder ?? 1) - newLangs.length

  const transaction = db.transaction(() => {
    newLangs.forEach((lang, index) => {
      const jobResult = db
        .prepare(
          `INSERT INTO subtitleJob (subtitleId, userId, targetLangId, chunkSetting, chunkSizeTotal, season, episode, orderNumber) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          subtitle.id,
          user.id,
          lang.id,
          existingChunkSetting,
          chunks.length,
          existingSeason,
          existingEpisode,
          priorityStart + index,
        )

      const subtitleJobId = jobResult.lastInsertRowid as number

      chunks.forEach((chunk, chunkIndex) => {
        db.prepare(
          `INSERT INTO subtitleChunk (subtitleId, subtitleJobId, targetLangId, chunkIndex, srtIdFrom, srtIdTo, chunkTextRaw) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          subtitle.id,
          subtitleJobId,
          lang.id,
          chunkIndex,
          parseInt(chunk[0].id),
          parseInt(chunk[chunk.length - 1].id),
          chunk.map((c) => c.text).join("\n"),
        )
      })
    })

    // Make sure the parent subtitle is not marked completed if it was
    db.prepare(
      `UPDATE subtitle SET status = 'queued', updatedAt = datetime('now') WHERE id = ? AND status IN ('completed', 'cancelled', 'failed')`,
    ).run(subtitle.id)
  })
  transaction()

  createLog(db, "info", "subtitleCreate", "subtitle", subtitle.id, "Added missing language jobs", {
    addedLangs: newLangs.map((l) => l.name),
  })
  return {
    success: true,
    msg: `Added ${newLangs.length} language job(s) with priority`,
  }
}

export const createSubtitleTask = (
  db: Database.Database,
  user: DBUser,
  mediaItemId: number | null,
  sourceLangId: number,
  targetLangIds: number[],
  rawContent: string,
  chunkSetting: number,
  season: number | null,
  episode: number | null,
  srtFileName: string,
  displayName: string | null = null,
  source: string | null = null,
  sourcePath: string | null = null,
  mediaPath: string | null = null,
  libraryPathItemId: number | null = null,
  // Provenance for .sub-derived subtitles: textOrigin = "ocr" | "parsed",
  // originalSourceFormat = "sub". null for normal srt/ass/ssa/whisper sources.
  textOrigin: string | null = null,
  originalSourceFormat: string | null = null,
): DefaultResponse => {
  const permission = userHasPermission(db, user.id, "canAddSubtitleToTranslateDashboard")
  if (!permission.hasPermission) return { success: false, msg: "Permission denied" }

  const getLang = getLanguageById(db, sourceLangId)
  if (!getLang) return { success: false, msg: "Source language not found" }
  targetLangIds = excludingSourceLanguage(targetLangIds, sourceLangId)

  const getLangTargetInOrder = targetLangIds
    .map((id, index) => {
      const lang = getLanguageById(db, id)
      if (!lang) return null
      const configLang = getConfigTranslationLanguageByLanguageId(db, id)
      return { lang, originalIndex: index, orderNumber: configLang?.orderNumber ?? null }
    })
    .filter((item): item is { lang: DBLanguage; originalIndex: number; orderNumber: number | null } => item !== null)
    .sort((a, b) => {
      if (a.orderNumber !== null && b.orderNumber === null) return -1
      if (a.orderNumber === null && b.orderNumber !== null) return 1
      if (a.orderNumber !== null && b.orderNumber !== null) return a.orderNumber - b.orderNumber
      return a.originalIndex - b.originalIndex
    })
    .map((item) => item.lang)

  const sourceFormat = detectSubtitleFormat(srtFileName, rawContent)
  const parsedSubtitles = parseSubtitleRows(rawContent, sourceFormat)

  if (parsedSubtitles.length === 0) {
    return { success: false, msg: "Could not parse subtitle file — file may be empty or malformed" }
  }

  const originalFileHash = getFileHash(rawContent)
  const existingSubtitle = getSubtitleByFileHash(db, originalFileHash)

  if (existingSubtitle) {
    const existingJobs = getSubtitleJobsBySubtitleId(db, existingSubtitle.id)
    const existingLangIds = new Set(existingJobs.map((j) => j.targetLangId))
    const missingLangs = getLangTargetInOrder.filter((l) => !existingLangIds.has(l.id))

    if (missingLangs.length === 0) {
      return { success: true, msg: "Subtitle already exists with all requested target languages" }
    }

    const chunks = chunkArray(parsedSubtitles, chunkSetting)
    const maxOrder = existingJobs.reduce((max, j) => (j.orderNumber > max ? j.orderNumber : max), -1)

    const transaction = db.transaction(() => {
      missingLangs.forEach((lang, index) => {
        const jobResult = db
          .prepare(
            `INSERT INTO subtitleJob (subtitleId, userId, targetLangId, chunkSetting, chunkSizeTotal, season, episode, orderNumber) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            existingSubtitle.id,
            user.id,
            lang.id,
            chunkSetting,
            chunks.length,
            season,
            episode,
            maxOrder + 1 + index,
          )

        const subtitleJobId = jobResult.lastInsertRowid as number

        chunks.forEach((chunk, chunkIndex) => {
          db.prepare(
            `INSERT INTO subtitleChunk (subtitleId, subtitleJobId, targetLangId, chunkIndex, srtIdFrom, srtIdTo, chunkTextRaw) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            existingSubtitle.id,
            subtitleJobId,
            lang.id,
            chunkIndex,
            parseInt(chunk[0].id),
            parseInt(chunk[chunk.length - 1].id),
            chunk.map((c) => c.text).join("\n"),
          )
        })
      })
    })
    transaction()

    createLog(db, "info", "subtitleCreate", "subtitle", existingSubtitle.id, "Added missing jobs for re-uploaded subtitle", {
      addedLangs: missingLangs.map((l) => l.name),
    })
    return { success: true, msg: `Added ${missingLangs.length} new language job(s) to existing subtitle` }
  }

  const nextOrderNumber = getNextOrderNumberForSubtitle(db)
  const chunks = chunkArray(parsedSubtitles, chunkSetting)

  const transaction = db.transaction(() => {
    const subtitleResult = db
      .prepare(
        `INSERT INTO subtitle (userId, sourceLangId, mediaItemId, libraryPathItem, name, originalFileHash, originalTextSRTName, originalText, sourceFormat, orderNumber, source, sourcePath, mediaPath, textOrigin, originalSourceFormat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        sourceLangId,
        mediaItemId,
        libraryPathItemId,
        displayName ?? srtFileName,
        originalFileHash,
        srtFileName,
        rawContent,
        sourceFormat,
        nextOrderNumber,
        source,
        sourcePath,
        mediaPath,
        textOrigin,
        originalSourceFormat,
      )

    const subtitleId = subtitleResult.lastInsertRowid as number

    getLangTargetInOrder.forEach((lang, index) => {
      const jobResult = db
        .prepare(
          `INSERT INTO subtitleJob (subtitleId, userId, targetLangId, chunkSetting, chunkSizeTotal, season, episode, orderNumber) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(subtitleId, user.id, lang.id, chunkSetting, chunks.length, season, episode, index + 1)

      const subtitleJobId = jobResult.lastInsertRowid as number

      chunks.forEach((chunk, chunkIndex) => {
        db.prepare(
          `INSERT INTO subtitleChunk (subtitleId, subtitleJobId, targetLangId, chunkIndex, srtIdFrom, srtIdTo, chunkTextRaw) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          subtitleId,
          subtitleJobId,
          lang.id,
          chunkIndex,
          parseInt(chunk[0].id),
          parseInt(chunk[chunk.length - 1].id),
          JSON.stringify(chunk),
        )
      })
    })
  })
  transaction()

  createLog(db, "info", "subtitleCreate", "subtitle", null, "Created subtitle task", {
    name: srtFileName,
    langs: getLangTargetInOrder.map((l) => l.name),
  })
  return { success: true, msg: "Subtitle task created successfully" }
}

export const cancelSubtitle = (db: Database.Database, user: DBUser, subtitleId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canCancelTranslationJob")
  if (!perm) return { success: false, msg: "User does not have permission to stop subtitles" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }
  if (subtitle.status === "completed") return { success: false, msg: "Cannot cancel a completed subtitle" }

  db.prepare(
    `UPDATE subtitle SET status = 'cancelled', cancelledAt = datetime('now'), cancelledByUserId = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(user.id, subtitleId)

  db.prepare(
    `UPDATE subtitleJob SET status = 'cancelled', cancelledAt = datetime('now'), cancelledByUserId = ?, updatedAt = datetime('now') WHERE subtitleId = ? AND status NOT IN ('completed', 'cancelled')`,
  ).run(user.id, subtitleId)

  db.prepare(
    `UPDATE subtitleChunk SET status = 'cancelled', updatedAt = datetime('now') WHERE subtitleId = ? AND status NOT IN ('completed', 'cancelled')`,
  ).run(subtitleId)

  createLog(db, "info", "subtitleCancel", "subtitle", subtitleId, "Cancelled subtitle", { cancelledBy: user.id })
  return { success: true, msg: null }
}

// Re-add a cancelled subtitle to the queue — the inverse of cancelSubtitle. The
// subtitle and its cancelled jobs/chunks go back to 'queued' (completed work is
// preserved: completed jobs/chunks stay completed), and the cancellation
// markers are cleared. Works for both translation-queue items and Whisper
// subtitles (a Whisper subtitle mid-transcription resumes from its checkpoint;
// one already through transcription just re-queues its translation jobs).
export const requeueCancelledSubtitle = (db: Database.Database, user: DBUser, subtitleId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canCancelTranslationJob")
  if (!perm) return { success: false, msg: "User does not have permission to re-queue subtitles" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }
  if (subtitle.status !== "cancelled") return { success: false, msg: "Only cancelled subtitles can be re-added" }

  db.transaction(() => {
    // Put the subtitle back in the queue and clear the cancellation markers.
    db.prepare(
      `UPDATE subtitle
       SET status = 'queued', cancelledAt = NULL, cancelledByUserId = NULL, updatedAt = datetime('now')
       WHERE id = ?`,
    ).run(subtitleId)

    // Re-queue the jobs that were cancelled; completed jobs stay completed.
    db.prepare(
      `UPDATE subtitleJob
       SET status = 'queued', cancelledAt = NULL, cancelledByUserId = NULL, updatedAt = datetime('now')
       WHERE subtitleId = ? AND status = 'cancelled' AND deletedAt IS NULL`,
    ).run(subtitleId)

    // Drop stale candidate rows for the chunks we're about to re-queue, then
    // reset those chunks to a clean 'queued' state (completed chunks stay).
    db.prepare(
      `DELETE FROM subtitleChunkCandidate
       WHERE subtitleChunkId IN (SELECT id FROM subtitleChunk WHERE subtitleId = ? AND status = 'cancelled')`,
    ).run(subtitleId)
    db.prepare(
      `UPDATE subtitleChunk
       SET status = 'queued', retryCount = 0, startedAt = NULL, finishedAt = NULL,
           errorMessage = NULL, selectedCandidateId = NULL, updatedAt = datetime('now')
       WHERE subtitleId = ? AND status = 'cancelled'`,
    ).run(subtitleId)
  })()

  createLog(db, "info", "subtitleCancel", "subtitle", subtitleId, "Re-added cancelled subtitle to the queue", {
    requeuedBy: user.id,
  })
  return { success: true, msg: null }
}

export const cancelSubtitleJob = (db: Database.Database, user: DBUser, jobId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canCancelTranslationJob")
  if (!perm) return { success: false, msg: "Permission denied" }

  const job = getSubtitleJobById(db, jobId)
  if (!job) return { success: false, msg: "Job not found" }
  if (job.status === "completed") return { success: false, msg: "Cannot cancel a completed job" }
  if (job.status === "cancelled") return { success: false, msg: "Job already cancelled" }

  db.prepare(
    `UPDATE subtitleJob SET status = 'cancelled', cancelledAt = datetime('now'), cancelledByUserId = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(user.id, jobId)
  db.prepare(
    `UPDATE subtitleChunk SET status = 'cancelled', updatedAt = datetime('now') WHERE subtitleJobId = ? AND status NOT IN ('completed', 'cancelled')`,
  ).run(jobId)

  const remaining = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM subtitleJob WHERE subtitleId = ? AND deletedAt IS NULL AND status NOT IN ('completed', 'cancelled')`,
    )
    .get(job.subtitleId) as { cnt: number }
  if (remaining.cnt === 0) {
    db.prepare(
      `UPDATE subtitle SET status = 'cancelled', cancelledAt = datetime('now'), cancelledByUserId = ?, updatedAt = datetime('now') WHERE id = ?`,
    ).run(user.id, job.subtitleId)
  }

  createLog(db, "info", "subtitleCancel", "subtitle", job.subtitleId, "Cancelled subtitle job", { jobId, cancelledBy: user.id })
  return { success: true, msg: null }
}

export const softDeleteSubtitle = (db: Database.Database, user: DBUser, subtitleId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canDeleteTranslation")
  if (!perm) return { success: false, msg: "Permission denied" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }

  db.prepare(
    `UPDATE subtitle SET deletedAt = datetime('now'), deletedByUserId = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(user.id, subtitleId)

  createLog(db, "info", "subtitleDelete", "subtitle", subtitleId, "Deleted subtitle", { deletedBy: user.id })
  return { success: true, msg: null }
}

// Soft-delete the subtitles tied to a media item that are currently in a given
// queue. A series can straddle both queues (some episodes still transcribing
// via Whisper, others already translating), so deleting "the series" from one
// queue card must only hit the episodes shown in THAT card — not wipe the
// other queue's episodes too. `queueScope` mirrors the dashboard's
// isWhisperStage split:
//   - "whisper":      source='whisper' AND transcription not yet completed/failed-final
//                     (the whisper queue: queued_for_transcription, transcribing,
//                      transcription_failed, queued_for_translation, translating)
//   - "translation":  everything else for that media item (uploads, library
//                     subtitles, and whisper subtitles that finished
//                     transcription and moved into the translation queue)
//   - "all":          every non-deleted subtitle for the media item (legacy).
// Mirrors softDeleteSubtitle's per-row behavior (sets deletedAt + deletedByUserId);
// the worker treats deletedAt as a stop signal, so in-flight jobs/whisper
// transcription wind down on their own.
export const softDeleteSubtitlesByMediaItem = (
  db: Database.Database,
  user: DBUser,
  mediaItemId: number,
  queueScope: "whisper" | "translation" | "all" = "all",
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canDeleteTranslation")
  if (!perm) return { success: false, msg: "Permission denied" }

  const stageClause =
    queueScope === "whisper"
      ? `AND source = 'whisper' AND whisperTranscriptionStatus IS NOT NULL AND whisperTranscriptionStatus != 'transcription_completed'`
      : queueScope === "translation"
        ? `AND NOT (source = 'whisper' AND whisperTranscriptionStatus IS NOT NULL AND whisperTranscriptionStatus != 'transcription_completed')`
        : ``

  const subs = db
    .prepare(
      `SELECT id, name FROM subtitle WHERE mediaItemId = ? AND deletedAt IS NULL ${stageClause}`,
    )
    .all(mediaItemId) as { id: number; name: string }[]

  if (subs.length === 0) return { success: false, msg: "Series not found in queue" }

  const update = db.prepare(
    `UPDATE subtitle SET deletedAt = datetime('now'), deletedByUserId = ?, updatedAt = datetime('now') WHERE id = ?`,
  )
  db.transaction(() => {
    for (const s of subs) {
      update.run(user.id, s.id)
      createLog(db, "info", "subtitleDelete", "subtitle", s.id, "Deleted subtitle (series delete)", {
        deletedBy: user.id,
        mediaItemId,
        queueScope,
        name: s.name,
      })
    }
  })()

  return { success: true, msg: `Deleted ${subs.length} subtitle(s)` }
}

// Cancel (mark cancelled, not deleted) the subtitles tied to a media item that
// are currently in a given queue. This is the default behaviour for an
// entire-series "delete" action when config.deleteNotCancel is false: the series
// goes to cancelled and stays visible, removable later through a real delete.
// Completed subtitles/jobs/chunks are left intact — only active work is
// cancelled. `queueScope` mirrors softDeleteSubtitlesByMediaItem so a series
// straddling the whisper + translation queues is only cancelled in the card the
// action was triggered from. Permission is canCancelTranslationJob (the cancel
// permission), matching cancelSubtitle.
export const cancelSubtitlesByMediaItem = (
  db: Database.Database,
  user: DBUser,
  mediaItemId: number,
  queueScope: "whisper" | "translation" | "all" = "all",
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canCancelTranslationJob")
  if (!perm) return { success: false, msg: "Permission denied" }

  const stageClause =
    queueScope === "whisper"
      ? `AND source = 'whisper' AND whisperTranscriptionStatus IS NOT NULL AND whisperTranscriptionStatus != 'transcription_completed'`
      : queueScope === "translation"
        ? `AND NOT (source = 'whisper' AND whisperTranscriptionStatus IS NOT NULL AND whisperTranscriptionStatus != 'transcription_completed')`
        : ``

  const subs = db
    .prepare(
      `SELECT id, name FROM subtitle
       WHERE mediaItemId = ? AND deletedAt IS NULL
         AND status NOT IN ('completed', 'cancelled', 'failed')
       ${stageClause}`,
    )
    .all(mediaItemId) as { id: number; name: string }[]

  if (subs.length === 0) return { success: false, msg: "Series not found in queue" }

  const cancelSub = db.prepare(
    `UPDATE subtitle
     SET status = 'cancelled', cancelledAt = datetime('now'), cancelledByUserId = ?, updatedAt = datetime('now')
     WHERE id = ?`,
  )
  const cancelJobs = db.prepare(
    `UPDATE subtitleJob
     SET status = 'cancelled', cancelledAt = datetime('now'), cancelledByUserId = ?, updatedAt = datetime('now')
     WHERE subtitleId = ? AND deletedAt IS NULL AND status NOT IN ('completed', 'cancelled')`,
  )
  const cancelChunks = db.prepare(
    `UPDATE subtitleChunk
     SET status = 'cancelled', updatedAt = datetime('now')
     WHERE subtitleId = ? AND status NOT IN ('completed', 'cancelled')`,
  )
  db.transaction(() => {
    for (const s of subs) {
      cancelSub.run(user.id, s.id)
      cancelJobs.run(user.id, s.id)
      cancelChunks.run(s.id)
      createLog(db, "info", "subtitleCancel", "subtitle", s.id, "Cancelled subtitle (series cancel)", {
        cancelledBy: user.id,
        mediaItemId,
        queueScope,
        name: s.name,
      })
    }
  })()

  return { success: true, msg: `Cancelled ${subs.length} subtitle(s)` }
}

// Bulk cancel/delete for the dashboard multi-select flow. Handles a mix of
// whole-subtitle entities and individual target-language jobs:
//   - Active subtitle  → cancel (default) or delete (when deleteNotCancel)
//   - Cancelled subtitle → delete (so cancelled items can be removed later)
//   - Active job        → cancel (default) or delete (when deleteNotCancel)
//   - Cancelled job     → delete
// Completed/failed entities are left alone (skipped). If a subtitle is in the
// selection, its jobs are NOT processed separately even if also selected (the
// subtitle-level action already covers them), avoiding double-processing.
// Permissions are enforced per item via the underlying cancel/delete helpers,
// each of which checks the appropriate permission (canCancelTranslationJob for
// cancel, canDeleteTranslation for delete). Returns per-item counts.
export const bulkCancelDelete = (
  db: Database.Database,
  user: DBUser,
  subtitleIds: number[],
  jobIds: number[],
  deleteNotCancel: boolean,
): {
  success: boolean
  msg: string
  cancelled: number
  deleted: number
  skipped: number
  failed: number
} => {
  let cancelled = 0
  let deleted = 0
  let skipped = 0
  let failed = 0
  const processedSubtitleIds = new Set<number>()

  for (const subtitleId of subtitleIds) {
    const sub = getSubtitleById(db, subtitleId)
    if (!sub || sub.deletedAt) {
      skipped++
      continue
    }
    processedSubtitleIds.add(subtitleId)

    let result: DefaultResponse
    if (sub.status === "cancelled") {
      // Cancelled → always delete (remove permanently).
      result = softDeleteSubtitle(db, user, subtitleId)
      if (result.success) deleted++
      else failed++
    } else if (sub.status === "completed" || sub.status === "failed") {
      // Leave finished work alone in the bulk flow.
      skipped++
    } else {
      // Active → cancel (default) or delete (when deleteNotCancel).
      result = deleteNotCancel
        ? softDeleteSubtitle(db, user, subtitleId)
        : cancelSubtitle(db, user, subtitleId)
      if (result.success) {
        if (deleteNotCancel) deleted++
        else cancelled++
      } else {
        failed++
      }
    }
  }

  for (const jobId of jobIds) {
    const job = getSubtitleJobById(db, jobId)
    if (!job || job.deletedAt) {
      skipped++
      continue
    }
    // Skip jobs whose subtitle was already handled above.
    if (processedSubtitleIds.has(job.subtitleId)) {
      skipped++
      continue
    }

    let result: DefaultResponse
    if (job.status === "cancelled") {
      result = softDeleteSubtitleJob(db, user, jobId)
      if (result.success) deleted++
      else failed++
    } else if (job.status === "completed" || job.status === "failed") {
      skipped++
    } else {
      result = deleteNotCancel
        ? softDeleteSubtitleJob(db, user, jobId)
        : cancelSubtitleJob(db, user, jobId)
      if (result.success) {
        if (deleteNotCancel) deleted++
        else cancelled++
      } else {
        failed++
      }
    }
  }

  return {
    success: true,
    msg: `Cancelled ${cancelled}, deleted ${deleted}, skipped ${skipped}` + (failed > 0 ? `, failed ${failed}` : ""),
    cancelled,
    deleted,
    skipped,
    failed,
  }
}

export const moveSubtitleInQueue = (
  db: Database.Database,
  user: DBUser,
  subtitleId: number,
  direction: "up" | "down",
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canChangeSubtitlePriority")
  if (!perm) return { success: false, msg: "User does not have permission to manage subtitles" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }

  const others = db
    .prepare(
      `SELECT * FROM subtitle WHERE deletedAt IS NULL AND status NOT IN ('completed','cancelled','failed') ORDER BY orderNumber ASC`,
    )
    .all() as DBSubtitle[]

  const idx = others.findIndex((s) => s.id === subtitleId)
  if (idx === -1) return { success: false, msg: "Subtitle not in movable queue" }

  const swapIdx = direction === "up" ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= others.length) return { success: true, msg: null }

  const a = others[idx]
  const b = others[swapIdx]

  db.prepare(`UPDATE subtitle SET orderNumber = ?, updatedAt = datetime('now') WHERE id = ?`).run(b.orderNumber, a.id)
  db.prepare(`UPDATE subtitle SET orderNumber = ?, updatedAt = datetime('now') WHERE id = ?`).run(a.orderNumber, b.id)

  return { success: true, msg: null }
}

export const moveSeriesInQueue = (
  db: Database.Database,
  user: DBUser,
  mediaItemId: number,
  direction: "up" | "down",
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canChangeSubtitlePriority")
  if (!perm) return { success: false, msg: "User does not have permission to manage subtitles" }

  const all = db
    .prepare(
      `SELECT * FROM subtitle WHERE deletedAt IS NULL AND status NOT IN ('completed','cancelled','failed') ORDER BY orderNumber ASC`,
    )
    .all() as DBSubtitle[]

  if (all.length === 0) return { success: true, msg: null }

  const blockMap = new Map<string, { mediaItemId: number | null; subs: DBSubtitle[] }>()
  const blockOrder: string[] = []
  for (const s of all) {
    const key = s.mediaItemId != null ? `m${s.mediaItemId}` : `s${s.id}`
    if (!blockMap.has(key)) {
      blockMap.set(key, { mediaItemId: s.mediaItemId, subs: [] })
      blockOrder.push(key)
    }
    blockMap.get(key)!.subs.push(s)
  }

  const idx = blockOrder.findIndex((k) => blockMap.get(k)!.mediaItemId === mediaItemId)
  if (idx === -1) return { success: false, msg: "Series not found in active queue" }

  const swapIdx = direction === "up" ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= blockOrder.length) return { success: true, msg: null }
  ;[blockOrder[idx], blockOrder[swapIdx]] = [blockOrder[swapIdx], blockOrder[idx]]

  const update = db.prepare(`UPDATE subtitle SET orderNumber = ?, updatedAt = datetime('now') WHERE id = ?`)
  let order = 1
  db.transaction(() => {
    for (const k of blockOrder) {
      for (const s of blockMap.get(k)!.subs) {
        update.run(order++, s.id)
      }
    }
  })()

  return { success: true, msg: null }
}

// Dashboard/poll payload. Only `subtitles` + `languageMap` are consumed (the
// dashboard route and public/app.js renderQueue — see DATABASE_ASSESSMENT.md).
// The earlier version also shipped every subtitleJob row (with full
// translatedText — 543 MB of text in the production DB) and full mediaItem
// rows in every 15s poll, plus O(n×m) JS joins. Jobs now return only the
// fields the queue render needs; hasTranslation is computed in SQL so no
// translatedText ever leaves the DB.
export const getDashboardData = (db: Database.Database) => {
  const subtitles = db
    .prepare(
      `SELECT id, userId, sourceLangId, mediaItemId, libraryPathItem, name, originalFileHash, originalTextSRTName,
              orderNumber, whisperOrderNumber, hide, source, sourcePath, mediaPath, status, whisperTranscriptionStatus,
              whisperModel, whisperTimestampsLength, whisperUseCuda, whisperProgress,
              finishedAt, cancelledAt, cancelledByUserId, deletedAt, deletedByUserId, createdAt, updatedAt
       FROM subtitle WHERE deletedAt IS NULL AND hide = 0 ORDER BY orderNumber ASC, createdAt DESC`,
    )
    .all() as Omit<DBSubtitle, "originalText">[]

  const languages = getLanguages(db)
  const languageMap = Object.fromEntries(languages.map((l) => [l.id, l]))

  const jobs = db
    .prepare(
      `SELECT id, subtitleId, targetLangId, status, season, episode,
              CASE WHEN translatedText IS NOT NULL AND TRIM(translatedText) <> '' THEN 1 ELSE 0 END AS hasTranslation
       FROM subtitleJob WHERE deletedAt IS NULL ORDER BY orderNumber ASC`,
    )
    .all() as {
      id: number
      subtitleId: number
      targetLangId: number
      status: DBSubtitleJob["status"]
      season: number | null
      episode: number | null
      hasTranslation: number
    }[]

  const chunkCounts = db
    .prepare(
      `SELECT subtitleJobId,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM subtitleChunk GROUP BY subtitleJobId`,
    )
    .all() as { subtitleJobId: number; total: number; done: number; failed: number }[]
  const chunkCountMap = Object.fromEntries(chunkCounts.map((c) => [c.subtitleJobId, c]))

  // Map-based joins instead of O(n×m) filter/find per subtitle.
  const jobsBySubtitle = new Map<number, typeof jobs>()
  for (const j of jobs) {
    const list = jobsBySubtitle.get(j.subtitleId) || []
    list.push(j)
    jobsBySubtitle.set(j.subtitleId, list)
  }
  const mediaTitles = new Map(
    (db.prepare(`SELECT id, title FROM mediaItem`).all() as { id: number; title: string }[]).map(
      (r) => [r.id, r.title],
    ),
  )

  const enrichedSubtitles = subtitles.map((s) => {
    const sJobs = jobsBySubtitle.get(s.id) ?? []
    const firstJob = sJobs[0]
    const targets = sJobs.map((j) => {
      const counts = chunkCountMap[j.id] ?? { total: 0, done: 0, failed: 0 }
      return {
        targetLangId: j.targetLangId,
        total: counts.total,
        done: counts.done,
        failed: counts.failed,
        jobId: j.id,
        jobStatus: j.status,
        hasTranslation: j.hasTranslation === 1,
      }
    })
    return {
      ...s,
      season: firstJob?.season ?? null,
      episode: firstJob?.episode ?? null,
      targets,
      mediaItemTitle: mediaTitles.get(s.mediaItemId ?? 0) ?? null,
    }
  })

  return { subtitles: enrichedSubtitles, languageMap }
}

// One page of finished/failed translations for the Translated page. Server-
// side paginated so the page only fetches the rows it renders (LIMIT/OFFSET),
// not the whole history. Ordered by descending terminal timestamp (finishedAt
// for completed, updatedAt for failed) so the newest results come first. A
// LEFT JOIN on mediaItem keeps translations whose subtitle never matched a
// media item (e.g. failed uploads) visible too.
export const getFinishedSubtitlesPage = (
  db: Database.Database,
  opts: { page: number; pageSize: number },
): { items: FinishedSubtitle[]; total: number; page: number; totalPages: number } => {
  const pageSize = Math.max(1, opts.pageSize)

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM subtitleJob sj
         WHERE sj.status IN ('completed', 'failed') AND sj.deletedAt IS NULL`,
      )
      .get() as { c: number }
  ).c

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  // Clamp the requested 0-based page into range so an out-of-bounds request
  // (e.g. ?page=999, or the last page emptying after a delete) shows the last
  // valid page instead of a misleading "no subtitles" empty state.
  const page = Math.min(Math.max(0, opts.page), totalPages - 1)
  const offset = page * pageSize

  const items = db
    .prepare(
      `SELECT
        s.id as subtitleId,
        sj.id as jobId,
        s.name as subtitleName,
        l.name as targetLang,
        srcL.name as sourceLang,
        sj.season as season,
        sj.episode as episode,
        m.mediaItemPhotoPath as mediaItemPhotoPath,
        m.year as year,
        sj.status as status,
        sj.finishedAt as finishedAt,
        (SELECT sc.startedAt FROM subtitleChunk sc WHERE sc.subtitleJobId = sj.id ORDER BY sc.chunkIndex ASC LIMIT 1) as earliestChunkStartedAt
      FROM subtitleJob sj
      INNER JOIN subtitle s ON sj.subtitleId = s.id
      INNER JOIN language l ON sj.targetLangId = l.id
      INNER JOIN language srcL ON s.sourceLangId = srcL.id
      LEFT JOIN mediaItem m ON s.mediaItemId = m.id
      WHERE sj.status IN ('completed', 'failed')
        AND sj.deletedAt IS NULL
      ORDER BY COALESCE(sj.finishedAt, sj.updatedAt) DESC, sj.id DESC
      LIMIT ? OFFSET ?`,
    )
    .all(pageSize, offset) as FinishedSubtitle[]

  return { items, total, page, totalPages }
}

// Remove a single completed/failed translation row from the Translated page
// (soft-delete the job). The subtitle and its other target-language jobs are
// left intact. Gated on the same canDeleteTranslation permission as the
// dashboard's per-subtitle delete. Also cancels any still-active chunks so the
// worker never picks them up after the job is marked deleted (the chunk queue
// filters on chunk status, not job.deletedAt) — important when this is used to
// delete an active job via the dashboard bulk cancel/delete flow.
export const softDeleteSubtitleJob = (db: Database.Database, user: DBUser, jobId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canDeleteTranslation")
  if (!perm) return { success: false, msg: "Permission denied" }

  const job = getSubtitleJobById(db, jobId)
  if (!job) return { success: false, msg: "Translation not found" }

  db.transaction(() => {
    db.prepare(
      `UPDATE subtitleJob SET deletedAt = datetime('now'), deletedByUserId = ?, updatedAt = datetime('now') WHERE id = ?`,
    ).run(user.id, jobId)
    // Cancel any still-active chunks so the worker stops processing this job.
    db.prepare(
      `UPDATE subtitleChunk SET status = 'cancelled', updatedAt = datetime('now') WHERE subtitleJobId = ? AND status NOT IN ('completed', 'cancelled')`,
    ).run(jobId)
  })()

  createLog(db, "info", "subtitleDelete", "subtitle", job.subtitleId, "Removed translation from Translated page", {
    jobId,
    removedBy: user.id,
  })
  return { success: true, msg: null }
}

export const getSubtitlesWithLang = (db: Database.Database) => {
  return db
    .prepare(
      `SELECT s.id,
              COALESCE(mi.title, s.name) as displayName,
              s.name as fileName,
              l.name as sourceLangName,
              sjmin.season as season,
              sjmin.episode as episode,
              s.createdAt
       FROM subtitle s
       INNER JOIN language l ON s.sourceLangId = l.id
       LEFT JOIN mediaItem mi ON s.mediaItemId = mi.id
       -- MIN(season)/MIN(episode) per subtitle in one grouped pass instead of
       -- two correlated subqueries per row (subtitleJob.subtitleId is indexed
       -- via its UNIQUE(subtitleId, targetLangId) constraint).
       LEFT JOIN (
         SELECT subtitleId, MIN(season) as season, MIN(episode) as episode
         FROM subtitleJob
         GROUP BY subtitleId
       ) sjmin ON sjmin.subtitleId = s.id
       WHERE s.deletedAt IS NULL
         -- "has at least one completed chunk": a single pass over completed
         -- chunks (idx_subtitleChunk_status) joined to subtitleJob by PK,
         -- instead of a per-row EXISTS. Keeps the returned shape identical.
         AND s.id IN (
           SELECT sj.subtitleId
           FROM subtitleJob sj
           INNER JOIN subtitleChunk sc ON sc.subtitleJobId = sj.id
           WHERE sc.status = 'completed'
         )
       ORDER BY s.createdAt DESC`,
    )
    .all() as {
    id: number
    displayName: string
    fileName: string
    sourceLangName: string
    season: number | null
    episode: number | null
    createdAt: string
  }[]
}

export const reorderSubtitles = (db: Database.Database, user: DBUser, orderedIds: number[]): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canChangeSubtitlePriority")
  if (!hasPermission) return { success: false, msg: "User does not have permission to manage subtitles" }
  const stmt = db.prepare(`UPDATE subtitle SET orderNumber = ?, updatedAt = datetime('now') WHERE id = ?`)
  const run = db.transaction(() => orderedIds.forEach((id, idx) => stmt.run((idx + 1) * 10, id)))
  run()
  return { success: true, msg: null }
}

// Whisper-queue reordering — operates on `whisperOrderNumber` among
// whisper-source subtitles still in the transcription stage, independent of
// the translation queue's `orderNumber`.
export const moveWhisperSubtitleInQueue = (
  db: Database.Database,
  user: DBUser,
  subtitleId: number,
  direction: "up" | "down",
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canChangeSubtitlePriority")
  if (!perm) return { success: false, msg: "User does not have permission to manage subtitles" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle || subtitle.source !== "whisper") return { success: false, msg: "Subtitle not found" }

  const others = db
    .prepare(
      `SELECT * FROM subtitle
       WHERE source = 'whisper' AND deletedAt IS NULL
         AND status NOT IN ('completed','cancelled','failed')
         AND whisperTranscriptionStatus NOT IN ('transcription_completed','transcription_failed')
       ORDER BY COALESCE(whisperOrderNumber, orderNumber) ASC, id ASC`,
    )
    .all() as DBSubtitle[]

  const idx = others.findIndex((s) => s.id === subtitleId)
  if (idx === -1) return { success: false, msg: "Subtitle not in whisper queue" }

  const swapIdx = direction === "up" ? idx - 1 : idx + 1
  if (swapIdx < 0 || swapIdx >= others.length) return { success: true, msg: null }

  const a = others[idx]
  const b = others[swapIdx]
  const aOrder = a.whisperOrderNumber ?? a.orderNumber
  const bOrder = b.whisperOrderNumber ?? b.orderNumber

  db.prepare(`UPDATE subtitle SET whisperOrderNumber = ?, updatedAt = datetime('now') WHERE id = ?`).run(bOrder, a.id)
  db.prepare(`UPDATE subtitle SET whisperOrderNumber = ?, updatedAt = datetime('now') WHERE id = ?`).run(aOrder, b.id)

  return { success: true, msg: null }
}

export const reorderWhisperSubtitles = (
  db: Database.Database,
  user: DBUser,
  orderedIds: number[],
): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canChangeSubtitlePriority")
  if (!hasPermission) return { success: false, msg: "User does not have permission to manage subtitles" }
  const stmt = db.prepare(`UPDATE subtitle SET whisperOrderNumber = ?, updatedAt = datetime('now') WHERE id = ?`)
  const run = db.transaction(() => orderedIds.forEach((id, idx) => stmt.run((idx + 1) * 10, id)))
  run()
  return { success: true, msg: null }
}

// Move a whisper-queue subtitle straight to the top so the worker transcribes it next. This is
// the "change which one to whisper at the current time" action: the route follows up by calling
// preemptWorker(), which kills the in-progress transcription so the loop picks this one up.
export const moveWhisperSubtitleToTop = (
  db: Database.Database,
  user: DBUser,
  subtitleId: number,
): DefaultResponse => {
  const { hasPermission } = userHasPermission(db, user.id, "canChangeSubtitlePriority")
  if (!hasPermission) return { success: false, msg: "User does not have permission to manage subtitles" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle || subtitle.source !== "whisper") return { success: false, msg: "Subtitle not found" }

  const minRow = db
    .prepare(
      `SELECT MIN(COALESCE(whisperOrderNumber, orderNumber)) as minOrd FROM subtitle
       WHERE source = 'whisper' AND deletedAt IS NULL
         AND status NOT IN ('completed','cancelled','failed')
         AND whisperTranscriptionStatus NOT IN ('transcription_completed','transcription_failed')`,
    )
    .get() as { minOrd: number | null }
  const minOrd = minRow?.minOrd ?? 0
  // Slot below the current minimum so this item sorts first. -10 leaves room for future inserts.
  db.prepare(`UPDATE subtitle SET whisperOrderNumber = ?, updatedAt = datetime('now') WHERE id = ?`).run(
    minOrd - 10,
    subtitleId,
  )

  return { success: true, msg: null }
}

export const getJobChunkStatsData = (db: Database.Database, jobId: number) => {
  return db
    .prepare(
      `SELECT
         sc.id,
         sc.chunkIndex,
         sc.status,
         sc.judgeReason,
         sc.durationMs,
         sc.retryCount,
         (SELECT COUNT(*) FROM subtitleChunkCandidate c2 WHERE c2.subtitleChunkId = sc.id AND c2.status = 'completed') as validCandidateCount,
         (SELECT COUNT(*) FROM subtitleChunkCandidate c3 WHERE c3.subtitleChunkId = sc.id) as totalCandidateCount,
         m.name as selectedModelName,
         p.name as selectedPromptName,
         pv.version as selectedPromptVersion
       FROM subtitleChunk sc
       LEFT JOIN subtitleChunkCandidate scc ON sc.selectedCandidateId = scc.id
       LEFT JOIN model m ON scc.modelId = m.id
       LEFT JOIN promptVersion pv ON scc.promptVersionId = pv.id
       LEFT JOIN prompt p ON pv.promptId = p.id
       WHERE sc.subtitleJobId = ?
       ORDER BY sc.chunkIndex ASC`,
    )
    .all(jobId) as {
    id: number
    chunkIndex: number
    status: string
    judgeReason: string | null
    durationMs: number | null
    retryCount: number
    validCandidateCount: number
    totalCandidateCount: number
    selectedModelName: string | null
    selectedPromptName: string | null
    selectedPromptVersion: number | null
  }[]
}

export const getModelCandidateStats = (db: Database.Database, modelId: number) => {
  const overall = db
    .prepare(
      `SELECT
         COUNT(*) as totalCandidates,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successCount,
         SUM(CASE WHEN status IN ('failed','validation_failed') THEN 1 ELSE 0 END) as failedCount,
         SUM(CASE WHEN selected = 1 THEN 1 ELSE 0 END) as selectedCount,
         AVG(CASE WHEN durationMs IS NOT NULL THEN durationMs ELSE NULL END) as avgDurationMs
       FROM subtitleChunkCandidate
       WHERE modelId = ?`,
    )
    .get(modelId) as {
    totalCandidates: number
    successCount: number
    failedCount: number
    selectedCount: number
    avgDurationMs: number | null
  }

  const byPrompt = db
    .prepare(
      `SELECT
         COALESCE(p.name, 'Unknown') as promptName,
         COUNT(*) as totalCandidates,
         SUM(CASE WHEN scc.selected = 1 THEN 1 ELSE 0 END) as selectedCount,
         AVG(scc.durationMs) as avgDurationMs
       FROM subtitleChunkCandidate scc
       LEFT JOIN promptVersion pv ON scc.promptVersionId = pv.id
       LEFT JOIN prompt p ON pv.promptId = p.id
       WHERE scc.modelId = ?
       GROUP BY p.id, p.name
       ORDER BY selectedCount DESC`,
    )
    .all(modelId) as {
    promptName: string
    totalCandidates: number
    selectedCount: number
    avgDurationMs: number | null
  }[]

  const byLanguage = db
    .prepare(
      `SELECT
         l.name as languageName,
         COUNT(*) as totalCandidates,
         SUM(CASE WHEN scc.selected = 1 THEN 1 ELSE 0 END) as selectedCount,
         AVG(scc.durationMs) as avgDurationMs
       FROM subtitleChunkCandidate scc
       JOIN subtitleChunk sc ON scc.subtitleChunkId = sc.id
       JOIN language l ON sc.targetLangId = l.id
       WHERE scc.modelId = ?
       GROUP BY l.id, l.name
       ORDER BY selectedCount DESC`,
    )
    .all(modelId) as {
    languageName: string
    totalCandidates: number
    selectedCount: number
    avgDurationMs: number | null
  }[]

  return { overall, byPrompt, byLanguage }
}

export const getExportFileName = (
  title: string,
  season: number | null,
  episode: number | null,
  year: number | null,
  langCode: string,
  format: SubtitleFormat = "srt",
) => {
  let fileName = `[BCookieSub]${title}`
  if (season !== null && episode !== null) {
    fileName += `.S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`
  }
  if (year !== null) {
    fileName += `.(${year})`
  }
  if (langCode) {
    fileName += `.${langCode}`
  }
  fileName += subtitleExportExtension(format)
  return fileName
}

export const hideSubtitle = (db: Database.Database, user: DBUser, subtitleId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canChangeSubtitlePriority")
  if (!perm) return { success: false, msg: "User does not have permission to manage subtitles" }

  const subtitle = getSubtitleById(db, subtitleId)
  if (!subtitle) return { success: false, msg: "Subtitle not found" }

  db.prepare(`UPDATE subtitle SET hide = 1, updatedAt = datetime('now') WHERE id = ?`).run(subtitleId)

  createLog(db, "info", "subtitle", "subtitle", subtitleId, "Hidden subtitle from dashboard", { hiddenBy: user.id })
  return { success: true, msg: null }
}

export const getNextQueuedChunkForWorker = (
  db: Database.Database,
  finishSingleSubtitleFirst: boolean,
): DBSubtitleChunk | null => {
  if (finishSingleSubtitleFirst) {
    const runningSubtitle = db
      .prepare(`SELECT * FROM subtitle WHERE status = 'running' AND deletedAt IS NULL ORDER BY orderNumber ASC LIMIT 1`)
      .get() as DBSubtitle | undefined

    if (runningSubtitle) {
      const chunk = db
        .prepare(
          `SELECT sc.* FROM subtitleChunk sc
           JOIN subtitleJob sj ON sc.subtitleJobId = sj.id
           WHERE sc.subtitleId = ? AND sc.status = 'queued' AND sj.status NOT IN ('cancelled', 'completed', 'failed')
           ORDER BY sj.orderNumber ASC, sc.chunkIndex ASC
           LIMIT 1`,
        )
        .get(runningSubtitle.id) as DBSubtitleChunk | undefined
      if (chunk) return chunk
    }
  }

  return (
    (db
      .prepare(
        `SELECT sc.* FROM subtitleChunk sc
         JOIN subtitleJob sj ON sc.subtitleJobId = sj.id
         JOIN subtitle s ON sc.subtitleId = s.id
         WHERE sc.status = 'queued'
           AND sj.status NOT IN ('cancelled', 'completed', 'failed')
           AND s.status NOT IN ('cancelled', 'completed', 'failed', 'paused')
           AND s.deletedAt IS NULL
         ORDER BY s.orderNumber ASC, sj.orderNumber ASC, sc.chunkIndex ASC
         LIMIT 1`,
      )
      .get() as DBSubtitleChunk | undefined) ?? null
  )
}

export const updateChunkStatus = (
  db: Database.Database,
  chunkId: number,
  status: DBSubtitleChunk["status"],
  errorMessage: string | null = null,
): void => {
  db.prepare(`UPDATE subtitleChunk SET status = ?, errorMessage = ?, updatedAt = datetime('now') WHERE id = ?`).run(
    status,
    errorMessage,
    chunkId,
  )
}

export const markChunkStarted = (db: Database.Database, chunkId: number): void => {
  db.prepare(
    `UPDATE subtitleChunk SET status = 'running', startedAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?`,
  ).run(chunkId)
}

export const setSelectedCandidateForChunk = (
  db: Database.Database,
  chunkId: number,
  candidateId: number,
  judgeModelId: number | null,
  judgeReason: string | null,
  durationMs: number,
): void => {
  db.prepare(
    `UPDATE subtitleChunk SET
       status = 'completed',
       selectedCandidateId = ?,
       judgeModelId = ?,
       judgeReason = ?,
       durationMs = ?,
       finishedAt = datetime('now'),
       updatedAt = datetime('now')
     WHERE id = ?`,
  ).run(candidateId, judgeModelId, judgeReason, durationMs, chunkId)
}

// Mark a chunk completed without selecting any candidate — used when an ASS
// chunk contains no translatable text (every line is a pure vector drawing or
// only override tags). selectedCandidateId stays NULL so assembly skips it and
// the serializer copies those lines verbatim from the original.
export const markChunkCompletedNoCandidate = (
  db: Database.Database,
  chunkId: number,
  judgeReason: string,
): void => {
  db.prepare(
    `UPDATE subtitleChunk SET
       status = 'completed',
       selectedCandidateId = NULL,
       judgeReason = ?,
       finishedAt = datetime('now'),
       updatedAt = datetime('now')
     WHERE id = ?`,
  ).run(judgeReason, chunkId)
}

// promptTextSnapshot is no longer populated (write-only: 673 MB of prompt
// snapshots in production, never SELECTed — see DATABASE_ASSESSMENT.md);
// callers pass null and old rows are cleared by db maintenance.
export const createChunkCandidate = (
  db: Database.Database,
  subtitleChunkId: number,
  modelId: number,
  promptId: number,
  promptVersionId: number,
  promptTextSnapshot: string | null,
  translatedText: string | null,
  validationPassed: boolean,
  status: DBSubtitleChunkCandidate["status"],
  durationMs: number,
  errorMessage: string | null,
): number => {
  const existing = db
    .prepare(`SELECT * FROM subtitleChunkCandidate WHERE subtitleChunkId = ? AND modelId = ? AND promptVersionId = ?`)
    .get(subtitleChunkId, modelId, promptVersionId) as DBSubtitleChunkCandidate | undefined

  if (existing) {
    db.prepare(
      `UPDATE subtitleChunkCandidate SET
         promptTextSnapshot = ?, translatedText = ?,
         validationPassed = ?, status = ?, retryCount = retryCount + 1,
         durationMs = ?, errorMessage = ?, updatedAt = datetime('now')
       WHERE id = ?`,
    ).run(promptTextSnapshot, translatedText, validationPassed ? 1 : 0, status, durationMs, errorMessage, existing.id)
    return existing.id
  }

  const result = db
    .prepare(
      `INSERT INTO subtitleChunkCandidate
         (subtitleChunkId, modelId, promptId, promptVersionId, promptTextSnapshot, translatedText, validationPassed, status, selected, durationMs, errorMessage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      subtitleChunkId,
      modelId,
      promptId,
      promptVersionId,
      promptTextSnapshot,
      translatedText,
      validationPassed ? 1 : 0,
      status,
      durationMs,
      errorMessage,
    )

  return result.lastInsertRowid as number
}

export const deleteUnneededCandidates = (db: Database.Database, subtitleChunkId: number): number => {
  const result = db
    .prepare(
      `DELETE FROM subtitleChunkCandidate
       WHERE subtitleChunkId = ?
         AND selected = 0
         AND status NOT IN ('failed', 'validation_failed')`,
    )
    .run(subtitleChunkId)
  return result.changes
}

export const markCandidateSelected = (db: Database.Database, candidateId: number): void => {
  db.prepare(
    `UPDATE subtitleChunkCandidate SET selected = 1, status = 'completed', updatedAt = datetime('now') WHERE id = ?`,
  ).run(candidateId)
}

export const updateSubtitleStatus = (db: Database.Database, subtitleId: number, status: DBSubtitle["status"]): void => {
  const extra =
    status === "completed"
      ? `, finishedAt = datetime('now')`
      : status === "cancelled"
        ? `, cancelledAt = datetime('now')`
        : ""
  db.prepare(`UPDATE subtitle SET status = ?${extra}, updatedAt = datetime('now') WHERE id = ?`).run(status, subtitleId)
}

export const updateSubtitleJobStatus = (
  db: Database.Database,
  jobId: number,
  status: DBSubtitleJob["status"],
): void => {
  const extra = status === "completed" ? `, finishedAt = datetime('now')` : ""
  db.prepare(`UPDATE subtitleJob SET status = ?${extra}, updatedAt = datetime('now') WHERE id = ?`).run(status, jobId)
}

export const updateSubtitleJobProgress = (db: Database.Database, jobId: number, chunkCurrent: number): void => {
  db.prepare(`UPDATE subtitleJob SET chunkCurrent = ?, updatedAt = datetime('now') WHERE id = ?`).run(
    chunkCurrent,
    jobId,
  )
}

export const incrementChunkRetry = (db: Database.Database, chunkId: number, errorMessage: string | null): void => {
  db.prepare(`DELETE FROM subtitleChunkCandidate WHERE subtitleChunkId = ?`).run(chunkId)
  db.prepare(
    `UPDATE subtitleChunk SET retryCount = retryCount + 1, errorMessage = ?, status = 'queued', selectedCandidateId = NULL, updatedAt = datetime('now') WHERE id = ?`,
  ).run(errorMessage, chunkId)
}

export const resetChunk = (db: Database.Database, chunkId: number): void => {
  // Reset the chunk itself, then — if the parent job/subtitle are already in a
  // terminal state (completed/failed/cancelled) — pull them back to 'queued' so
  // the worker actually re-picks this chunk. Without that, resetting a chunk on
  // a finished movie/episode is a no-op: getNextQueuedChunkForWorker skips
  // chunks whose job or subtitle is completed, so the chunk would sit forever.
  // Re-running the chunk re-assembles the job and re-finalizes the subtitle
  // (checkAndFinalizeJob / checkAndFinalizeSubtitle) when it completes again.
  const run = db.transaction(() => {
    const chunk = db
      .prepare(`SELECT subtitleId, subtitleJobId FROM subtitleChunk WHERE id = ?`)
      .get(chunkId) as { subtitleId: number; subtitleJobId: number } | undefined

    db.prepare(`DELETE FROM subtitleChunkCandidate WHERE subtitleChunkId = ?`).run(chunkId)
    db.prepare(
      `UPDATE subtitleChunk SET status = 'queued', retryCount = 0, startedAt = NULL, finishedAt = NULL, errorMessage = NULL, selectedCandidateId = NULL, updatedAt = datetime('now') WHERE id = ?`,
    ).run(chunkId)

    if (!chunk) return

    const job = db.prepare(`SELECT status FROM subtitleJob WHERE id = ?`).get(chunk.subtitleJobId) as
      | { status: string }
      | undefined
    if (job && (job.status === "completed" || job.status === "failed" || job.status === "cancelled")) {
      // chunkCurrent reflects the other still-completed chunks (the reset one
      // no longer counts). Clear the assembled output so a stale translation
      // isn't served while the chunk re-runs.
      const completedChunks = countCompletedChunks(db, chunk.subtitleJobId)
      db.prepare(
        `UPDATE subtitleJob SET status = 'queued', chunkCurrent = ?, translatedText = NULL, outputFilePath = NULL, outputHash = NULL, finishedAt = NULL, cancelledAt = NULL, updatedAt = datetime('now') WHERE id = ?`,
      ).run(completedChunks, chunk.subtitleJobId)
    }

    const sub = db.prepare(`SELECT status FROM subtitle WHERE id = ?`).get(chunk.subtitleId) as
      | { status: string }
      | undefined
    if (sub && (sub.status === "completed" || sub.status === "failed" || sub.status === "cancelled")) {
      db.prepare(
        `UPDATE subtitle SET status = 'queued', finishedAt = NULL, cancelledAt = NULL, updatedAt = datetime('now') WHERE id = ?`,
      ).run(chunk.subtitleId)
    }
  })
  run()
}

export const retryFailedChunk = (db: Database.Database, chunkId: number): void => {
  db.prepare(`DELETE FROM subtitleChunkCandidate WHERE subtitleChunkId = ?`).run(chunkId)
  db.prepare(
    `UPDATE subtitleChunk SET retryCount = 0, errorMessage = NULL, status = 'queued', selectedCandidateId = NULL, finishedAt = NULL, updatedAt = datetime('now') WHERE id = ?`,
  ).run(chunkId)
}

export const markChunkFailed = (db: Database.Database, chunkId: number, errorMessage: string): void => {
  db.prepare(
    `UPDATE subtitleChunk SET status = 'failed', errorMessage = ?, finishedAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?`,
  ).run(errorMessage, chunkId)
}

export const assembleAndFinishSubtitleJob = (
  db: Database.Database,
  job: DBSubtitleJob,
  subtitle: DBSubtitle,
  outputDir: string | null,
): void => {
  const chunks = getChunksByJobId(db, job.id)

  // Collect translated rows across chunks in chunkIndex order. For SRT this
  // ordering drives the 1..N renumbering; for ASS/SSA each row is mapped back
  // to its original line position by the serializer, so order is irrelevant.
  const allRows: { id: string; text: string }[] = []

  for (const chunk of chunks.sort((a, b) => a.chunkIndex - b.chunkIndex)) {
    if (!chunk.selectedCandidateId) continue

    const candidate = db.prepare(`SELECT * FROM subtitleChunkCandidate WHERE id = ?`).get(chunk.selectedCandidateId) as
      | DBSubtitleChunkCandidate
      | undefined

    if (!candidate?.translatedText) continue

    let rows: { id: string; text: string }[] = []
    try {
      rows = JSON.parse(candidate.translatedText)
    } catch {
      const parsed = parseLLMResponse(candidate.translatedText)
      if (parsed) rows = parsed.rows
    }

    for (const row of rows) {
      allRows.push({ id: row.id, text: row.text })
    }
  }

  // Serialize in the subtitle's original format. The original file structure
  // (timing, styles, non-dialogue lines) is recovered from subtitle.originalText.
  const translatedText = serializeSubtitle(subtitle.originalText, allRows, subtitle.sourceFormat)
  let outputFilePath: string | null = null

  const outputHash = translatedText ? getFileHash(translatedText) : null

  db.prepare(
    `UPDATE subtitleJob SET status = 'completed', translatedText = ?, outputFilePath = ?, outputHash = ?, finishedAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?`,
  ).run(translatedText || null, outputFilePath, outputHash, job.id)

  createLog(db, "info", "subtitleJobCompleted", "subtitleJob", job.id, "Subtitle job completed", {
    targetLangId: job.targetLangId,
    outputFilePath,
  })
}
