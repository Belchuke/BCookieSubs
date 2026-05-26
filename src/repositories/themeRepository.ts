import Database from "better-sqlite3"
import { DBUser, DBTheme } from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"
import { userHasPermission } from "../services/permissionService"

export const getActiveTheme = (db: Database.Database, userId?: number): DBTheme => {
  if (userId) {
    const theme = db
      .prepare(`SELECT t.* FROM theme t INNER JOIN user u ON t.id = u.selectedThemeId WHERE u.id = ?`)
      .get(userId) as DBTheme | undefined
    if (theme) return theme
  }
  return db.prepare(`SELECT t.* FROM theme t INNER JOIN config c ON t.id = c.selectedThemeId`).get() as DBTheme
}

export const getThemes = (db: Database.Database): DBTheme[] => {
  return db.prepare(`SELECT * FROM theme ORDER BY isPublic DESC, name ASC`).all() as DBTheme[]
}

export const setSelectedTheme = (db: Database.Database, user: DBUser, themeId: number): DefaultResponse => {
  if (!userHasPermission(db, user.id, "canManageSettings").hasPermission)
    return { success: false, msg: "Permission denied" }
  const theme = db.prepare(`SELECT id FROM theme WHERE id = ?`).get(themeId) as { id: number } | undefined
  if (!theme) return { success: false, msg: "Theme not found" }
  db.prepare(`UPDATE config SET selectedThemeId = ?, updatedAt = datetime('now') WHERE id = 1`).run(themeId)
  return { success: true, msg: "Theme updated" }
}

export const createTheme = (
  db: Database.Database,
  user: DBUser,
  data: {
    name: string
    bg: string
    surface: string
    surface2: string
    surface3: string
    borderColor: string
    textColor: string
    textDim: string
    textHint: string
    accent: string
    accentDim: string
    success: string
    successDim: string
    warning: string
    warningDim: string
    error: string
    errorDim: string
    infoDim: string
  },
): { theme: DBTheme | null } & DefaultResponse => {
  if (!userHasPermission(db, user.id, "canManageSettings").hasPermission)
    return { theme: null, success: false, msg: "Permission denied" }
  try {
    const result = db
      .prepare(
        `
      INSERT INTO theme (name, bg, surface, surface2, surface3, borderColor, textColor, textDim, textHint,
        accent, accentDim, success, successDim, warning, warningDim, error, errorDim, infoDim, createdByUserId, isPublic)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `,
      )
      .run(
        data.name,
        data.bg,
        data.surface,
        data.surface2,
        data.surface3,
        data.borderColor,
        data.textColor,
        data.textDim,
        data.textHint,
        data.accent,
        data.accentDim,
        data.success,
        data.successDim,
        data.warning,
        data.warningDim,
        data.error,
        data.errorDim,
        data.infoDim,
        user.id,
      )
    const theme = db.prepare(`SELECT * FROM theme WHERE id = ?`).get(result.lastInsertRowid) as DBTheme
    return { success: true, msg: "Theme created", theme }
  } catch (e) {
    return { theme: null, success: false, msg: e instanceof Error ? e.message : "Failed to create theme" }
  }
}

export const deleteTheme = (db: Database.Database, user: DBUser, themeId: number): DefaultResponse => {
  if (!userHasPermission(db, user.id, "canManageSettings").hasPermission)
    return { success: false, msg: "Permission denied" }
  const theme = db.prepare(`SELECT id, isPublic FROM theme WHERE id = ?`).get(themeId) as
    | { id: number; isPublic: number }
    | undefined
  if (!theme) return { success: false, msg: "Theme not found" }
  if (theme.isPublic) return { success: false, msg: "Cannot delete built-in themes" }
  const config = db.prepare(`SELECT selectedThemeId FROM config WHERE id = 1`).get() as { selectedThemeId: number }
  if (config.selectedThemeId === themeId) {
    db.prepare(`UPDATE config SET selectedThemeId = 1, updatedAt = datetime('now') WHERE id = 1`).run()
  }
  db.prepare(`DELETE FROM theme WHERE id = ?`).run(themeId)
  return { success: true, msg: "Theme deleted" }
}
