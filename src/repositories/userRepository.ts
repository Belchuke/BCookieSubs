import Database from "better-sqlite3"
import { DBUser, DBUserSession, DBRole } from "../types/dbTypes"
import { DefaultResponse, UserWithRoles } from "../types/modelTypes"
import bcrypt from "bcrypt"
import { createLog } from "./logRepository"
import { createSession, deleteAllSessionsForUser } from "./sessionRepository"
import { getConfig } from "./configRepository"
import { syncUserConfigTranslationLanguagesFromGlobal } from "./languageRepository"
import {
  userHasPermission as _userHasPermission,
  getUserRoles,
  getUserHighestRoleLevel,
  canManageTargetUser,
  canChangeTargetPassword,
} from "../services/permissionService"
import { BCRYPT_ROUNDS } from "../constants/keys"

export { userHasPermission } from "../services/permissionService"

export const getUserById = (db: Database.Database, id: number, omitPassword = true): DBUser | null => {
  const result = db.prepare(`SELECT * FROM user WHERE id = ? AND deletedAt IS NULL`).get(id) as DBUser | undefined
  if (!result) return null
  if (omitPassword) result.passwordHash = ""
  return result
}

// The highest-privilege non-deleted user. Used by background workers and
// library automation that need an account to attribute actions to.
export const getHighestRoleUser = (db: Database.Database, omitPassword = true): DBUser | null => {
  const row = db
    .prepare(
      `SELECT u.* FROM user u
       JOIN userRole ur ON ur.userId = u.id
       JOIN role r ON r.id = ur.roleId
       WHERE u.deletedAt IS NULL
       ORDER BY r.level DESC
       LIMIT 1`,
    )
    .get() as DBUser | undefined
  if (!row) return null
  if (omitPassword) row.passwordHash = ""
  return row
}

export const hasAdminUser = (db: Database.Database): boolean => {
  const row = db
    .prepare(
      `
    SELECT 1 FROM userRole ur
    JOIN role r ON r.id = ur.roleId
    JOIN user u ON u.id = ur.userId
    WHERE r.name = 'Owner' AND u.deletedAt IS NULL
    LIMIT 1
  `,
    )
    .get()
  return row != null
}

export const getUserWithRoles = (db: Database.Database, userId: number): UserWithRoles | null => {
  const user = getUserById(db, userId)
  if (!user) return null
  const roles = getUserRoles(db, userId)
  const highestRole = roles[0] ?? null
  const highestLevel = highestRole?.level ?? 0
  return { ...user, roles, highestRole, highestLevel }
}

export const getUsers = (db: Database.Database, user: DBUser): { users: UserWithRoles[] | null } & DefaultResponse => {
  const { hasPermission: perm } = _userHasPermission(db, user.id, "canViewUsers")
  if (!perm) return { users: null, success: false, msg: "Permission denied" }

  const rawUsers = (
    db.prepare(`SELECT * FROM user WHERE deletedAt IS NULL ORDER BY createdAt ASC`).all() as DBUser[]
  ).map((u) => ({ ...u, passwordHash: "" }))

  const users: UserWithRoles[] = rawUsers.map((u) => {
    const roles = getUserRoles(db, u.id)
    const highestRole = roles[0] ?? null
    const highestLevel = highestRole?.level ?? 0
    return { ...u, roles, highestRole, highestLevel }
  })

  return { users, success: true, msg: null }
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
  actorUser: DBUser,
  targetUserId: number,
  newPassword: string,
): DefaultResponse => {
  if (!canChangeTargetPassword(db, actorUser.id, targetUserId)) {
    return { success: false, msg: "Permission denied" }
  }

  const targetUser = getUserById(db, targetUserId)
  if (!targetUser) return { success: false, msg: "User not found" }

  const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS)
  db.prepare(`UPDATE user SET passwordHash = ?, updatedAt = datetime('now') WHERE id = ?`).run(
    passwordHash,
    targetUserId,
  )

  deleteAllSessionsForUser(db, targetUserId)
  createLog(db, "info", "user", targetUserId, `Updated password for user: ${targetUser.username}`, {
    username: targetUser.username,
    updatedByUserId: actorUser.id,
    updatedByUsername: actorUser.username,
  })

  return { success: true, msg: null }
}

export const createInitialAdminUser = (
  db: Database.Database,
  username: string,
  password: string,
): { user: DBUser | null; session: DBUserSession | null; token: string | null } & DefaultResponse => {
  if (hasAdminUser(db)) {
    return { user: null, session: null, token: null, success: false, msg: "Owner user already exists" }
  }

  const config = getConfig(db)
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS)
  const result = db
    .prepare(`INSERT INTO user (username, passwordHash, hasSeenTutorial, selectedThemeId) VALUES (?, ?, 0, ?)`)
    .run(username, passwordHash, config.selectedThemeId)
  const newUserId = result.lastInsertRowid as number

  const ownerRole = db.prepare(`SELECT id FROM role WHERE name = 'Owner' LIMIT 1`).get() as { id: number } | null
  if (ownerRole) {
    db.prepare(`INSERT INTO userRole (userId, roleId) VALUES (?, ?)`).run(newUserId, ownerRole.id)
  }

  const newUser = getUserById(db, newUserId)
  if (!newUser)
    return { user: null, session: null, token: null, success: false, msg: "Failed to retrieve created owner user" }

  syncUserConfigTranslationLanguagesFromGlobal(db, newUser.id)
  createLog(db, "info", "user", newUser.id, `Created initial owner user: ${username}`, { username })

  const { session, token } = createSession(db, newUser.id)
  return { user: newUser, session, token, success: true, msg: null }
}

export const createUser = (
  db: Database.Database,
  actorUser: DBUser,
  username: string,
  password: string,
  roleId: number,
  language: string | null = null,
): { user: DBUser | null } & DefaultResponse => {
  const { hasPermission: perm } = _userHasPermission(db, actorUser.id, "canAddUser")
  if (!perm) return { user: null, success: false, msg: "Permission denied" }

  const targetRole = db.prepare(`SELECT id, name, level FROM role WHERE id = ?`).get(roleId) as DBRole | null
  if (!targetRole) return { user: null, success: false, msg: "Role not found" }

  const actorLevel = getUserHighestRoleLevel(db, actorUser.id)
  if (targetRole.level > actorLevel) {
    return { user: null, success: false, msg: "Cannot assign a role above your own level" }
  }

  const config = getConfig(db)
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS)
  const result = db
    .prepare(`INSERT INTO user (username, passwordHash, hasSeenTutorial, selectedThemeId, language) VALUES (?, ?, 0, ?, ?)`)
    .run(username, passwordHash, config.selectedThemeId, language)
  const newUserId = result.lastInsertRowid as number

  db.prepare(`INSERT INTO userRole (userId, roleId) VALUES (?, ?)`).run(newUserId, roleId)

  const newUser = getUserById(db, newUserId)
  if (!newUser) return { user: null, success: false, msg: "Failed to retrieve created user" }

  syncUserConfigTranslationLanguagesFromGlobal(db, newUser.id)
  createLog(db, "info", "user", newUser.id, `Created new user: ${username} with role: ${targetRole.name}`, {
    username,
    roleId,
    roleName: targetRole.name,
    createdByUserId: actorUser.id,
    createdByUsername: actorUser.username,
  })

  return { user: newUser, success: true, msg: null }
}

export const updateUserRoles = (
  db: Database.Database,
  actorUser: DBUser,
  targetUserId: number,
  roleIds: number[],
): DefaultResponse => {
  const { hasPermission: perm } = _userHasPermission(db, actorUser.id, "canManageRoles")
  if (!perm) return { success: false, msg: "Permission denied" }
  if (!canManageTargetUser(db, actorUser.id, targetUserId)) {
    return { success: false, msg: "Cannot manage a user with equal or higher role level" }
  }

  const actorLevel = getUserHighestRoleLevel(db, actorUser.id)
  for (const roleId of roleIds) {
    const role = db.prepare(`SELECT level FROM role WHERE id = ?`).get(roleId) as { level: number } | null
    if (!role) return { success: false, msg: `Role ${roleId} not found` }
    if (role.level > actorLevel) return { success: false, msg: "Cannot assign a role above your own level" }
  }

  db.prepare(`DELETE FROM userRole WHERE userId = ?`).run(targetUserId)
  for (const roleId of roleIds) {
    db.prepare(`INSERT INTO userRole (userId, roleId) VALUES (?, ?)`).run(targetUserId, roleId)
  }

  const targetUser = getUserById(db, targetUserId)
  createLog(db, "info", "user", targetUserId, `Updated roles for user: ${targetUser?.username}`, {
    username: targetUser?.username,
    roleIds,
    updatedByUserId: actorUser.id,
    updatedByUsername: actorUser.username,
  })

  return { success: true, msg: null }
}

export const updateUserLanguage = (db: Database.Database, userId: number, language: string | null): DefaultResponse => {
  db.prepare(`UPDATE user SET language = ?, updatedAt = datetime('now') WHERE id = ?`).run(language, userId)
  return { success: true, msg: null }
}

export const updateUserUsername = (db: Database.Database, userId: number, username: string): DefaultResponse => {
  const existing = db.prepare(`SELECT id FROM user WHERE username = ? AND deletedAt IS NULL`).get(username) as
    | { id: number }
    | undefined
  if (existing && existing.id !== userId) {
    return { success: false, msg: "Username already taken" }
  }

  db.prepare(`UPDATE user SET username = ?, updatedAt = datetime('now') WHERE id = ?`).run(username.trim(), userId)
  return { success: true, msg: null }
}

const BUILT_IN_ROLE_NAMES = ["User", "SuperUser", "MasterUser", "Admin", "Owner"]

export const createRole = (
  db: Database.Database,
  actorUser: DBUser,
  name: string,
  level: number,
  description: string,
  permissionKeys: string[],
): DefaultResponse => {
  const { hasPermission: perm } = _userHasPermission(db, actorUser.id, "canManageRoles")
  if (!perm) return { success: false, msg: "Permission denied" }

  const actorLevel = getUserHighestRoleLevel(db, actorUser.id)
  if (level > actorLevel) return { success: false, msg: "Cannot create a role above your own level" }
  if (level < 1) return { success: false, msg: "Level must be at least 1" }

  const conflict = db.prepare(`SELECT id FROM role WHERE name = ? OR level = ?`).get(name, level) as {
    id: number
  } | null
  if (conflict) return { success: false, msg: "A role with that name or level already exists" }

  const result = db
    .prepare(`INSERT INTO role (name, level, description) VALUES (?, ?, ?)`)
    .run(name.trim(), level, description.trim() || null)
  const roleId = result.lastInsertRowid as number

  for (const key of permissionKeys) {
    db.prepare(
      `INSERT OR IGNORE INTO rolePermission (roleId, permissionId) SELECT ?, id FROM permission WHERE key = ?`,
    ).run(roleId, key)
  }

  createLog(db, "info", "user", null, `Created role: ${name} (level ${level})`, {
    actorId: actorUser.id,
    actorUsername: actorUser.username,
  })
  return { success: true, msg: null }
}

export const updateRole = (
  db: Database.Database,
  actorUser: DBUser,
  roleId: number,
  name: string,
  level: number,
  description: string,
  permissionKeys: string[],
): DefaultResponse => {
  const { hasPermission: perm } = _userHasPermission(db, actorUser.id, "canManageRoles")
  if (!perm) return { success: false, msg: "Permission denied" }

  const role = db.prepare(`SELECT * FROM role WHERE id = ?`).get(roleId) as DBRole | null
  if (!role) return { success: false, msg: "Role not found" }

  const actorLevel = getUserHighestRoleLevel(db, actorUser.id)
  if (role.level > actorLevel) return { success: false, msg: "Cannot edit a role above your own level" }
  if (level > actorLevel) return { success: false, msg: "Cannot set a role level above your own" }
  if (level < 1) return { success: false, msg: "Level must be at least 1" }

  const conflict = db
    .prepare(`SELECT id FROM role WHERE (name = ? OR level = ?) AND id != ?`)
    .get(name, level, roleId) as { id: number } | null
  if (conflict) return { success: false, msg: "Another role with that name or level already exists" }

  db.prepare(`UPDATE role SET name = ?, level = ?, description = ?, updatedAt = datetime('now') WHERE id = ?`).run(
    name.trim(),
    level,
    description.trim() || null,
    roleId,
  )
  db.prepare(`DELETE FROM rolePermission WHERE roleId = ?`).run(roleId)
  for (const key of permissionKeys) {
    db.prepare(
      `INSERT OR IGNORE INTO rolePermission (roleId, permissionId) SELECT ?, id FROM permission WHERE key = ?`,
    ).run(roleId, key)
  }

  createLog(db, "info", "user", null, `Updated role: ${name} (level ${level})`, {
    actorId: actorUser.id,
    actorUsername: actorUser.username,
  })
  return { success: true, msg: null }
}

export const deleteRole = (db: Database.Database, actorUser: DBUser, roleId: number): DefaultResponse => {
  const { hasPermission: perm } = _userHasPermission(db, actorUser.id, "canManageRoles")
  if (!perm) return { success: false, msg: "Permission denied" }

  const role = db.prepare(`SELECT * FROM role WHERE id = ?`).get(roleId) as DBRole | null
  if (!role) return { success: false, msg: "Role not found" }

  if (BUILT_IN_ROLE_NAMES.includes(role.name)) return { success: false, msg: "Cannot delete a built-in role" }

  const actorLevel = getUserHighestRoleLevel(db, actorUser.id)
  if (role.level > actorLevel) return { success: false, msg: "Cannot delete a role above your own level" }

  db.prepare(`DELETE FROM role WHERE id = ?`).run(roleId)
  createLog(db, "info", "user", null, `Deleted role: ${role.name}`, {
    actorId: actorUser.id,
    actorUsername: actorUser.username,
  })
  return { success: true, msg: null }
}

export const getUserPasswordHash = (db: Database.Database, userId: number): string | null => {
  const row = db
    .prepare(`SELECT passwordHash FROM user WHERE id = ? AND deletedAt IS NULL`)
    .get(userId) as { passwordHash: string } | undefined
  return row?.passwordHash ?? null
}

export const updateUserShowPosters = (db: Database.Database, userId: number, enabled: 0 | 1): void => {
  db.prepare(`UPDATE user SET showPosters = ?, updatedAt = datetime('now') WHERE id = ?`).run(enabled, userId)
}

export const updateUserSelectedTheme = (db: Database.Database, userId: number, themeId: number): DefaultResponse => {
  const theme = db.prepare(`SELECT id FROM theme WHERE id = ?`).get(themeId) as { id: number } | undefined
  if (!theme) return { success: false, msg: "Theme not found" }
  db.prepare(`UPDATE user SET selectedThemeId = ?, updatedAt = datetime('now') WHERE id = ?`).run(themeId, userId)
  return { success: true, msg: "Theme updated" }
}

export const getRolesWithPermissions = (db: Database.Database): (DBRole & { permissionKeys: string[] })[] => {
  const roles = db.prepare(`SELECT * FROM role ORDER BY level DESC`).all() as DBRole[]
  return roles.map((r) => {
    const perms = db
      .prepare(
        `SELECT p.key FROM rolePermission rp
         JOIN permission p ON p.id = rp.permissionId
         WHERE rp.roleId = ?`,
      )
      .all(r.id) as { key: string }[]
    return { ...r, permissionKeys: perms.map((p) => p.key) }
  })
}

export const deleteUser = (db: Database.Database, actorUser: DBUser, userId: number): DefaultResponse => {
  const { hasPermission: perm } = _userHasPermission(db, actorUser.id, "canAddUser")
  if (!perm) return { success: false, msg: "Permission denied" }
  if (actorUser.id === userId) return { success: false, msg: "Users cannot delete themselves" }
  if (!canManageTargetUser(db, actorUser.id, userId)) {
    return { success: false, msg: "Cannot delete a user with equal or higher role level" }
  }

  const userToDelete = getUserById(db, userId)
  if (!userToDelete) return { success: false, msg: "User to delete not found" }

  db.prepare(`UPDATE user SET deletedAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?`).run(userId)
  deleteAllSessionsForUser(db, userId)
  createLog(db, "info", "user", userId, `Deleted user: ${userToDelete.username}`, {
    username: userToDelete.username,
    deletedByUserId: actorUser.id,
    deletedByUsername: actorUser.username,
  })

  return { success: true, msg: null }
}
