import Database from "better-sqlite3"
import { DBRole } from "../types/dbTypes"

// Pure data-access for the role/permission tables. All permission-related SQL
// lives here; src/services/permissionService.ts holds the logic/middleware that
// builds on top of these queries.

export const selectUserHasPermission = (db: Database.Database, userId: number, permission: string): boolean => {
  const row = db
    .prepare(
      `
    SELECT 1
    FROM userRole ur
    JOIN rolePermission rp ON rp.roleId = ur.roleId
    JOIN permission p ON p.id = rp.permissionId
    WHERE ur.userId = ? AND p.key = ?
    LIMIT 1
  `,
    )
    .get(userId, permission)
  return !!row
}

export const selectUserPermissionKeys = (db: Database.Database, userId: number): string[] => {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT p.key
    FROM userRole ur
    JOIN rolePermission rp ON rp.roleId = ur.roleId
    JOIN permission p ON p.id = rp.permissionId
    WHERE ur.userId = ?
  `,
    )
    .all(userId) as { key: string }[]
  return rows.map((r) => r.key)
}

export const selectUserRoles = (db: Database.Database, userId: number): DBRole[] => {
  return db
    .prepare(
      `
    SELECT r.*
    FROM userRole ur
    JOIN role r ON r.id = ur.roleId
    WHERE ur.userId = ?
    ORDER BY r.level DESC
  `,
    )
    .all(userId) as DBRole[]
}

export const selectUserHighestRole = (db: Database.Database, userId: number): DBRole | null => {
  return (
    (db
      .prepare(
        `
      SELECT r.*
      FROM userRole ur
      JOIN role r ON r.id = ur.roleId
      WHERE ur.userId = ?
      ORDER BY r.level DESC
      LIMIT 1
    `,
      )
      .get(userId) as DBRole | undefined) ?? null
  )
}

export const selectRoleLevel = (db: Database.Database, roleId: number): number | null => {
  const role = db.prepare(`SELECT level FROM role WHERE id = ?`).get(roleId) as { level: number } | undefined
  return role?.level ?? null
}
