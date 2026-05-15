import Database from "better-sqlite3"
import { DBConfig, DBLog } from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"

export const createLog = (
  db: Database.Database,
  level: DBLog["level"],
  entityType: string | null = null,
  entityId: number | null = null,
  message: string,
  metadata: any = null,
): void => {
  db.prepare(`INSERT INTO log (level, entityType, entityId, message, metadata) VALUES (?, ?, ?, ?, ?)`).run(
    level,
    entityType,
    entityId,
    message,
    metadata ? JSON.stringify(metadata) : null,
  )
}

export const deleteLogsJob = (db: Database.Database): DefaultResponse => {
  const config = db.prepare(`SELECT * FROM config LIMIT 1`).get() as DBConfig
  if (!config.clearLogs) return { success: true, msg: "Log clearing is disabled in config" }

  const result = db
    .prepare(`DELETE FROM log WHERE createdAt < datetime('now', ?)`)
    .run(`-${config.clearLogsOlderThanDays} days`)

  return { success: true, msg: `Deleted ${result.changes} logs older than ${config.clearLogsOlderThanDays} days` }
}
