import Database from "better-sqlite3"
import { DBRecommendedModel } from "../types/dbTypes"

export const getRecommendedModels = (db: Database.Database): DBRecommendedModel[] => {
  return db.prepare(`SELECT * FROM recommendedModel ORDER BY id ASC`).all() as DBRecommendedModel[]
}

export const getRecommendedModelById = (db: Database.Database, id: number): DBRecommendedModel | null => {
  return (db.prepare(`SELECT * FROM recommendedModel WHERE id = ?`).get(id) as DBRecommendedModel | undefined) ?? null
}

export const getUninstalledRecommendedModels = (db: Database.Database): DBRecommendedModel[] => {
    return db
    .prepare(
      `SELECT r.* FROM recommendedModel r
       WHERE NOT EXISTS (
         SELECT 1 FROM model m
         WHERE m.deletedAt IS NULL AND (m.recommendedModelId = r.id OR m.modelName = r.name)
       )
       ORDER BY r.id ASC`,
    )
    .all() as DBRecommendedModel[]
}
