import Database from "better-sqlite3"

export const getModelsStats = (db: Database.Database) => {
  return db
    .prepare(
      `SELECT model.id, model.name, model.active
          FROM model
          WHERE model.deletedAt IS NULL
          AND (
            EXISTS (SELECT 1 FROM modelRole WHERE modelRole.modelId = model.id AND modelRole.role = 'translation')
            OR EXISTS (SELECT 1 FROM subtitleChunkCandidate WHERE subtitleChunkCandidate.modelId = model.id)
          )
          ORDER BY model.name ASC`,
    )
    .all() as { id: number; name: string; active: boolean }[]
}
