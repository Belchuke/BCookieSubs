import Database from "better-sqlite3"
import { DBUser, DBPrompt, DBPromptVersion, DBPromptStat } from "../types/dbTypes"
import { DefaultResponse, PromptsWithVersions, PromptStatListItem } from "../types/modelTypes"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"

export const getPromptById = (db: Database.Database, promptId: number): DBPrompt | null => {
  return (db.prepare(`SELECT * FROM prompt WHERE id = ?`).get(promptId) as DBPrompt | undefined) ?? null
}

export const getAllPrompts = (
  db: Database.Database,
  user: DBUser | null,
  job = false,
): { prompts: PromptsWithVersions[] } & DefaultResponse => {
  if (!job) {
    const { hasPermission: perm } = userHasPermission(db, user?.id ?? -1, "canViewPromptsPage")
    if (!perm) return { prompts: [], success: false, msg: "User does not have permission to view prompts" }
  }

  const prompts = db.prepare(`SELECT * FROM prompt ORDER BY type ASC, name ASC`).all() as DBPrompt[]
  const promptVersions = db
    .prepare(`SELECT * FROM promptVersion WHERE deletedAt IS NULL ORDER BY version ASC`)
    .all() as DBPromptVersion[]

  return {
    prompts: prompts.map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
      type: prompt.type,
      active: prompt.active,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
      versions: promptVersions
        .filter((pv) => pv.promptId === prompt.id)
        .map((pv) => ({
          id: pv.id,
          version: pv.version,
          promptText: pv.promptText,
          active: pv.active,
          createdAt: pv.createdAt,
        })),
    })) as PromptsWithVersions[],
    success: true,
    msg: null,
  }
}

export const getActivePromptVersionByPromptId = (db: Database.Database, promptId: number): DBPromptVersion | null => {
  return (
    (db.prepare(`SELECT * FROM promptVersion WHERE promptId = ? AND active = 1 AND deletedAt IS NULL`).get(promptId) as
      | DBPromptVersion
      | undefined) ?? null
  )
}

export const getTranslationPromptVersions = (db: Database.Database): DBPromptVersion[] => {
  return db
    .prepare(
      `SELECT pv.* FROM promptVersion pv
       INNER JOIN prompt p ON pv.promptId = p.id
       WHERE p.type = 'translation' AND p.active = 1 AND pv.active = 1 AND pv.deletedAt IS NULL`,
    )
    .all() as DBPromptVersion[]
}

export const getJudgePromptVersion = (db: Database.Database): DBPromptVersion | null => {
  const result = db
    .prepare(
      `SELECT pv.* FROM promptVersion pv
       INNER JOIN prompt p ON pv.promptId = p.id
       WHERE p.type = 'judge' AND p.active = 1 AND pv.active = 1 AND pv.deletedAt IS NULL
       LIMIT 1`,
    )
    .get() as DBPromptVersion | undefined
  return result ?? null
}

export const getNameFormatterPromptVersion = (db: Database.Database): DBPromptVersion | null => {
  const result = db
    .prepare(
      `SELECT pv.* FROM promptVersion pv
       INNER JOIN prompt p ON pv.promptId = p.id
       WHERE p.type = 'nameFormatter' AND p.active = 1 AND pv.active = 1 AND pv.deletedAt IS NULL
       LIMIT 1`,
    )
    .get() as DBPromptVersion | undefined
  return result ?? null
}

export const getTheMovieDbMatcherPromptVersion = (db: Database.Database): DBPromptVersion | null => {
  const result = db
    .prepare(
      `SELECT pv.* FROM promptVersion pv
       INNER JOIN prompt p ON pv.promptId = p.id
       WHERE p.name = 'theMovieDBMatchingPrompt' AND p.active = 1 AND pv.active = 1 AND pv.deletedAt IS NULL
       LIMIT 1`,
    )
    .get() as DBPromptVersion | undefined
  return result ?? null
}

export const getPromptStatByKeys = (
  db: Database.Database,
  promptId: number,
  promptVersionId: number,
  modelId: number,
  languageId: number | null,
): DBPromptStat | null => {
  const result = db
    .prepare(
      `SELECT * FROM promptStat WHERE promptId = ? AND promptVersionId = ? AND modelId = ? AND (languageId = ? OR (languageId IS NULL AND ? IS NULL))`,
    )
    .get(promptId, promptVersionId, modelId, languageId, languageId) as DBPromptStat | undefined
  return result ?? null
}

export const getAllPromptStats = (
  db: Database.Database,
  user: DBUser,
): { stats: PromptStatListItem[] } & DefaultResponse => {
  if (!userHasPermission(db, user.id, "canViewPromptsPage").hasPermission) {
    return { stats: [], success: false, msg: "User does not have permission to view prompts" }
  }

  return {
    stats: db
      .prepare(
        `SELECT 
          ps.id, 
          p.name as promptName, 
          pv.version as promptVersionId,
          m.name as modelName,
          l.name as languageName,
          ps.requestCount,
          ps.failedCount,
          ps.successCount,
          ps.selectedCount,
          ps.createdAt,
          ps.updatedAt
        FROM promptStat ps
        inner join promptVersion pv on ps.promptVersionId = pv.id
        inner join prompt p on pv.promptId = p.id
        inner join model m on ps.modelId = m.id
        inner join language l on ps.languageId = l.id
        ORDER BY ps.selectedCount DESC`,
      )
      .all() as PromptStatListItem[],
    success: true,
    msg: null,
  }
}

export const createOrUpdatePromptStat = (
  db: Database.Database,
  promptId: number,
  promptVersionId: number,
  modelId: number,
  languageId: number | null,
  requestCountUp: boolean,
  failedCountUp: boolean,
  successCountUp: boolean,
  selectedCountUp: boolean,
) => {
  let stat = getPromptStatByKeys(db, promptId, promptVersionId, modelId, languageId)

  if (!stat) {
    db.prepare(
      `INSERT INTO promptStat (promptId, promptVersionId, modelId, languageId, requestCount, failedCount, successCount, selectedCount)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0)`,
    ).run(promptId, promptVersionId, modelId, languageId)
    stat = getPromptStatByKeys(db, promptId, promptVersionId, modelId, languageId)!
  }

  db.prepare(
    `UPDATE promptStat SET
       requestCount = requestCount + ?,
       failedCount = failedCount + ?,
       successCount = successCount + ?,
       selectedCount = selectedCount + ?,
       updatedAt = datetime('now')
     WHERE id = ?`,
  ).run(requestCountUp ? 1 : 0, failedCountUp ? 1 : 0, successCountUp ? 1 : 0, selectedCountUp ? 1 : 0, stat.id)
}

export const addPromptVersion = (
  db: Database.Database,
  user: DBUser,
  promptId: number,
  version: number,
  promptText: string,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManagePrompts")
  if (!perm) return { success: false, msg: "User does not have permission to manage prompts" }

  const prompt = getPromptById(db, promptId)
  if (!prompt) return { success: false, msg: "Prompt not found" }

  const existingVersion = db
    .prepare(`SELECT * FROM promptVersion WHERE promptId = ? AND version = ?`)
    .get(promptId, version) as DBPromptVersion | undefined

  if (existingVersion) return { success: false, msg: "Prompt version already exists for this prompt" }

  db.prepare(`UPDATE promptVersion SET active = 0 WHERE promptId = ? AND active = 1`).run(promptId)

  db.prepare(`INSERT INTO promptVersion (promptId, version, promptText, active) VALUES (?, ?, ?, 1)`).run(
    promptId,
    version,
    promptText,
  )

  createLog(db, "info", "prompt", "prompt", promptId, "Added new prompt version and activated it", { version })
  return { success: true, msg: "Prompt version added and activated successfully" }
}

export const addTranslationPrompt = (
  db: Database.Database,
  user: DBUser,
  name: string,
  promptText: string,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManagePrompts")
  if (!perm) return { success: false, msg: "User does not have permission to manage prompts" }

  const existing = db.prepare(`SELECT * FROM prompt WHERE name = ?`).get(name) as DBPrompt | undefined
  if (existing) return { success: false, msg: "Prompt with the same name already exists" }

  const result = db.prepare(`INSERT INTO prompt (name, type, active) VALUES (?, 'translation', 1)`).run(name)

  const promptId = result.lastInsertRowid as number
  db.prepare(`INSERT INTO promptVersion (promptId, version, promptText, active) VALUES (?, 1, ?, 1)`).run(
    promptId,
    promptText,
  )

  createLog(db, "info", "prompt", "prompt", promptId, "Created new translation prompt", { name })
  return { success: true, msg: "Translation prompt created successfully" }
}

export const setPromptActive = (
  db: Database.Database,
  user: DBUser,
  promptId: number,
  active: boolean,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManagePrompts")
  if (!perm) return { success: false, msg: "User does not have permission to manage prompts" }

  const prompt = getPromptById(db, promptId)
  if (!prompt) return { success: false, msg: "Prompt not found" }

  db.prepare(`UPDATE prompt SET active = ?, updatedAt = datetime('now') WHERE id = ?`).run(active ? 1 : 0, promptId)
  createLog(db, "info", "prompt", "prompt", promptId, active ? "Activated prompt" : "Deactivated prompt", {})
  return { success: true, msg: null }
}

export const setActivePromptVersion = (
  db: Database.Database,
  user: DBUser,
  promptId: number,
  promptVersionId: number,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManagePrompts")
  if (!perm) return { success: false, msg: "User does not have permission to manage prompts" }

  const prompt = getPromptById(db, promptId)
  if (!prompt) return { success: false, msg: "Prompt not found" }

  db.prepare(`UPDATE promptVersion SET active = 0 WHERE promptId = ? AND active = 1`).run(promptId)
  db.prepare(`UPDATE promptVersion SET active = 1 WHERE id = ? AND promptId = ?`).run(promptVersionId, promptId)

  createLog(db, "info", "prompt", "prompt", promptId, "Changed active prompt version", { promptVersionId })
  return { success: true, msg: "Active prompt version updated successfully" }
}
