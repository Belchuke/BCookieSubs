import Database from "better-sqlite3"
import { DBUser, DBLanguage } from "../types/dbTypes"
import { NameFormatterResult, TheMovieDBRequestResult } from "../types/modelTypes"
import { getConfig } from "./configRepository"
import { getActiveModelsByRole } from "./modelRepository"
import { sendPrompt } from "./ollamaRepository"
import { getNameFormatterPromptVersion, getTheMovieDbMatcherPromptVersion } from "./promptRepository"
import { searchMediaItemInTheMovieDb } from "./movieDbRepository"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"

export const formatTranslationPrompt = (
  promptText: string,
  sourceLang: DBLanguage,
  targetLang: DBLanguage,
  mediaItemName: string,
  genres: string | null,
  mediaType: string,
  chunkXml: string,
): string => {
  return (
    promptText
      .replaceAll("//sourceLang//", sourceLang.name)
      .replaceAll("//sourceShortLang//", sourceLang.iso639)
      .replaceAll("//targetLang//", targetLang.name)
      .replaceAll("//targetShortLang//", targetLang.iso639)
      .replaceAll("//genres//", genres || "unknown")
      .replaceAll("//mediaType//", mediaType)
      .replaceAll("//name//", mediaItemName) +
    "\n\n" +
    chunkXml
  )
}

export const formatJudgePrompt = (
  promptText: string,
  sourceLang: DBLanguage,
  targetLang: DBLanguage,
  mediaItemName: string,
  sourceChunkXml: string,
  genres: string | null,
  mediaType: string,
  candidates: { index: number; translatedRows: { id: string; text: string }[] }[],
): string => {
  const candidateList = candidates
    .map((c, i) => {
      const text = c.translatedRows.map((r) => `[${r.id}] ${r.text}`).join("\n")
      return `Candidate ${i}:\n${text}`
    })
    .join("\n\n")

  return promptText
    .replaceAll("//sourceLang//", sourceLang.name)
    .replaceAll("//targetLang//", targetLang.name)
    .replaceAll("//name//", mediaItemName)
    .replaceAll("//sourceText//", sourceChunkXml)
    .replaceAll("//total//", String(candidates.length))
    .replaceAll("//totalMinusOne//", String(candidates.length - 1))
    .replaceAll("//candidateList//", candidateList)
    .replaceAll("//genres//", genres || "unknown")
    .replaceAll("//mediaType//", mediaType)
}

export const insertJudgeEvaluation = (
  db: Database.Database,
  subtitleChunkId: number,
  modelId: number | null,
  judgeInput: string,
  selectedCandidateId: number | null,
  judgeReason: string | null,
): void => {
  db.prepare(
    `INSERT INTO judgeEvaluation (subtitleChunkId, modelId, judgeInput, selectedCandidateId, judgeReason, createdAt) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(subtitleChunkId, modelId, judgeInput, selectedCandidateId, judgeReason)
}

export const getJudgeEvaluations = (
  db: Database.Database,
  modelId: number | null = null,
  limit = 30,
  offset = 0,
): {
  rows: {
    id: number
    subtitleChunkId: number
    modelId: number | null
    modelName: string | null
    judgeInput: string
    judgeReason: string | null
    createdAt: string
    chunkIndex: number | null
    subtitleName: string | null
  }[]
  total: number
} => {
  const base = `
    SELECT je.id, je.subtitleChunkId, je.modelId,
           m.name AS modelName,
           je.judgeInput, je.judgeReason, je.createdAt,
           sc.chunkIndex, s.name AS subtitleName
    FROM judgeEvaluation je
    LEFT JOIN model m ON je.modelId = m.id
    LEFT JOIN subtitleChunk sc ON je.subtitleChunkId = sc.id
    LEFT JOIN subtitle s ON sc.subtitleId = s.id`
  if (modelId) {
    const total = (
      db.prepare(`SELECT COUNT(*) as cnt FROM judgeEvaluation je WHERE je.modelId = ?`).get(modelId) as any
    ).cnt as number
    const rows = db
      .prepare(`${base} WHERE je.modelId = ? ORDER BY je.createdAt DESC LIMIT ? OFFSET ?`)
      .all(modelId, limit, offset) as any[]
    return { rows, total }
  }
  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM judgeEvaluation je`).get() as any).cnt as number
  const rows = db.prepare(`${base} ORDER BY je.createdAt DESC LIMIT ? OFFSET ?`).all(limit, offset) as any[]
  return { rows, total }
}

export const getSubtitleItemMediaItemFromPrompt = async (
  db: Database.Database,
  user: DBUser,
  fileName: string,
  forcedType: "movie" | "series" | null = null,
): Promise<NameFormatterResult | null> => {
  if (!fileName) return null

  const config = getConfig(db)
  if (!config.nameDetectionActive) return null

  const permission = userHasPermission(db, user.id, "canAddSubtitleToTranslateDashboard")
  if (!permission.hasPermission) return null

  const models = getActiveModelsByRole(db, "nameFormatter")
  if (models.length === 0) return null

  const promptVersion = getNameFormatterPromptVersion(db)
  if (!promptVersion) return null

  const finishedPrompt = promptVersion.promptText.replaceAll("//filename//", fileName)

  try {
    const response = await sendPrompt(db, models[0], finishedPrompt)
    const jsonMatch = response.message.content.match(/\{[\s\S]*\}/)

    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0]) as NameFormatterResult

    // The library path already declares whether this is a movie or a series, so
    // trust that over the name formatter's guess. A series-root folder name
    // (e.g. "The Last of Us") has no season/episode markers, so the formatter's
    // "no markers -> movie" rule would otherwise send the search to the /movie
    // endpoint and miss the TV show entirely.
    const searchType = forcedType ?? parsed.type
    const search = await searchMediaItemInTheMovieDb(db, parsed.name, searchType, parsed.year)
    if (search.success && search.items.length > 0) {
      parsed.theMovieDbRequestResult = search.items
    }
    return parsed
  } catch (error) {
    createLog(
      db,
      "error",
      "nameFormatter", "nameFormatter",
      null,
      `Name formatter failed for "${fileName}": ${String(error).slice(0, 200)}`,
      { fileName, error: String(error) },
    )
    return null
  }
}

export const formatTheMovieDbMatcherPrompt = (
  promptText: string,
  fileName: string,
  candidates: TheMovieDBRequestResult[],
): string => {
  const candidateList = JSON.stringify(
    candidates.map((c) => ({
      id: c.id,
      title: c.name,
      original_title: c.originalTitle,
      release_date: c.releaseDate,
      media_type: "movie | tv",
    })),
  )
  return promptText.replaceAll("//filename//", fileName).replaceAll("//TheMovieDBCandidate//", candidateList)
}

export const selectBestTheMovieDbMatch = async (
  db: Database.Database,
  user: DBUser,
  fileName: string,
  candidates: TheMovieDBRequestResult[],
): Promise<TheMovieDBRequestResult | null> => {
  if (!fileName || candidates.length === 0) return null

  const config = getConfig(db)
  if (!config.nameDetectionActive) return null

  const permission = userHasPermission(db, user.id, "canAddSubtitleToTranslateDashboard")
  if (!permission.hasPermission) return null

  const models = getActiveModelsByRole(db, "nameFormatter")
  if (models.length === 0) return null

  const promptVersion = getTheMovieDbMatcherPromptVersion(db)
  if (!promptVersion) return null

  const finishedPrompt = formatTheMovieDbMatcherPrompt(promptVersion.promptText, fileName, candidates)

  try {
    const response = await sendPrompt(db, models[0], finishedPrompt)
    const jsonMatch = response.message.content.match(/\{[\s\S]*\}/)

    if (!jsonMatch) {
      createLog(
        db,
        "warning",
        "tmdbMatching", "libraryScanner",
        null,
        `theMovieDBMatchingPrompt returned no JSON object for "${fileName}"`,
        {
          fileName,
          candidateCount: candidates.length,
          rawResponse: response.message.content.slice(0, 500),
        },
      )
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as { winnerId?: number }

    if (typeof parsed.winnerId !== "number") {
      createLog(
        db,
        "warning",
        "tmdbMatching", "libraryScanner",
        null,
        `theMovieDBMatchingPrompt returned malformed winnerId for "${fileName}"`,
        {
          fileName,
          candidateCount: candidates.length,
          parsed,
        },
      )
      return null
    }

    if (parsed.winnerId === -1) {
      createLog(
        db,
        "info",
        "tmdbMatching", "libraryScanner",
        null,
        `theMovieDBMatchingPrompt indicated no good match for "${fileName}"`,
        {
          fileName,
          candidateCount: candidates.length,
        },
      )
      return null
    }

    const winner = candidates.find((c) => c.id === parsed.winnerId)
    if (!winner) {
      createLog(
        db,
        "warning",
        "tmdbMatching", "libraryScanner",
        null,
        `theMovieDBMatchingPrompt winnerId ${parsed.winnerId} not in candidate list for "${fileName}"`,
        {
          fileName,
          winnerId: parsed.winnerId,
          candidateCount: candidates.length,
          candidateIds: candidates.map((c) => c.id),
        },
      )
      return null
    }

    createLog(
      db,
      "info",
      "tmdbMatching", "libraryScanner",
      null,
      `theMovieDBMatchingPrompt executed for "${fileName}" with ${candidates.length} candidates — AI soft-picked ${winner.id} (${winner.name})`,
      {
        fileName,
        candidateCount: candidates.length,
        winnerId: winner.id,
        winnerName: winner.name,
      },
    )

    return winner
  } catch (error) {
    createLog(
      db,
      "warning",
      "tmdbMatching", "libraryScanner",
      null,
      `theMovieDBMatchingPrompt failed for "${fileName}": ${String(error).slice(0, 200)}`,
      { fileName, error: String(error) },
    )
    return null
  }
}
