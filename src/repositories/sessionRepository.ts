import Database from "better-sqlite3"
import { DBUser, DBUserSession } from "../types/dbTypes"
import { ValidateSessionResult } from "../types/modelTypes"
import * as crypto from "crypto"
import { hashToken } from "./shared"
import { createLog } from "./logRepository"
import { getConfig } from "./configRepository"

export const getSessionByToken = (db: Database.Database, token: string): DBUserSession | null => {
  const tokenHash = hashToken(token)
  const result = db
    .prepare(`SELECT * FROM userSession WHERE sessionTokenHash = ? AND deletedAt IS NULL`)
    .get(tokenHash) as DBUserSession | undefined
  return result ?? null
}

export const createSession = (db: Database.Database, userId: number): { session: DBUserSession; token: string } => {
  const config = getConfig(db)
  const expiresAt = new Date(Date.now() + config.sessionTimeoutMinutes * 60 * 1000).toISOString()
  const token = `st_${crypto.randomBytes(32).toString("hex")}`
  const tokenHash = hashToken(token)

  const stmt = db.prepare(`INSERT INTO userSession (userId, sessionTokenHash, expiresAt) VALUES (?, ?, ?)`)
  const result = stmt.run(userId, tokenHash, expiresAt)

  const session = db
    .prepare(`SELECT * FROM userSession WHERE id = ?`)
    .get(result.lastInsertRowid as number) as DBUserSession

  return { session, token }
}

export const validateSession = (db: Database.Database, token: string): ValidateSessionResult => {
  const result = (user: DBUser | null, success: boolean, msg: string | null) => {
    return { user, success, msg } as ValidateSessionResult
  }

  const session = getSessionByToken(db, token)
  if (!session) {
    return result(null, false, "Session not found")
  }

  const expiresAt = new Date(session.expiresAt)
  if (expiresAt < new Date()) {
    deleteSession(db, token)
    return result(null, false, "Session expired")
  }

  const user = db.prepare(`SELECT * FROM user WHERE id = ? AND deletedAt IS NULL`).get(session.userId) as
    | DBUser
    | undefined
  if (!user || user.deletedAt) {
    deleteSession(db, token)
    return result(null, false, "User not found or deleted")
  }

  return result(user, true, null)
}

export const deleteSession = (db: Database.Database, token: string): void => {
  const tokenHash = hashToken(token)
  db.prepare(
    `UPDATE userSession SET deletedAt = datetime('now'), updatedAt = datetime('now') WHERE sessionTokenHash = ?`,
  ).run(tokenHash)
}

export const deleteAllSessionsForUser = (db: Database.Database, userId: number): void => {
  db.prepare(
    `UPDATE userSession SET deletedAt = datetime('now'), updatedAt = datetime('now') WHERE userId = ? AND deletedAt IS NULL`,
  ).run(userId)
  createLog(db, "info", "sessionDelete", "session", null, "Deleted all sessions for user", { userId })
}
