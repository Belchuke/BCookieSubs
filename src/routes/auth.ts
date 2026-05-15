import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import { getConfig } from "../repositories/configRepository"
import { addModel, getModelsListWithRoles, updateRolesForModel } from "../repositories/modelRepository"
import { getModelsFromOllama } from "../repositories/ollamaRepository"
import { getRecommendedModelById, getRecommendedModels } from "../repositories/recommendedModelRepository"
import { deleteSession } from "../repositories/sessionRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { createInitialAdminUser, hasAdminUser, verifyUserPassword } from "../repositories/userRepository"
import { ollamaApiSecretKey } from "../setup"
import { requireAuth, requireNoAuth } from "../middleware/auth"

const upload = multer()

export function authRouter(db: Database.Database) {
  const router = Router()

    router.get("/", (req, res) => {
    if (!hasAdminUser(db)) return res.redirect("/setup/1")
    if (res.locals.user) return res.redirect("/dashboard")
    res.redirect("/login")
  })

  
  router.get("/login", requireNoAuth, (req, res) => {
    res.render("login", { error: req.query.error ?? null, theme: getActiveTheme(db) })
  })

  router.post("/login", requireNoAuth, upload.none(), (req, res) => {
    const { username, password } = req.body as { username: string; password: string }

    if (!username || !password) {
      return res.redirect("/login?error=" + encodeURIComponent("Username and password are required"))
    }

    const result = verifyUserPassword(db, username, password)
    if (!result.success || !result.token) {
      return res.redirect("/login?error=" + encodeURIComponent(result.msg ?? "Invalid username or password"))
    }

    const config = getConfig(db)
    res.cookie("st_session", result.token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: config.sessionTimeoutMinutes * 60 * 1000,
    })

    const next = typeof req.query.next === "string" ? req.query.next : "/dashboard"
    res.redirect(next)
  })

  router.post("/logout", requireAuth, (req, res) => {
    const token = res.locals.sessionToken
    if (token) deleteSession(db, token)
    res.clearCookie("st_session")
    res.redirect("/login")
  })

  
  router.get("/setup/1", (req, res) => {
    if (hasAdminUser(db)) return res.redirect("/")
    res.render("setup/step1", { error: req.query.error ?? null, theme: getActiveTheme(db) })
  })

  router.post("/setup/1", upload.none(), (req, res) => {
    if (hasAdminUser(db)) return res.redirect("/")

    const { username, password, password2 } = req.body as {
      username: string
      password: string
      password2: string
    }

    if (!username || !password) {
      return res.redirect("/setup/1?error=" + encodeURIComponent("Username and password are required"))
    }
    if (password !== password2) {
      return res.redirect("/setup/1?error=" + encodeURIComponent("Passwords do not match"))
    }
    if (password.length < 8) {
      return res.redirect("/setup/1?error=" + encodeURIComponent("Password must be at least 8 characters"))
    }

    const result = createInitialAdminUser(db, username, password)
    if (!result.success || !result.token) {
      return res.redirect("/setup/1?error=" + encodeURIComponent(result.msg ?? "Failed to create admin user"))
    }

    const config = getConfig(db)
    res.cookie("st_session", result.token, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: config.sessionTimeoutMinutes * 60 * 1000,
    })
    res.redirect("/setup/2")
  })

  
  router.get("/setup/2", requireAuth, async (req, res) => {
    let ollamaModels: string[] = []
    let ollamaError: string | null = null

    try {
      const result = await getModelsFromOllama()
      if (result.error) {
        ollamaError = result.ollamaRunning === false ? "Ollama is not running." : result.error
      }
      ollamaModels = result.models.map((m) => m.model)
    } catch {
      ollamaError = "Could not reach Ollama."
    }

    const { models: dbModels } = getModelsListWithRoles(db, res.locals.user!)
    const recommendedModels = getRecommendedModels(db)

    res.render("setup/step2", {
      user: res.locals.user,
      ollamaModels,
      dbModels,
      ollamaError,
      recommendedModels,
      error: req.query.error ?? null,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme: getActiveTheme(db),
    })
  })

  router.post("/setup/2/install-recommended/:id", requireAuth, async (req, res) => {
    const rec = getRecommendedModelById(db, parseInt(String(req.params.id)))
    if (!rec) return res.redirect("/setup/2?error=" + encodeURIComponent("Recommended model not found"))

    const validProviders = ["ollama", "ollama cloud", "chatgpt", "claude", "custom"] as const
    const provider = (validProviders as readonly string[]).includes(rec.provider)
      ? (rec.provider as (typeof validProviders)[number])
      : "ollama"

        const result = addModel(
      db, res.locals.user!,
      rec.name, true, true,
      { model: rec.name, size: null, parameterSize: null, modifiedAt: null },
      [], provider, rec.baseUrl, rec.id,
    )
    if (!result.success) {
      return res.redirect("/setup/2?error=" + encodeURIComponent(result.msg ?? "Failed to add model"))
    }
    res.redirect("/setup/2?toast=success&msg=" + encodeURIComponent(`${rec.name} added`))
  })

  router.post("/setup/2/next", requireAuth, (req, res) => {
    const { models } = getModelsListWithRoles(db, res.locals.user!)
    if (models.length === 0) {
      return res.redirect("/setup/2?error=" + encodeURIComponent("Install at least one model before continuing"))
    }
    res.redirect("/setup/3")
  })

  
  router.get("/setup/3", requireAuth, async (req, res) => {
    let ollamaModels: { model: string; name?: string }[] = []
    let ollamaError: string | null = null

    try {
      const result = await getModelsFromOllama()
      if (result.error) {
        ollamaError = result.ollamaRunning === false ? "Ollama is not running." : result.error
      }
      ollamaModels = result.models.map((m) => ({ model: m.model, name: m.name }))
    } catch {
      ollamaError = "Could not reach Ollama."
    }

    const { models: dbModels } = getModelsListWithRoles(db, res.locals.user!)

    res.render("setup/step3", {
      user: res.locals.user,
      ollamaModels,
      dbModels,
      ollamaError,
      error: req.query.error ?? null,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme: getActiveTheme(db),
    })
  })

  router.post("/setup/3/add", requireAuth, upload.none(), (req, res) => {
    const { modelName, name, closeAfterUse, roles, provider, baseUrl } = req.body as {
      modelName: string; name?: string; closeAfterUse?: string; roles?: string | string[]
      provider?: string; baseUrl?: string
    }
    if (!modelName) return res.redirect("/setup/3?error=" + encodeURIComponent("Model name is required"))

    const roleList = (Array.isArray(roles) ? roles : roles ? [roles] : ["translation"]) as ("translation" | "judge" | "nameFormatter")[]
    const validProviders = ["ollama", "ollama cloud", "chatgpt", "claude", "custom"] as const
    const resolvedProvider = (validProviders as readonly string[]).includes(provider ?? "")
      ? (provider as (typeof validProviders)[number]) : "ollama"

    const result = addModel(
      db, res.locals.user!, (name || modelName).trim(), closeAfterUse !== "0", true,
      { model: modelName.trim(), size: null, parameterSize: null, modifiedAt: null },
      roleList, resolvedProvider, baseUrl?.trim() || null,
    )
    if (!result.success) return res.redirect("/setup/3?error=" + encodeURIComponent(result.msg ?? "Failed to add model"))
    res.redirect("/setup/3?toast=success&msg=" + encodeURIComponent("Model added"))
  })

  router.post("/setup/3/role/:id", requireAuth, upload.none(), (req, res) => {
    const modelId = parseInt(String(req.params.id))
    const { role, action } = req.body as {
      role: "translation" | "judge" | "nameFormatter"
      action: "add" | "remove"
    }
    if (!role || !["translation", "judge", "nameFormatter"].includes(role)) {
      return res.redirect("/setup/3?error=" + encodeURIComponent("Invalid role"))
    }
    const result = updateRolesForModel(db, res.locals.user!, modelId, role, action === "add")
    if (!result.success) {
      return res.redirect("/setup/3?error=" + encodeURIComponent(result.msg ?? "Role update failed"))
    }
    res.redirect("/setup/3?toast=success&msg=" + encodeURIComponent("Role updated"))
  })

  router.post("/setup/3/next", requireAuth, (req, res) => {
    const { models } = getModelsListWithRoles(db, res.locals.user!)
    if (models.length === 0) return res.redirect("/setup/3?error=" + encodeURIComponent("Add at least one model before continuing"))
    const hasTranslationModel = models.some((m) => m.roles.some((r) => r.role === "translation"))
    if (!hasTranslationModel) {
      return res.redirect("/setup/3?error=" + encodeURIComponent("Assign the Translation role to at least one model before continuing"))
    }
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent("Setup complete! Welcome."))
  })

  return router
}
