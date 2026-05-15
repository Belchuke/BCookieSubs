import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import { addPromptVersion, addTranslationPrompt, getAllPrompts, setActivePromptVersion, setPromptActive } from "../repositories/promptRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { promptRules } from "../setup"

const upload = multer()

export function promptsRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, (req, res) => {
    const user = res.locals.user!
    const { prompts, success, msg } = getAllPrompts(db, user)
    const theme = getActiveTheme(db)

    res.render("prompts", {
      user,
      activeNav: "prompts",
      prompts: success ? prompts : [],
      promptRules,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      error: success ? null : msg,
      theme,
    })
  })

  
  const requireManagePrompts = (_req: any, res: any, next: any) => {
    const u = res.locals.user
    if (!u || (!u.isAdmin && !u.canManagePrompts)) {
      return res.redirect("/prompts?toast=error&msg=" + encodeURIComponent("Permission denied"))
    }
    next()
  }

  router.post("/create", requireAuth, requireManagePrompts, upload.none(), (req, res) => {
    const { name, promptText } = req.body as { name: string; promptText: string }

    if (!name || !promptText) {
      return res.redirect("/prompts?toast=error&msg=" + encodeURIComponent("Name and prompt text are required"))
    }

    const result = addTranslationPrompt(db, res.locals.user!, name.trim(), promptText)
    if (!result.success) {
      return res.redirect("/prompts?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create prompt"))
    }
    res.redirect("/prompts?toast=success&msg=" + encodeURIComponent("Prompt created"))
  })

  
  router.post("/add-version/:id", requireAuth, requireManagePrompts, upload.none(), (req, res) => {
    const promptId = parseInt(String(req.params.id))
    const { promptText, version } = req.body as { promptText: string; version?: string }

    if (!promptText) {
      return res.redirect("/prompts?toast=error&msg=" + encodeURIComponent("Prompt text is required"))
    }

        const { prompts } = getAllPrompts(db, res.locals.user!, false)
    const prompt = prompts.find((p) => p.id === promptId)
    const nextVersion = version
      ? parseInt(version)
      : (prompt?.versions?.reduce((max, v) => (v.version > max ? v.version : max), 0) ?? 0) + 1

    const result = addPromptVersion(db, res.locals.user!, promptId, nextVersion, promptText)
    if (!result.success) {
      return res.redirect("/prompts?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to add version"))
    }
    res.redirect("/prompts?toast=success&msg=" + encodeURIComponent("Prompt version added"))
  })

  
  router.post("/set-version/:promptId/:versionId", requireAuth, requireManagePrompts, (req, res) => {
    const result = setActivePromptVersion(
      db,
      res.locals.user!,
      parseInt(String(req.params.promptId)),
      parseInt(String(req.params.versionId)),
    )
    if (!result.success) {
      return res.redirect("/prompts?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to set version"))
    }
    res.redirect("/prompts?toast=success&msg=" + encodeURIComponent("Active version updated"))
  })

  
  router.post("/toggle/:id", requireAuth, requireManagePrompts, upload.none(), (req, res) => {
    const promptId = parseInt(String(req.params.id))
    const { active } = req.body as { active?: string }

    const result = setPromptActive(db, res.locals.user!, promptId, active === "1")
    if (!result.success) {
      return res.redirect("/prompts?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to toggle prompt"))
    }
    res.redirect("/prompts?toast=success&msg=" + encodeURIComponent("Prompt updated"))
  })

  return router
}
