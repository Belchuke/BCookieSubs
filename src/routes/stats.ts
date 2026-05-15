import { Router } from "express"
import Database from "better-sqlite3"
import { getLanguages } from "../repositories/languageRepository"
import { getJudgeEvaluations } from "../repositories/promptFormattingRepository"
import { getAllPromptStats } from "../repositories/promptRepository"
import {
  getJobChunkStatsData,
  getModelCandidateStats,
  getSubtitleById,
  getSubtitleJobById,
  getSubtitleJobsBySubtitleId,
  getSubtitlesWithLang,
} from "../repositories/subtitleRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { getModelsStats } from "../repositories/statsRepository"

export function statsRouter(db: Database.Database) {
  const router = Router()

  const requireStats = (_req: any, res: any, next: any) => {
    const u = res.locals.user
    if (!u || (!u.isAdmin && !u.canViewStats)) return res.status(403).redirect("/dashboard")
    next()
  }
  const requireStatsJson = (_req: any, res: any, next: any) => {
    const u = res.locals.user
    if (!u || (!u.isAdmin && !u.canViewStats)) return res.status(403).json({ error: "Permission denied" })
    next()
  }

  router.get("/", requireAuth, requireStats, (req, res) => {
    const user = res.locals.user!
    const { stats, success, msg } = getAllPromptStats(db, user)
    const models = getModelsStats(db)
    const subtitles = getSubtitlesWithLang(db)
    const theme = getActiveTheme(db)

    res.render("stats", {
      user,
      activeNav: "stats",
      stats: success ? stats : [],
      models,
      subtitles,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      error: success ? null : msg,
      theme,
    })
  })

  
  router.get("/subtitle-data", requireAuth, requireStatsJson, (req, res) => {
    const subtitleId = parseInt(String(req.query.subtitleId))
    if (!subtitleId) return res.status(400).json({ error: "Missing subtitleId" })

    const subtitle = getSubtitleById(db, subtitleId)
    if (!subtitle) return res.status(404).json({ error: "Not found" })

    const jobs = getSubtitleJobsBySubtitleId(db, subtitleId)
    const languages = getLanguages(db)
    const sourceLangName = languages.find((l) => l.id === subtitle.sourceLangId)?.name ?? ""
    const jobsWithLang = jobs.map((j) => ({
      id: j.id,
      targetLangId: j.targetLangId,
      targetLangName: languages.find((l) => l.id === j.targetLangId)?.name ?? String(j.targetLangId),
      chunkSetting: j.chunkSetting,
      status: j.status,
    }))

    res.json({ subtitle: { id: subtitle.id, name: subtitle.name }, jobs: jobsWithLang, sourceLangName })
  })

  
  router.get("/job-data", requireAuth, requireStatsJson, (req, res) => {
    const jobId = parseInt(String(req.query.jobId))
    if (!jobId) return res.status(400).json({ error: "Missing jobId" })

    const job = getSubtitleJobById(db, jobId)
    if (!job) return res.status(404).json({ error: "Not found" })

    const subtitle = getSubtitleById(db, job.subtitleId)
    const languages = getLanguages(db)
    const sourceLangName = languages.find((l) => l.id === subtitle?.sourceLangId)?.name ?? ""
    const targetLangName = languages.find((l) => l.id === job.targetLangId)?.name ?? ""
    const chunks = getJobChunkStatsData(db, jobId)

    res.json({
      job: { id: job.id, chunkSetting: job.chunkSetting, chunkSizeTotal: job.chunkSizeTotal, status: job.status },
      subtitle: subtitle ? { id: subtitle.id, name: subtitle.name } : null,
      sourceLangName,
      targetLangName,
      chunks,
    })
  })

  
  router.get("/model-data", requireAuth, requireStatsJson, (req, res) => {
    const modelId = parseInt(String(req.query.modelId))
    if (!modelId) return res.status(400).json({ error: "Missing modelId" })
    res.json(getModelCandidateStats(db, modelId))
  })

  
  router.get("/judge-data", requireAuth, requireStatsJson, (req, res) => {
    const modelId = req.query.modelId ? parseInt(String(req.query.modelId)) : null
    const page = Math.max(0, parseInt(String(req.query.page || "0")))
    res.json(getJudgeEvaluations(db, modelId, 30, page * 30))
  })

  
  router.get("/poll", requireAuth, requireStatsJson, (_req, res) => {
    const user = res.locals.user!
    const { stats, success } = getAllPromptStats(db, user)
    res.json({ stats: success ? stats : [] })
  })

  return router
}
