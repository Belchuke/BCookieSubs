import Database from "better-sqlite3"
import { DBUser, DBLanguage } from "../types/dbTypes"
import { NameFormatterResult } from "../types/modelTypes"
import { getConfig } from "./configRepository"
import { getActiveModelsByRole } from "./modelRepository"
import { sendPrompt } from "./ollamaRepository"
import { getNameFormatterPromptVersion } from "./promptRepository"
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
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM judgeEvaluation je WHERE je.modelId = ?`).get(modelId) as any).cnt as number
    const rows = db.prepare(`${base} WHERE je.modelId = ? ORDER BY je.createdAt DESC LIMIT ? OFFSET ?`).all(modelId, limit, offset) as any[]
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
): Promise<NameFormatterResult | null> => {
  if (!fileName) return null

  const config = getConfig(db)
  if (!config.nameDetectionActive) return null

  const permission = userHasPermission(db, user.id, "canAddSubtitles")
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

    const search = await searchMediaItemInTheMovieDb(db, parsed.name, parsed.type, parsed.year)
    if (search.success && search.items.length > 0) {
      parsed.theMovieDbRequestResult = search.items
    }
    return parsed
  } catch (error) {
    createLog(
      db,
      "error",
      "nameFormatter",
      null,
      `Name formatter failed for "${fileName}": ${String(error).slice(0, 200)}`,
      { fileName, error: String(error) },
    )
    return null
  }
}
