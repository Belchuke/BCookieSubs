import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import bcrypt from "bcrypt"
import {
  getLanguages,
  getUserConfigTranslationLanguages,
  addUserConfigTranslationLanguage,
  removeUserConfigTranslationLanguage,
  reorderUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import { getActiveTheme, getThemes } from "../repositories/themeRepository"
import { getUserPasswordHash, updateUserPassword, updateUserSelectedTheme, updateUserShowPosters, updateUserUsername, updateUserLanguage } from "../repositories/userRepository"
import { isSupportedLocale } from "../i18n"
import { getUserRoles } from "../services/permissionService"
import { requireAuth } from "../middleware/auth"

const upload = multer()

export function accountRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, (req, res) => {
    const user = res.locals.user!
    const theme = getActiveTheme(db, user.id)
    const themes = getThemes(db)
    const languages = getLanguages(db)
    const userConfigLangs = getUserConfigTranslationLanguages(db, user.id)
    const userRoles = getUserRoles(db, user.id)

    res.render("account", {
      user,
      activeNav: "account",
      theme,
      themes,
      languages,
      userConfigLangs,
      userRoles,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      supportedLocales: res.locals.supportedLocales,
      localeLabels: res.locals.localeLabels,
    })
  })

  router.post("/username", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const { username } = req.body as { username?: string }

    if (!username || !username.trim()) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("Username is required"))
    }

    const result = updateUserUsername(db, user.id, username.trim())
    if (!result.success) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to update username"))
    }

    res.redirect("/account?toast=success&msg=" + encodeURIComponent("Username updated"))
  })

  router.post("/password", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const { currentPassword, newPassword, newPassword2 } = req.body as {
      currentPassword?: string
      newPassword?: string
      newPassword2?: string
    }

    if (!currentPassword || !newPassword) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("All fields are required"))
    }
    if (newPassword.length < 8) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("Password must be at least 8 characters"))
    }
    if (newPassword !== newPassword2) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("Passwords do not match"))
    }

    const passwordHash = getUserPasswordHash(db, user.id)
    if (!passwordHash) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("User not found"))
    }

    const match = bcrypt.compareSync(currentPassword, passwordHash)
    if (!match) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("Current password is incorrect"))
    }

    const result = updateUserPassword(db, user, user.id, newPassword)
    if (!result.success) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to update password"))
    }

    res.clearCookie("st_session")
    res.redirect("/login?error=" + encodeURIComponent("Password changed — please sign in again"))
  })

  router.post("/showPosters", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const enabled = req.body.showPosters === "1" ? 1 : 0
    updateUserShowPosters(db, user.id, enabled)
    res.redirect("/account?toast=success&msg=" + encodeURIComponent("Preference saved"))
  })

  router.post("/theme", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const { themeId } = req.body as { themeId?: string }
    const id = parseInt(themeId || "")
    if (isNaN(id)) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("Invalid theme"))
    }

    const result = updateUserSelectedTheme(db, user.id, id)
    if (!result.success) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent(result.msg ?? "Theme not found"))
    }
    res.redirect("/account?toast=success&msg=" + encodeURIComponent("Theme updated"))
  })

  router.post("/translationlangs/add", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const { languageId } = req.body as { languageId?: string }
    const result = addUserConfigTranslationLanguage(db, user.id, parseInt(languageId || ""))
    if (!result.success) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to add"))
    }
    res.redirect("/account?toast=success&msg=" + encodeURIComponent("Language added"))
  })

  router.post("/translationlangs/remove/:langId", requireAuth, (req, res) => {
    const user = res.locals.user!
    const result = removeUserConfigTranslationLanguage(db, user.id, parseInt(String(req.params.langId)))
    if (!result.success) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to remove"))
    }
    res.redirect("/account?toast=success&msg=" + encodeURIComponent("Language removed"))
  })

  router.post("/language", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const { language } = req.body as { language?: string }
    const lang = !language || language === "system" ? null : language
    if (lang !== null && !isSupportedLocale(lang)) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("Unsupported language"))
    }
    updateUserLanguage(db, user.id, lang)
    res.redirect("/account?toast=success&msg=" + encodeURIComponent("Language preference saved"))
  })

  router.post("/translationlangs/move/:langId", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const { direction } = req.body as { direction?: "up" | "down" }
    if (direction !== "up" && direction !== "down") {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent("Invalid direction"))
    }
    const result = reorderUserConfigTranslationLanguages(db, user.id, parseInt(String(req.params.langId)), direction)
    if (!result.success) {
      return res.redirect("/account?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to reorder"))
    }
    res.redirect("/account")
  })

  return router
}
