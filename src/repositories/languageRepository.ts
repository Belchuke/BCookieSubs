import Database from "better-sqlite3"
import { DBUser, DBLanguage, DBConfigTranslationLanguage, DBUserConfigTranslationLanguage } from "../types/dbTypes"
import { DefaultResponse } from "../types/modelTypes"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"

// Derive the flag-icons country code from the language locale string.
// Examples: "en-US" → "us", "zh-TW" → "tw", "cy-GB" → "gb-wls", "gd-GB" → "gb-sct"
function deriveFlagCode(locale: string | null): string | null {
  if (!locale) return null
  const lower = locale.toLowerCase()
  // Special sub-national flags supported by flag-icons
  if (lower === "cy-gb")  return "gb-wls"  // Welsh
  if (lower === "gd-gb")  return "gb-sct"  // Scottish Gaelic
  if (lower === "ga-ie")  return "ie"
  if (lower === "eu-es")  return "es"      // Basque → Spain
  if (lower === "ca-es")  return "es"      // Catalan → Spain
  if (lower === "gl-es")  return "es"      // Galician → Spain
  if (lower === "eo-001") return "un"      // Esperanto → UN flag (no Esperanto flag in flag-icons)
  // Generic: take the country portion after the hyphen
  const parts = lower.split("-")
  if (parts.length >= 2) return parts[1]
  return null
}

function withFlagCode<T extends { locale: string; flagCode?: string | null }>(row: T): T {
  return { ...row, flagCode: deriveFlagCode(row.locale) }
}

export const getLanguages = (db: Database.Database): DBLanguage[] => {
  return (db.prepare(`SELECT * FROM language ORDER BY name ASC`).all() as DBLanguage[]).map(withFlagCode)
}

export const getLanguageById = (db: Database.Database, id: number): DBLanguage | null => {
  const result = db.prepare(`SELECT * FROM language WHERE id = ?`).get(id) as DBLanguage | undefined
  return result ? withFlagCode(result) : null
}

// Look up a language by its ISO 639-1 (or fall back to 639-2/B) code, e.g. "da".
export const getLanguageByIso = (db: Database.Database, iso: string): DBLanguage | null => {
  const code = iso.trim().toLowerCase()
  if (!code) return null
  const result = db
    .prepare(`SELECT * FROM language WHERE lower(iso639) = ? OR lower(iso6392b) = ? LIMIT 1`)
    .get(code, code) as DBLanguage | undefined
  return result ? withFlagCode(result) : null
}

export const addLanguage = (
  db: Database.Database,
  user: DBUser,
  name: string,
  iso639: string,
  locale: string,
  flag: string | null,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
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
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
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

  syncUserConfigTranslationLanguagesFromGlobal(db, user.id)

  createLog(db, "info", "config", null, "Added language to translation config", { languageId })
  return { success: true, msg: "Language added to translation config successfully" }
}

export const reorderConfigTranslationLanguages = (
  db: Database.Database,
  user: DBUser,
  languageId: number,
  positionChange: "up" | "down",
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
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

  syncUserConfigTranslationLanguagesFromGlobal(db, user.id)

  return { success: true, msg: "Language order updated successfully" }
}

export const removeConfigTranslationLanguage = (
  db: Database.Database,
  user: DBUser,
  languageId: number,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSettings")
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

  syncUserConfigTranslationLanguagesFromGlobal(db, user.id)

  return { success: true, msg: "Language removed from translation config successfully" }
}

export const getUserConfigTranslationLanguages = (
  db: Database.Database,
  userId: number,
): DBUserConfigTranslationLanguage[] => {
  return db
    .prepare(`SELECT * FROM userConfigTranslationLanguage WHERE userId = ? ORDER BY orderNumber ASC`)
    .all(userId) as DBUserConfigTranslationLanguage[]
}

export const addUserConfigTranslationLanguage = (
  db: Database.Database,
  userId: number,
  languageId: number,
): DefaultResponse => {
  const language = getLanguageById(db, languageId)
  if (!language) return { success: false, msg: "Language not found" }

  const getCurrent = db
    .prepare(`SELECT * FROM userConfigTranslationLanguage WHERE userId = ?`)
    .all(userId) as DBUserConfigTranslationLanguage[]
  if (getCurrent.find((ctl) => ctl.languageId === languageId)) {
    return { success: false, msg: "Language is already in the user's translation list" }
  }

  const highestOrder = getCurrent.reduce((max, ctl) => (ctl.orderNumber > max ? ctl.orderNumber : max), 0)
  db.prepare(`INSERT INTO userConfigTranslationLanguage (userId, languageId, orderNumber) VALUES (?, ?, ?)`).run(
    userId,
    languageId,
    highestOrder + 1,
  )

  return { success: true, msg: "Language added to user's translation config successfully" }
}

export const reorderUserConfigTranslationLanguages = (
  db: Database.Database,
  userId: number,
  languageId: number,
  positionChange: "up" | "down",
): DefaultResponse => {
  const languages = getUserConfigTranslationLanguages(db, userId)
  const index = languages.findIndex((ctl) => ctl.languageId === languageId)
  if (index === -1) return { success: false, msg: "Language not found in user's translation config" }
  if (positionChange === "up" && index === 0) return { success: false, msg: "Language is already at the top" }
  if (positionChange === "down" && index === languages.length - 1) {
    return { success: false, msg: "Language is already at the bottom" }
  }

  const swapWithIndex = positionChange === "up" ? index - 1 : index + 1
  const current = languages[index]
  const swap = languages[swapWithIndex]

  db.prepare(`UPDATE userConfigTranslationLanguage SET orderNumber = ? WHERE userId = ? AND languageId = ?`).run(
    swap.orderNumber,
    userId,
    current.languageId,
  )
  db.prepare(`UPDATE userConfigTranslationLanguage SET orderNumber = ? WHERE userId = ? AND languageId = ?`).run(
    current.orderNumber,
    userId,
    swap.languageId,
  )

  return { success: true, msg: "Language order updated successfully" }
}

export const removeUserConfigTranslationLanguage = (
  db: Database.Database,
  userId: number,
  languageId: number,
): DefaultResponse => {
  const language = getLanguageById(db, languageId)
  if (!language) return { success: false, msg: "Language not found" }

  const languages = getUserConfigTranslationLanguages(db, userId)
  const entry = languages.find((ctl) => ctl.languageId === languageId)

  db.prepare(`DELETE FROM userConfigTranslationLanguage WHERE userId = ? AND languageId = ?`).run(userId, languageId)
  if (entry) {
    db.prepare(
      `UPDATE userConfigTranslationLanguage SET orderNumber = orderNumber - 1 WHERE userId = ? AND orderNumber > ?`,
    ).run(userId, entry.orderNumber)
  }

  return { success: true, msg: "Language removed from user's translation config successfully" }
}

export const setConfigTranslationLanguages = (db: Database.Database, languageIds: number[]): void => {
  db.prepare(`DELETE FROM configTranslationLanguage`).run()
  languageIds.forEach((langId, idx) => {
    db.prepare(`INSERT OR IGNORE INTO configTranslationLanguage (languageId, orderNumber) VALUES (?, ?)`).run(langId, idx + 1)
  })
}

export const syncUserConfigTranslationLanguagesFromGlobal = (db: Database.Database, userId: number): void => {
  const globalLangs = db
    .prepare(`SELECT * FROM configTranslationLanguage ORDER BY orderNumber ASC`)
    .all() as DBConfigTranslationLanguage[]
  db.prepare(`DELETE FROM userConfigTranslationLanguage WHERE userId = ?`).run(userId)
  for (const lang of globalLangs) {
    db.prepare(`INSERT INTO userConfigTranslationLanguage (userId, languageId, orderNumber) VALUES (?, ?, ?)`).run(
      userId,
      lang.languageId,
      lang.orderNumber,
    )
  }
}
