import Database from "better-sqlite3"
import { DBUser, DBLanguage, DBConfigTranslationLanguage } from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"

export const getLanguages = (db: Database.Database): DBLanguage[] => {
  return db.prepare(`SELECT * FROM language ORDER BY name ASC`).all() as DBLanguage[]
}

export const getLanguageById = (db: Database.Database, id: number): DBLanguage | null => {
  const result = db.prepare(`SELECT * FROM language WHERE id = ?`).get(id) as DBLanguage | undefined
  return result ?? null
}

export const addLanguage = (
  db: Database.Database,
  user: DBUser,
  name: string,
  iso639: string,
  locale: string,
  flag: string | null,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageLanguages")
  if (!perm) return { success: false, msg: "User does not have permission to manage languages" }

  const existing = db.prepare(`SELECT * FROM language WHERE iso639 = ? AND locale = ?`).get(iso639, locale) as
    | DBLanguage
    | undefined

  if (existing) return { success: false, msg: "Language with the same ISO 639 + locale already exists" }

  db.prepare(`INSERT INTO language (name, iso639, locale, flag) VALUES (?, ?, ?, ?)`).run(name, iso639, locale, flag)

  return { success: true, msg: "Language added successfully" }
}

export const getConfigTranslationLanguageByLanguageId = (
  db: Database.Database,
  languageId: number,
): DBConfigTranslationLanguage | null => {
  const result = db.prepare(`SELECT * FROM configTranslationLanguage WHERE languageId = ?`).get(languageId) as
    | DBConfigTranslationLanguage
    | undefined
  return result ?? null
}

export const getConfigTranslationLanguages = (db: Database.Database): DBConfigTranslationLanguage[] => {
  return db
    .prepare(`SELECT * FROM configTranslationLanguage ORDER BY orderNumber ASC`)
    .all() as DBConfigTranslationLanguage[]
}

export const addConfigTranslationLanguage = (
  db: Database.Database,
  user: DBUser,
  languageId: number,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageLanguages")
  if (!perm) return { success: false, msg: "User does not have permission to manage languages" }

  const language = getLanguageById(db, languageId)
  if (!language) return { success: false, msg: "Language not found" }

  const getCurrent = db.prepare(`SELECT * FROM configTranslationLanguage`).all() as DBConfigTranslationLanguage[]
  if (getCurrent.find((ctl) => ctl.languageId === languageId)) {
    return { success: false, msg: "Language is already in the translation list" }
  }

  const highestOrder = getCurrent.reduce((max, ctl) => (ctl.orderNumber > max ? ctl.orderNumber : max), 0)
  db.prepare(`INSERT INTO configTranslationLanguage (languageId, orderNumber) VALUES (?, ?)`).run(
    languageId,
    highestOrder + 1,
  )

  createLog(db, "info", "config", null, "Added language to translation config", { languageId })
  return { success: true, msg: "Language added to translation config successfully" }
}

export const reorderConfigTranslationLanguages = (
  db: Database.Database,
  user: DBUser,
  languageId: number,
  positionChange: "up" | "down",
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageConfig")
  if (!perm) return { success: false, msg: "User does not have permission to manage config" }

  const languages = getConfigTranslationLanguages(db)
  const index = languages.findIndex((ctl) => ctl.languageId === languageId)
  if (index === -1) return { success: false, msg: "Language not found in translation config" }
  if (positionChange === "up" && index === 0) return { success: false, msg: "Language is already at the top" }
  if (positionChange === "down" && index === languages.length - 1) {
    return { success: false, msg: "Language is already at the bottom" }
  }

  const swapWithIndex = positionChange === "up" ? index - 1 : index + 1
  const current = languages[index]
  const swap = languages[swapWithIndex]

  db.prepare(`UPDATE configTranslationLanguage SET orderNumber = ? WHERE languageId = ?`).run(
    swap.orderNumber,
    current.languageId,
  )
  db.prepare(`UPDATE configTranslationLanguage SET orderNumber = ? WHERE languageId = ?`).run(
    current.orderNumber,
    swap.languageId,
  )

  return { success: true, msg: "Language order updated successfully" }
}

export const removeConfigTranslationLanguage = (
  db: Database.Database,
  user: DBUser,
  languageId: number,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageConfig")
  if (!perm) return { success: false, msg: "User does not have permission to manage config" }

  const language = getLanguageById(db, languageId)
  if (!language) return { success: false, msg: "Language not found" }

  const languages = getConfigTranslationLanguages(db)
  const entry = languages.find((ctl) => ctl.languageId === languageId)

  db.prepare(`DELETE FROM configTranslationLanguage WHERE languageId = ?`).run(languageId)
  if (entry) {
    db.prepare(`UPDATE configTranslationLanguage SET orderNumber = orderNumber - 1 WHERE orderNumber > ?`).run(
      entry.orderNumber,
    )
  }

  createLog(db, "info", "config", null, "Removed language from translation config", { languageId })
  return { success: true, msg: "Language removed from translation config successfully" }
}
