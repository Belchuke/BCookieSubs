import Database from "better-sqlite3"
import { Request, Response, NextFunction } from "express"
import { DBRole, DBUser } from "../types/dbTypes"
import { PermissionKey } from "../constants/permissions"

export const userHasPermission = (
  db: Database.Database,
  userId: number,
  permission: string,
): { hasPermission: boolean; user: DBUser | null } => {
  const row = db.prepare(`
    SELECT 1
    FROM userRole ur
    JOIN rolePermission rp ON rp.roleId = ur.roleId
    JOIN permission p ON p.id = rp.permissionId
    WHERE ur.userId = ? AND p.key = ?
    LIMIT 1
  `).get(userId, permission)
  return { hasPermission: !!row, user: null }
}

export const getUserPermissions = (
  db: Database.Database,
  userId: number,
): Set<string> => {
  const rows = db.prepare(`
    SELECT DISTINCT p.key
    FROM userRole ur
    JOIN rolePermission rp ON rp.roleId = ur.roleId
    JOIN permission p ON p.id = rp.permissionId
    WHERE ur.userId = ?
  `).all(userId) as { key: string }[]
  return new Set(rows.map((r) => r.key))
}

export const getUserRoles = (
  db: Database.Database,
  userId: number,
): DBRole[] => {
  return db.prepare(`
    SELECT r.*
    FROM userRole ur
    JOIN role r ON r.id = ur.roleId
    WHERE ur.userId = ?
    ORDER BY r.level DESC
  `).all(userId) as DBRole[]
}

export const getUserHighestRole = (
  db: Database.Database,
  userId: number,
): DBRole | null => {
  return (
    db.prepare(`
      SELECT r.*
      FROM userRole ur
      JOIN role r ON r.id = ur.roleId
      WHERE ur.userId = ?
      ORDER BY r.level DESC
      LIMIT 1
    `).get(userId) as DBRole | null
  )
}

export const getUserHighestRoleLevel = (
  db: Database.Database,
  userId: number,
): number => {
  const role = getUserHighestRole(db, userId)
  return role?.level ?? 0
}

export const canAssignRole = (
  db: Database.Database,
  actorUserId: number,
  roleId: number,
): boolean => {
  const actorLevel = getUserHighestRoleLevel(db, actorUserId)
  const role = db.prepare(`SELECT level FROM role WHERE id = ?`).get(roleId) as { level: number } | null
  if (!role) return false
  return actorLevel >= role.level
}

export const canManageTargetUser = (
  db: Database.Database,
  actorUserId: number,
  targetUserId: number,
): boolean => {
  if (actorUserId === targetUserId) return true
  const actorLevel = getUserHighestRoleLevel(db, actorUserId)
  const targetLevel = getUserHighestRoleLevel(db, targetUserId)
  return actorLevel > targetLevel
}

export const canChangeTargetPassword = (
  db: Database.Database,
  actorUserId: number,
  targetUserId: number,
): boolean => {
  if (actorUserId === targetUserId) return true
  const actorLevel = getUserHighestRoleLevel(db, actorUserId)
  const targetLevel = getUserHighestRoleLevel(db, targetUserId)
  return actorLevel > targetLevel
}

export const canGrantPermission = (
  db: Database.Database,
  actorUserId: number,
  permissionKey: PermissionKey,
): boolean => {
  return userHasPermission(db, actorUserId, permissionKey).hasPermission
}

export const requirePermission = (permissionKey: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user
    if (!user) {
      const wantsJson =
        req.xhr ||
        (req.get("accept") || "").includes("application/json") ||
        req.path.endsWith("/poll")
      if (wantsJson) {
        res.status(401).json({ success: false, msg: "Session expired", redirect: "/login" })
      } else {
        res.redirect("/login")
      }
      return
    }
    const { hasPermission } = userHasPermission(req.app.locals.db, user.id, permissionKey)
    if (!hasPermission) {
      const wantsJson =
        req.xhr ||
        (req.get("accept") || "").includes("application/json") ||
        req.path.endsWith("/poll")
      if (wantsJson) {
        res.status(403).json({ success: false, msg: "Permission denied" })
      } else {
        res.status(403).redirect("/dashboard")
      }
      return
    }
    next()
  }
}

export const requireAnyPermission = (permissionKeys: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user
    if (!user) {
      res.status(401).json({ success: false, msg: "Not authenticated" })
      return
    }
    const db = req.app.locals.db
    const hasAny = permissionKeys.some((key) => userHasPermission(db, user.id, key).hasPermission)
    if (!hasAny) {
      const wantsJson =
        req.xhr ||
        (req.get("accept") || "").includes("application/json") ||
        req.path.endsWith("/poll")
      if (wantsJson) {
        res.status(403).json({ success: false, msg: "Permission denied" })
      } else {
        res.status(403).redirect("/dashboard")
      }
      return
    }
    next()
  }
}

export const requireRoleLevel = (minLevel: number) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = res.locals.user
    if (!user) {
      res.status(401).json({ success: false, msg: "Not authenticated" })
      return
    }
    const level = getUserHighestRoleLevel(req.app.locals.db, user.id)
    if (level < minLevel) {
      const wantsJson =
        req.xhr ||
        (req.get("accept") || "").includes("application/json") ||
        req.path.endsWith("/poll")
      if (wantsJson) {
        res.status(403).json({ success: false, msg: "Permission denied" })
      } else {
        res.status(403).redirect("/dashboard")
      }
      return
    }
    next()
  }
}
