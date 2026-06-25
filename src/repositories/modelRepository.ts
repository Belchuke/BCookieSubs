import Database from "better-sqlite3"
import { DBModel, DBUser, DBModelRole } from "../types/dbTypes"
import { DefaultResponse, ModelWithRoles, OllamaModel } from "../types/modelTypes"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"
import { getModelsFromOllama } from "./ollamaRepository"

export const getModelById = (db: Database.Database, id: number): DBModel | null => {
  const result = db.prepare(`SELECT * FROM model WHERE id = ? AND deletedAt IS NULL`).get(id) as DBModel | undefined
  return result ?? null
}

// True if the model still exists and has not been soft-deleted.
export const isModelActive = (db: Database.Database, id: number): boolean => {
  return !!db.prepare(`SELECT 1 FROM model WHERE id = ? AND deletedAt IS NULL`).get(id)
}

// True if a model row exists at all (regardless of soft-delete state).
export const modelExists = (db: Database.Database, id: number): boolean => {
  return !!db.prepare(`SELECT 1 FROM model WHERE id = ?`).get(id)
}

export const getRolesForModel = (db: Database.Database, modelId: number): DBModelRole[] => {
  return db.prepare(`SELECT * FROM modelRole WHERE modelId = ? AND deletedAt IS NULL`).all(modelId) as DBModelRole[]
}

export const getModelsByName = (db: Database.Database, name: string): DBModel[] => {
  return db
    .prepare(`SELECT * FROM model WHERE (name = ? OR modelName = ?) AND deletedAt IS NULL`)
    .all(name, name) as DBModel[]
}

export const getModelsListWithRoles = (
  db: Database.Database,
  user: DBUser,
): { models: ModelWithRoles[] } & DefaultResponse => {
  const hasPermission = userHasPermission(db, user.id, "canViewModelsPage").hasPermission
  if (!hasPermission) return { models: [], success: false, msg: "Permission denied" }

  const models = db.prepare(`SELECT * FROM model WHERE deletedAt IS NULL ORDER BY createdAt ASC`).all() as DBModel[]
  const modelRoles = db.prepare(`SELECT * FROM modelRole WHERE deletedAt IS NULL`).all() as DBModelRole[]

  const modelsWithRoles: ModelWithRoles[] = models.map((model) => ({
    ...model,
    roles: modelRoles.filter((role) => role.modelId === model.id),
  }))

  return { models: modelsWithRoles, success: true, msg: null }
}

export const getListOfOllamaModelsInstalled = async (
  db: Database.Database,
  user: DBUser,
): Promise<{ models: OllamaModel[]; error: string | null; ollamaRunning: boolean | null }> => {
  if (!userHasPermission(db, user.id, "canViewModelsPage").hasPermission) {
    return { models: [], error: "Permission denied", ollamaRunning: null }
  }

  const result = await getModelsFromOllama()
  if (result.error) return { models: [], error: result.error, ollamaRunning: result.ollamaRunning }

  return {
    models: result.models.map((m) => ({
      model: m.model,
      size: m.size,
      parameterSize: m.details.parameter_size,
      modifiedAt: m.modified_at.toString(),
    })),
    error: null,
    ollamaRunning: result.ollamaRunning,
  }
}

export const getActiveModelsByRole = (db: Database.Database, role: DBModelRole["role"]): DBModel[] => {
  return db
    .prepare(
      `SELECT m.* FROM model m
       JOIN modelRole mr ON m.id = mr.modelId
       WHERE mr.role = ? AND mr.deletedAt IS NULL AND m.deletedAt IS NULL AND m.active = 1`,
    )
    .all(role) as DBModel[]
}

export const addModel = (
  db: Database.Database,
  user: DBUser,
  name: string,
  closeAfterUse = true,
  active: boolean = true,
  ollamaModel: OllamaModel,
  roles: DBModelRole["role"][],
  provider: DBModel["provider"] = "ollama",
  baseUrl: string | null = null,
  recommendedModelId: number | null = null,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canAddOrInstallAModel")
  if (!perm) return { success: false, msg: "Permission denied" }

  const existingActive = getModelsByName(db, name)
  if (existingActive.length > 0) {
    const byName = existingActive.find((m) => m.name === name)
    if (byName) return { success: false, msg: `Model with name "${name}" already exists` }

    const byModelName = existingActive.find(
      (m) =>
        m.modelName === ollamaModel.model &&
        m.size === String(ollamaModel.size) &&
        m.parameterSize === ollamaModel.parameterSize &&
        m.modelUpdatedAt === ollamaModel.modifiedAt,
    )
    if (byModelName) {
      return { success: false, msg: `Model "${byModelName.name}" already exists with identical Ollama details` }
    }
  }

  const softDeleted = db
    .prepare(`SELECT * FROM model WHERE modelName = ? AND modelUpdatedAt = ? AND deletedAt IS NOT NULL`)
    .get(ollamaModel.model, ollamaModel.modifiedAt) as DBModel | undefined

  if (softDeleted) {
    db.prepare(
      `UPDATE model SET
         name = ?, closeAfterUse = ?, active = ?, size = ?, parameterSize = ?,
         provider = ?, baseUrl = ?, recommendedModelId = ?,
         deletedAt = NULL, updatedAt = datetime('now')
       WHERE id = ?`,
    ).run(
      name,
      closeAfterUse ? 1 : 0,
      active ? 1 : 0,
      ollamaModel.size !== null ? String(ollamaModel.size) : null,
      ollamaModel.parameterSize,
      provider,
      baseUrl,
      recommendedModelId,
      softDeleted.id,
    )

    db.prepare(`UPDATE modelRole SET deletedAt = datetime('now') WHERE modelId = ? AND deletedAt IS NULL`).run(
      softDeleted.id,
    )
    const reactivateStmt = db.prepare(
      `UPDATE modelRole SET deletedAt = NULL WHERE modelId = ? AND role = ? AND deletedAt IS NOT NULL`,
    )
    const roleStmt = db.prepare(`INSERT INTO modelRole (modelId, role) VALUES (?, ?)`)
    for (const role of roles) {
      const result = reactivateStmt.run(softDeleted.id, role)
      if (result.changes === 0) {
        roleStmt.run(softDeleted.id, role)
      }
    }

    createLog(db, "info", "modelAdd", "model", softDeleted.id, "Re-added previously deleted model", { name, roles, provider })
    return { success: true, msg: "Model added successfully" }
  }

  const result = db
    .prepare(
      `INSERT INTO model (name, modelName, closeAfterUse, active, size, parameterSize, modelUpdatedAt, provider, baseUrl, recommendedModelId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      ollamaModel.model,
      closeAfterUse ? 1 : 0,
      active ? 1 : 0,
      ollamaModel.size !== null ? String(ollamaModel.size) : null,
      ollamaModel.parameterSize,
      ollamaModel.modifiedAt,
      provider,
      baseUrl,
      recommendedModelId,
    )

  const modelId = result.lastInsertRowid as number
  const roleStmt = db.prepare(`INSERT INTO modelRole (modelId, role) VALUES (?, ?)`)
  for (const role of roles) {
    roleStmt.run(modelId, role)
  }

  createLog(db, "info", "modelAdd", "model", modelId, "Added model", { name, roles, provider })
  return { success: true, msg: "Model added successfully" }
}

export const updateModel = (
  db: Database.Database,
  user: DBUser,
  modelId: number,
  name: string,
  closeAfterUse: boolean,
  active: boolean,
  provider: DBModel["provider"] = "ollama",
  baseUrl: string | null = null,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canEditModels")
  if (!perm) return { success: false, msg: "Permission denied" }

  const model = getModelById(db, modelId)
  if (!model) return { success: false, msg: "Model not found" }

  db.prepare(
    `UPDATE model SET name = ?, closeAfterUse = ?, active = ?, provider = ?, baseUrl = ?, updatedAt = datetime('now') WHERE id = ?`,
  ).run(name, closeAfterUse ? 1 : 0, active ? 1 : 0, provider, baseUrl, modelId)

  createLog(db, "info", "modelUpdate", "model", modelId, "Updated model", { name, closeAfterUse, active, provider })
  return { success: true, msg: "Model updated successfully" }
}

export const updateRolesForModel = (
  db: Database.Database,
  user: DBUser,
  modelId: number,
  role: DBModelRole["role"],
  add: boolean,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageModelRoles")
  if (!perm) return { success: false, msg: "Permission denied" }

  const model = getModelById(db, modelId)
  if (!model) return { success: false, msg: "Model not found" }

  if (add) {
    const reactivated = db
      .prepare(`UPDATE modelRole SET deletedAt = NULL WHERE modelId = ? AND role = ? AND deletedAt IS NOT NULL`)
      .run(modelId, role)
    if (reactivated.changes === 0) {
      db.prepare(`INSERT OR IGNORE INTO modelRole (modelId, role) VALUES (?, ?)`).run(modelId, role)
    }
  } else {
    db.prepare(
      `UPDATE modelRole SET deletedAt = datetime('now') WHERE modelId = ? AND role = ? AND deletedAt IS NULL`,
    ).run(modelId, role)
  }

  return { success: true, msg: "Model roles updated successfully" }
}

export const deleteModel = (db: Database.Database, user: DBUser, modelId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canRemoveAndDeleteModels")
  if (!perm) return { success: false, msg: "Permission denied" }

  const model = getModelById(db, modelId)
  if (!model) return { success: false, msg: "Model not found" }

  db.prepare(`UPDATE model SET deletedAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?`).run(modelId)
  db.prepare(`UPDATE modelRole SET deletedAt = datetime('now') WHERE modelId = ? AND deletedAt IS NULL`).run(modelId)

  createLog(db, "info", "modelDelete", "model", modelId, "Deleted model", { name: model.name })
  return { success: true, msg: "Model deleted successfully" }
}
