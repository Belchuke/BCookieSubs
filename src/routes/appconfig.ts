import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import { getConfig, updateConfig, updateRootLibraryPath } from "../repositories/configRepository"
import { addConfigTranslationLanguage, getConfigTranslationLanguages, getLanguages, removeConfigTranslationLanguage, reorderConfigTranslationLanguages } from "../repositories/languageRepository"
import { setOrUpdateSecret } from "../repositories/movieDbRepository"
import { getListOfSecretsToAdd, getSecrets } from "../repositories/secretRepository"
import { createTheme, deleteTheme, getActiveTheme, getThemes, setSelectedTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"

const upload = multer()

export function appconfigRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, (req, res) => {
    const user = res.locals.user!
    const config = getConfig(db)
    const languages = getLanguages(db)
    const configLangs = getConfigTranslationLanguages(db)
    const canSeeSecrets = user.isAdmin || user.canManageSecret
    const secrets = canSeeSecrets ? getSecrets(db, user) : { success: false, secrets: [] }
    const keys = getListOfSecretsToAdd()
    const theme = getActiveTheme(db)
    const themes = getThemes(db)

    res.render("config", {
      user,
      activeNav: "config",
      config,
      languages,
      configLangs,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      canSeeSecrets,
      secrets: secrets.success ? secrets.secrets : [],
      keys,
      theme,
      themes,
    })
  })

  
  router.post("/", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    const {
      defaultChunkSize,
      maxRetriesPerChunk,
      showPosters,
      nameDetectionActive,
      theMovieDbActive,
      finishSingleSubtitleFirst,
      scanLibraryPaths,
      scheduleConfigured,
      clearLogs,
      clearLogsOlderThanDays,
      sessionTimeoutMinutes,
      rootLibraryPath,
    } = req.body as Record<string, string>

    const result = updateConfig(
      db,
      user,
      parseInt(defaultChunkSize) || 12,
      parseInt(maxRetriesPerChunk) || 5,
      showPosters === "1",
      nameDetectionActive === "1",
      theMovieDbActive === "1",
      finishSingleSubtitleFirst === "1",
      scanLibraryPaths === "1",
      scheduleConfigured === "1",
      clearLogs === "1",
      parseInt(clearLogsOlderThanDays) || 30,
      parseInt(sessionTimeoutMinutes) || 120,
    )

    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to save config"))
    }

        if (rootLibraryPath !== undefined && (user.isAdmin || user.canManageRootLibraryPath)) {
      updateRootLibraryPath(db, user, rootLibraryPath.trim() || null)
    }

    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Configuration saved"))
  })

  
  router.post("/rootpath", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canManageRootLibraryPath) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent("Permission denied"))
    }
    const { rootLibraryPath } = req.body as { rootLibraryPath?: string }
    const result = updateRootLibraryPath(db, user, rootLibraryPath?.trim() || null)
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to save"))
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Root library path saved"))
  })

  
  router.post("/translationlangs/add", requireAuth, upload.none(), (req, res) => {
    const { languageId } = req.body as { languageId: string }

    const result = addConfigTranslationLanguage(db, res.locals.user!, parseInt(languageId))
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to add"))
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Language added to defaults"))
  })

  router.post("/translationlangs/remove/:langId", requireAuth, (req, res) => {
    const result = removeConfigTranslationLanguage(db, res.locals.user!, parseInt(String(req.params.langId)))
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to remove"))
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Language removed from defaults"))
  })

  router.post("/translationlangs/move/:langId", requireAuth, upload.none(), (req, res) => {
    const { direction } = req.body as { direction: "up" | "down" }

    const result = reorderConfigTranslationLanguages(
      db,
      res.locals.user!,
      parseInt(String(req.params.langId)),
      direction,
    )
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to reorder"))
    }
    res.redirect("/config")
  })

  
  router.post("/secrets/set", requireAuth, upload.none(), (req, res) => {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canManageSecret) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent("Permission denied"))
    }
    const { secretName, secretValue } = req.body as { secretName: string; secretValue: string }
    const result = setOrUpdateSecret(db, user, secretName, secretValue, false)
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to set secret"))
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Secret set successfully"))
  })

  router.post("/secrets/delete/:secretName", requireAuth, (req, res) => {
    const user = res.locals.user!
    if (!user.isAdmin && !user.canManageSecret) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent("Permission denied"))
    }
    const result = setOrUpdateSecret(db, user, String(req.params.secretName), "", true)
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to delete secret"))
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Secret deleted successfully"))
  })

  
  router.post("/theme/select", requireAuth, upload.none(), (req, res) => {
    const { themeId } = req.body as { themeId: string }
    const result = setSelectedTheme(db, res.locals.user!, parseInt(themeId))
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to set theme"))
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Theme updated"))
  })

  router.post("/theme/create", requireAuth, upload.none(), (req, res) => {
    const b = req.body as Record<string, string>
    const result = createTheme(db, res.locals.user!, {
      name: b.name,
      bg: b.bg, surface: b.surface, surface2: b.surface2, surface3: b.surface3, borderColor: b.borderColor,
      textColor: b.textColor, textDim: b.textDim, textHint: b.textHint,
      accent: b.accent, accentDim: b.accentDim,
      success: b.success, successDim: b.successDim,
      warning: b.warning, warningDim: b.warningDim,
      error: b.error, errorDim: b.errorDim,
      infoDim: b.infoDim,
    })
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create theme"))
    }
    if (result.theme) {
      setSelectedTheme(db, res.locals.user!, result.theme.id)
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Theme created and applied"))
  })

  router.post("/theme/delete/:id", requireAuth, (req, res) => {
    const result = deleteTheme(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/config?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to delete theme"))
    }
    res.redirect("/config?toast=success&msg=" + encodeURIComponent("Theme deleted"))
  })

  return router
}
