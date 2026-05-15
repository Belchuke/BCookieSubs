import Database from "better-sqlite3"
import { DBUser, DBUserSession } from "../types/dbTypes"
import { DefaultResponse, UserPermissions, UserPermission } from "../types/modelTypes"
import bcrypt from "bcrypt"
import { createLog } from "./logRepository"
import { createSession, deleteAllSessionsForUser } from "./sessionRepository"

export const BCRYPT_ROUNDS = 12

export const getUserById = (db: Database.Database, id: number, omitPassword = true): DBUser | null => {
  const result = db.prepare(`SELECT * FROM user WHERE id = ? AND deletedAt IS NULL`).get(id) as DBUser | undefined
  if (!result) return null
  if (omitPassword) result.passwordHash = ""
  return result
}

export const userHasPermission = (
  db: Database.Database,
  userId: number,
  permission: UserPermission,
): { hasPermission: boolean; user: DBUser | null } => {
  const user = getUserById(db, userId)
  if (!user) return { hasPermission: false, user: null }
  if (user.isAdmin) return { hasPermission: true, user }
  return { hasPermission: Boolean((user as any)[permission]), user }
}

export const verifyUserPassword = (
  db: Database.Database,
  username: string,
  password: string,
): { user: DBUser | null; session: DBUserSession | null; token: string | null } & DefaultResponse => {
  const user =
    (db.prepare(`SELECT * FROM user WHERE username = ? AND deletedAt IS NULL`).get(username) as DBUser | undefined) ??
    null

  if (!user) {
    createLog(db, "warning", "user", null, `Failed login attempt: unknown username "${username}"`, { username })
    return { user: null, session: null, token: null, success: false, msg: "Invalid username or password" }
  }

  const passwordMatch = bcrypt.compareSync(password, user.passwordHash ?? "")

  if (!passwordMatch) {
    createLog(db, "warning", "user", user.id, `Failed login attempt: incorrect password for ${username}`, { username })
    return { user: null, session: null, token: null, success: false, msg: "Invalid username or password" }
  }

  const { session, token } = createSession(db, user.id)
  createLog(db, "info", "user", user.id, `User logged in: ${username}`, { username })

  return { user: { ...user, passwordHash: "" }, session, token, success: true, msg: null }
}

export const updateUserPassword = (
  db: Database.Database,
  user: DBUser,
  userId: number,
  newPassword: string,
): DefaultResponse => {
  if (user.id !== userId) {
    const { hasPermission: perm } = userHasPermission(db, user.id, "canManageUsers")
    if (!perm) return { success: false, msg: "User does not have permission to manage users" }
  }

  const targetUser = getUserById(db, userId)
  if (!targetUser) return { success: false, msg: "User not found" }

  const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS)
  db.prepare(`UPDATE user SET passwordHash = ?, updatedAt = datetime('now') WHERE id = ?`).run(passwordHash, userId)

  deleteAllSessionsForUser(db, userId)
  createLog(db, "info", "user", userId, `Updated password for user: ${targetUser.username}`, {
    username: targetUser.username,
    updatedByUserId: user.id,
    updatedByUsername: user.username,
  })

  return { success: true, msg: null }
}

export const hasAdminUser = (db: Database.Database): boolean => {
  return (db.prepare(`SELECT id FROM user WHERE isAdmin = 1 AND deletedAt IS NULL LIMIT 1`).get() as any) != null
}

export const getUsers = (db: Database.Database, user: DBUser): { users: DBUser[] | null } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageUsers")
  if (!perm) return { users: null, success: false, msg: "User does not have permission to manage users" }

  const users = (db.prepare(`SELECT * FROM user WHERE deletedAt IS NULL`).all() as DBUser[]).map((u) => ({
    ...u,
    passwordHash: "",
  }))

  return { users, success: true, msg: null }
}

export const createInitialAdminUser = (
  db: Database.Database,
  username: string,
  password: string,
): { user: DBUser | null; session: DBUserSession | null; token: string | null } & DefaultResponse => {
  if (hasAdminUser(db)) {
    return { user: null, session: null, token: null, success: false, msg: "Admin user already exists" }
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS)
  const stmt = db.prepare(
    `INSERT INTO user (username, passwordHash, isAdmin, canManageUsers, canViewModels, canManageModels, canViewPrompts, canManagePrompts, canManageLanguages, canManageConfig, canAddSubtitles, canStopSubtitles, canDeleteSubtitles, canViewLogs, canManageSchedules, pauseWorker, downloadSubtitles, canViewStats, canManageSecret, canManageLibraryPath, canManageRootLibraryPath) VALUES (?, ?, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`,
  )
  const result = stmt.run(username, passwordHash)

  const newUser = getUserById(db, result.lastInsertRowid as number)
  if (!newUser)
    return { user: null, session: null, token: null, success: false, msg: "Failed to retrieve created admin user" }

  createLog(db, "info", "user", newUser.id, `Created initial admin user: ${username}`, { username })

  const { session, token } = createSession(db, newUser.id)
  return { user: newUser, session, token, success: true, msg: null }
}

export const createUser = (
  db: Database.Database,
  user: DBUser,
  username: string,
  password: string,
  giveAdmin: boolean,
  permissions: Partial<Record<UserPermission, boolean>>,
): { user: DBUser | null } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageUsers")
  if (!perm) return { user: null, success: false, msg: "User does not have permission to manage users" }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS)

  const stmt = db.prepare(
    `INSERT INTO user (username, passwordHash, isAdmin, canManageUsers, canViewModels, canManageModels, canViewPrompts, canManagePrompts, canManageLanguages, canManageConfig, canAddSubtitles, canStopSubtitles, canDeleteSubtitles, canViewLogs, canManageSchedules, pauseWorker, downloadSubtitles, canViewStats, canManageSecret, canManageLibraryPath, canManageRootLibraryPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  let result: Database.RunResult
  if (giveAdmin) {
    result = stmt.run(username, passwordHash, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
  } else {
    result = stmt.run(
      username,
      passwordHash,
      0,
      permissions.canManageUsers ? 1 : 0,
      permissions.canViewModels ? 1 : 0,
      permissions.canManageModels ? 1 : 0,
      permissions.canViewPrompts ? 1 : 0,
      permissions.canManagePrompts ? 1 : 0,
      permissions.canManageLanguages ? 1 : 0,
      permissions.canManageConfig ? 1 : 0,
      permissions.canAddSubtitles ? 1 : 0,
      permissions.canStopSubtitles ? 1 : 0,
      permissions.canDeleteSubtitles ? 1 : 0,
      permissions.canViewLogs ? 1 : 0,
      permissions.canManageSchedules ? 1 : 0,
      permissions.pauseWorker ? 1 : 0,
      permissions.downloadSubtitles ? 1 : 0,
      permissions.canViewStats ? 1 : 0,
      permissions.canManageSecret ? 1 : 0,
      permissions.canManageLibraryPath ? 1 : 0,
      permissions.canManageRootLibraryPath ? 1 : 0,
    )
  }

  const newUser = getUserById(db, result.lastInsertRowid as number)
  if (!newUser) return { user: null, success: false, msg: "Failed to retrieve created user" }

  createLog(db, "info", "user", newUser.id, `Created new user: ${username}${giveAdmin ? " (admin)" : ""}`, {
    username,
    isAdmin: giveAdmin,
    createdByUserId: user.id,
    createdByUsername: user.username,
  })
  return { user: newUser, success: true, msg: null }
}

export const updateUserPermissions = (
  db: Database.Database,
  user: DBUser,
  userId: number,
  giveAdmin: boolean,
  permissions: Partial<Record<UserPermission, boolean>>,
): DefaultResponse => {
  if (!user.isAdmin) return { success: false, msg: "Requires admin permissions to update user permissions" }
  if (user.id === userId) return { success: false, msg: "Users cannot update their own permissions" }

  const userToUpdate = getUserById(db, userId)
  if (!userToUpdate) return { success: false, msg: "User to update not found" }

  const permKeys = Object.keys(UserPermissions) as UserPermission[]

  if (giveAdmin) {
    const sets = permKeys.map((p) => `${p} = 1`).join(", ")
    db.prepare(`UPDATE user SET isAdmin = 1, ${sets}, updatedAt = datetime('now') WHERE id = ?`).run(userId)
  } else {
    const sets = permKeys.map((p) => `${p} = ${permissions[p] ? 1 : 0}`).join(", ")
    db.prepare(`UPDATE user SET isAdmin = 0, ${sets}, updatedAt = datetime('now') WHERE id = ?`).run(userId)
  }

  return { success: true, msg: null }
}

export const deleteUser = (db: Database.Database, user: DBUser, userId: number): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageUsers")
  if (!perm) return { success: false, msg: "User does not have permission to manage users" }

  const userToDelete = getUserById(db, userId)
  if (!userToDelete) return { success: false, msg: "User to delete not found" }
  if (user.id === userId) return { success: false, msg: "Users cannot delete themselves" }
  if (!user.isAdmin && userToDelete.isAdmin) {
    return { success: false, msg: "Non-admin users cannot delete admin users" }
  }

  db.prepare(`UPDATE user SET deletedAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?`).run(userId)
  deleteAllSessionsForUser(db, userId)
  createLog(db, "info", "user", userId, `Deleted user: ${userToDelete.username}`, {
    username: userToDelete.username,
    deletedByUserId: user.id,
    deletedByUsername: user.username,
  })

  return { success: true, msg: null }
}
