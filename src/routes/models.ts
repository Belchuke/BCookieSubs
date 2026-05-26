import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import { createLog } from "../repositories/logRepository"
import {
  addModel,
  deleteModel,
  getModelsListWithRoles,
  updateModel,
  updateRolesForModel,
} from "../repositories/modelRepository"
import { downloadModel, getModelsFromOllama, removeOllamaModel } from "../repositories/ollamaRepository"
import { getRecommendedModelById, getUninstalledRecommendedModels } from "../repositories/recommendedModelRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"

const upload = multer()

export function modelsRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, async (req, res) => {
    const user = res.locals.user!
    const { models, success } = getModelsListWithRoles(db, user)

    let ollamaModels: { model: string; size: number; parameterSize: string | null; modifiedAt: string | null }[] = []
    let ollamaError: string | null = null
    let ollamaRunning: boolean | null = null

    try {
      const result = await getModelsFromOllama()
      ollamaRunning = result.ollamaRunning
      if (result.error) {
        ollamaError = result.ollamaRunning === false ? "Ollama is not running." : result.error
      } else {
        ollamaModels = result.models.map((m) => ({
          model: m.model,
          size: m.size,
          parameterSize: m.details.parameter_size ?? null,
          modifiedAt: new Date(m.modified_at)
            .toLocaleString("da-DK", {
              hour: "2-digit",
              minute: "2-digit",
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
            })
            .replace(".", "")
            .replaceAll(".", "-"),
        }))
      }
    } catch (e) {
      ollamaError = "Could not reach Ollama: " + String(e)
    }

    const theme = getActiveTheme(db, user.id)
    const recommendedModels = getUninstalledRecommendedModels(db)

    res.render("models", {
      user,
      activeNav: "models",
      models: success ? models : [],
      ollamaModels,
      ollamaError,
      ollamaRunning,
      recommendedModels,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  
  router.post("/add", requireAuth, upload.none(), (req, res) => {
    const { modelName, name, closeAfterUse, active, roles, provider, baseUrl } = req.body as {
      modelName: string
      name?: string
      closeAfterUse?: string | string[]
      active?: string
      roles?: string | string[]
      provider?: string
      baseUrl?: string
    }

    if (!modelName) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent("Model name is required"))
    }

    const roleList = (Array.isArray(roles) ? roles : roles ? [roles] : []) as (
      | "translation"
      | "judge"
      | "fallbackJudge"
      | "nameFormatter"
    )[]

    const validProviders = ["ollama", "ollama cloud", "chatgpt", "claude", "custom"] as const
    const resolvedProvider = (validProviders as readonly string[]).includes(provider ?? "")
      ? (provider as (typeof validProviders)[number])
      : "ollama"

    const closeAfterUseBool = Array.isArray(closeAfterUse)
      ? closeAfterUse.includes("1")
      : closeAfterUse !== "0"

    const result = addModel(
      db,
      res.locals.user!,
      (name || modelName).trim(),
      closeAfterUseBool,
      active !== "0",
      { model: modelName.trim(), size: null, parameterSize: null, modifiedAt: null },
      roleList,
      resolvedProvider,
      baseUrl?.trim() || null,
      null,
    )

    if (!result.success) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to add model"))
    }
    res.redirect("/models?toast=success&msg=" + encodeURIComponent("Model added"))
  })

  
  router.post("/sync", requireAuth, upload.none(), async (req, res) => {
    const { modelName, name, closeAfterUse, active, roles, recommendedModelId } = req.body as {
      modelName: string
      name?: string
      closeAfterUse?: string | string[]
      active?: string
      roles?: string | string[]
      recommendedModelId?: string
    }

    if (!modelName) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent("Model name is required"))
    }

    const ollamaResult = await getModelsFromOllama()
    const ollamaModel = ollamaResult.models.find((m) => m.model === modelName)
    if (!ollamaModel) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent(`Model "${modelName}" not found in Ollama`))
    }

    const roleList = (Array.isArray(roles) ? roles : roles ? [roles] : ["translation"]) as (
      | "translation"
      | "judge"
      | "fallbackJudge"
      | "nameFormatter"
    )[]

    const parsedRecId = recommendedModelId ? parseInt(recommendedModelId) : null
    const recId = parsedRecId && !isNaN(parsedRecId) ? parsedRecId : null

    const closeAfterUseBool = Array.isArray(closeAfterUse)
      ? closeAfterUse.includes("1")
      : closeAfterUse !== "0"

    const result = addModel(
      db,
      res.locals.user!,
      (name || modelName).trim(),
      closeAfterUseBool,
      active !== "0",
      {
        model: ollamaModel.model,
        size: ollamaModel.size,
        parameterSize: ollamaModel.details.parameter_size ?? null,
        modifiedAt: ollamaModel.modified_at?.toString() ?? null,
      },
      roleList,
      "ollama",
      null,
      recId,
    )

    if (!result.success) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to sync model"))
    }
    res.redirect("/models?toast=success&msg=" + encodeURIComponent("Model synced from Ollama"))
  })

  
  router.post("/update/:id", requireAuth, upload.none(), (req, res) => {
    const modelId = parseInt(String(req.params.id))
    const { name, closeAfterUse, active, provider, baseUrl } = req.body as {
      name: string
      closeAfterUse?: string
      active?: string
      provider?: string
      baseUrl?: string
    }

    const validProviders = ["ollama", "ollama cloud", "chatgpt", "claude", "custom"] as const
    const resolvedProvider = (validProviders as readonly string[]).includes(provider ?? "")
      ? (provider as (typeof validProviders)[number])
      : "ollama"

    const result = updateModel(
      db,
      res.locals.user!,
      modelId,
      name?.trim() || "",
      closeAfterUse === "1",
      active !== "0",
      resolvedProvider,
      baseUrl?.trim() || null,
    )

    if (!result.success) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent(result.msg ?? "Update failed"))
    }
    res.redirect("/models?toast=success&msg=" + encodeURIComponent("Model updated"))
  })

  
  router.post("/role/:id", requireAuth, upload.none(), (req, res) => {
    const modelId = parseInt(String(req.params.id))
    const { role, action } = req.body as {
      role: "translation" | "judge" | "nameFormatter"
      action: "add" | "remove"
    }

    if (!role || !["translation", "judge", "fallbackJudge", "nameFormatter"].includes(role)) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent("Invalid role"))
    }

    const result = updateRolesForModel(db, res.locals.user!, modelId, role, action === "add")
    if (!result.success) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent(result.msg ?? "Role update failed"))
    }
    res.redirect("/models?toast=success&msg=" + encodeURIComponent("Role updated"))
  })

  
  router.post("/delete/:id", requireAuth, (req, res) => {
    const result = deleteModel(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent(result.msg ?? "Delete failed"))
    }
    res.redirect("/models?toast=success&msg=" + encodeURIComponent("Model removed"))
  })

  
  router.post("/remove-ollama", requireAuth, requirePermission("canRemoveAndDeleteModels"), upload.none(), async (req, res) => {
    const { modelName } = req.body as { modelName: string }
    if (!modelName) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent("Model name required"))
    }
    const result = await removeOllamaModel(modelName)
    if (!result.success) {
      return res.redirect(
        "/models?toast=error&msg=" + encodeURIComponent(result.error ?? "Failed to remove from Ollama"),
      )
    }
    createLog(db, "info", "model", null, "Removed Ollama model", { modelName })
    res.redirect("/models?toast=success&msg=" + encodeURIComponent(`Removed ${modelName} from Ollama`))
  })

  
  router.get("/pull-stream/:modelName", requireAuth, requirePermission("canAddOrInstallAModel"), async (req, res) => {
    const modelName = decodeURIComponent(String(req.params.modelName))

    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")
    res.flushHeaders()

    const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)

    try {
      const stream = await downloadModel(modelName)
      if ("success" in stream && !stream.success) {
        send({ error: (stream as any).error ?? "Pull failed" })
        res.end()
        return
      }
      for await (const chunk of stream as AsyncIterable<any>) {
        send({
          status: chunk.status ?? "",
          completed: chunk.completed ?? null,
          total: chunk.total ?? null,
          digest: chunk.digest ?? null,
        })
        if (chunk.status === "success") break
      }
      send({ done: true })
    } catch (err) {
      send({ error: err instanceof Error ? err.message : String(err) })
    }
    res.end()
  })

  
  router.post("/add-recommended/:id", requireAuth, requirePermission("canAddOrInstallAModel"), upload.none(), async (req, res) => {
    const user = res.locals.user!
    const rec = getRecommendedModelById(db, parseInt(String(req.params.id)))
    if (!rec) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent("Recommended model not found"))
    }

    const roleList = (rec.roles ?? "translation")
      .split(",")
      .map((r) => r.trim())
      .filter((r) => ["translation", "judge", "fallbackJudge", "nameFormatter"].includes(r)) as (
      | "translation"
      | "judge"
      | "fallbackJudge"
      | "nameFormatter"
    )[]

    const validProviders = ["ollama", "ollama cloud", "chatgpt", "claude", "custom"] as const
    const provider = (validProviders as readonly string[]).includes(rec.provider)
      ? (rec.provider as (typeof validProviders)[number])
      : "ollama"

        if (provider === "ollama") {
      const ollamaResult = await getModelsFromOllama()
      const installed = ollamaResult.models.some((m) => m.model === rec.name)
      if (!installed) {
                return res.redirect(
          "/models?toast=error&msg=" + encodeURIComponent(`${rec.name} is not installed. Use + Add and the pull flow.`),
        )
      }
    }

    const result = addModel(
      db,
      user,
      rec.name,
      true,
      true,
      { model: rec.name, size: null, parameterSize: null, modifiedAt: null },
      roleList,
      provider,
      rec.baseUrl,
      rec.id,
    )

    if (!result.success) {
      return res.redirect("/models?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to add model"))
    }
    res.redirect("/models?toast=success&msg=" + encodeURIComponent(`${rec.name} added`))
  })

  return router
}
