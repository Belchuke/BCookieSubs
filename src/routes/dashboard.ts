import { Router } from "express"
import multer from "multer"
import Database from "better-sqlite3"
import { getConfig, getLogs } from "../repositories/configRepository"
import { getConfigTranslationLanguages, getLanguages } from "../repositories/languageRepository"
import { createMediaItem, getMediaItemById } from "../repositories/mediaRepository"
import { getSubtitleItemMediaItemFromPrompt } from "../repositories/promptFormattingRepository"
import { cancelSubtitle, cancelSubtitleJob, createSubtitleTask, getChunksByJobId, getDashboardData, getExportFileName, getSubtitleById, getSubtitleJobById, getSubtitleJobsBySubtitleId, hideSubtitle, moveSeriesInQueue, moveSubtitleInQueue, reorderSubtitles, retryFailedChunk, softDeleteSubtitle } from "../repositories/subtitleRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { NameFormatterResult } from "../types/modelTypes"
import { pauseWorker, resumeWorker, isWorkerPaused } from "../task"
import { addCreditToSrt } from "../services/subtitleExportService"

const upload = multer({ storage: multer.memoryStorage() })

export function dashboardRouter(db: Database.Database) {
  const router = Router()

  
  router.get("/", requireAuth, (req, res) => {
    const config = getConfig(db)
    const languages = getLanguages(db)
    const configLangs = getConfigTranslationLanguages(db)
    const { subtitles, jobs, mediaItems, languageMap } = getDashboardData(db)
    const theme = getActiveTheme(db)

    res.render("dashboard", {
      user: res.locals.user,
      activeNav: "dashboard",
      config,
      languages,
      configLangs,
      subtitles,
      jobs,
      mediaItems,
      languageMap,
      workerPaused: isWorkerPaused(),
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  
  router.get("/poll", requireAuth, (_req, res) => {
    try {
      const { subtitles, jobs, mediaItems, languageMap } = getDashboardData(db)
      const { logs } = getLogs(db, res.locals.user!, 20)
      res.json({ subtitles, jobs, mediaItems, languageMap, logs: logs ?? [], workerPaused: isWorkerPaused() })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  
  router.post("/worker/pause", requireAuth, (_req, res) => {
    const u = res.locals.user!
    if (!u.isAdmin && !u.pauseWorker) return res.status(403).json({ success: false, msg: "Permission denied" })
    pauseWorker(db, u.username)
    res.json({ success: true, workerPaused: true })
  })

  router.post("/worker/resume", requireAuth, (_req, res) => {
    const u = res.locals.user!
    if (!u.isAdmin && !u.pauseWorker) return res.status(403).json({ success: false, msg: "Permission denied" })
    resumeWorker(db, u.username)
    res.json({ success: true, workerPaused: false })
  })

        
  router.post("/upload/step1", requireAuth, upload.single("srtFile"), async (req, res) => {
    const file = req.file
    if (!file) return res.status(400).json({ success: false, msg: "No file uploaded" })

    const rawContent = file.buffer.toString("utf-8")
    const filename = (req.body.filename as string | undefined) || file.originalname || "subtitle.srt"

        let detected: NameFormatterResult | null = null
    try {
      detected = await getSubtitleItemMediaItemFromPrompt(db, res.locals.user!, filename)
    } catch {
          }

        const lineCount = (rawContent.match(/^\d+$/gm) || []).length

    res.json({
      success: true,
      filename,
      lineCount,
      detected,
    })
  })

    
  router.post("/upload/step2", requireAuth, upload.single("srtFile"), async (req, res) => {
    const file = req.file
    if (!file) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent("No file uploaded"))
    }

    const {
      mediaTitle,
      mediaType,
      mediaYear,
      theMovieDbId,
      posterBase64,
      originalTitle,
      isAnime,
      genres,
      mediaItemId: mediaItemIdStr,
      sourceLangId: sourceLangIdStr,
      targetLangIds,
      chunkSetting: chunkSettingStr,
      season: seasonStr,
      episode: episodeStr,
    } = req.body as {
      mediaTitle?: string
      mediaType?: string
      mediaYear?: string
      theMovieDbId?: string
      posterBase64?: string
      originalTitle?: string
      isAnime?: string
      genres?: string
      mediaItemId?: string
      sourceLangId: string
      targetLangIds: string | string[]
      chunkSetting?: string
      season?: string
      episode?: string
    }

    if (!sourceLangIdStr || !targetLangIds) {
      return res.redirect(
        "/dashboard?toast=error&msg=" + encodeURIComponent("Source and target languages are required"),
      )
    }

    const sourceLangId = parseInt(sourceLangIdStr)
    const targetIds = (Array.isArray(targetLangIds) ? targetLangIds : [targetLangIds])
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0)

    if (targetIds.length === 0) {
      return res.redirect(
        "/dashboard?toast=error&msg=" + encodeURIComponent("At least one target language is required"),
      )
    }

    const config = getConfig(db)
    const chunkSetting = chunkSettingStr ? parseInt(chunkSettingStr) : config.defaultChunkSize
    const season = seasonStr ? parseInt(seasonStr) : null
    const episode = episodeStr ? parseInt(episodeStr) : null
    const rawContent = file.buffer.toString("utf-8")
    const filename = file.originalname || "subtitle.srt"

        let resolvedMediaItemId: number | null = null
    if (mediaItemIdStr && mediaItemIdStr !== "new") {
      resolvedMediaItemId = parseInt(mediaItemIdStr)
    } else if (mediaTitle) {
      const type = (mediaType as "movie" | "series" | "unknown") || "unknown"
      const year = mediaYear ? parseInt(mediaYear) : null
      const result = createMediaItem(
        db,
        res.locals.user!,
        mediaTitle,
        originalTitle || null,
        type,
        year,
        isAnime === "1",
        genres || null,
        theMovieDbId || null,
        posterBase64 || null,
      )
      if (result.success && result.mediaItem) {
        resolvedMediaItemId = result.mediaItem.id
      }
    }

    const result = createSubtitleTask(
      db,
      res.locals.user!,
      resolvedMediaItemId,
      sourceLangId,
      targetIds,
      rawContent,
      chunkSetting,
      season,
      episode,
      filename,
      mediaTitle || null,
    )

    if (!result.success) {
      return res.redirect(
        "/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create subtitle task"),
      )
    }

    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent(result.msg ?? "Subtitle added to queue"))
  })

  
  router.post("/cancel/:id", requireAuth, (req, res) => {
    const result = cancelSubtitle(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to cancel"))
    }
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent("Job cancelled"))
  })

  router.post("/cancel-job/:jobId", requireAuth, (req, res) => {
    const result = cancelSubtitleJob(db, res.locals.user!, parseInt(String(req.params.jobId)))
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to cancel"))
    }
    res.redirect("/dashboard")
  })

  
  router.post("/hide/:id", requireAuth, (req, res) => {
    const result = hideSubtitle(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to hide"))
    }
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent("Subtitle hidden"))
  })

  
  router.post("/delete/:id", requireAuth, (req, res) => {
    const result = softDeleteSubtitle(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to delete"))
    }
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent("Job deleted"))
  })

  
  router.post("/move-up/:id", requireAuth, (req, res) => {
    moveSubtitleInQueue(db, res.locals.user!, parseInt(String(req.params.id)), "up")
    res.redirect("/dashboard")
  })

  router.post("/move-down/:id", requireAuth, (req, res) => {
    moveSubtitleInQueue(db, res.locals.user!, parseInt(String(req.params.id)), "down")
    res.redirect("/dashboard")
  })

  router.post("/move-series-up/:mediaItemId", requireAuth, (req, res) => {
    moveSeriesInQueue(db, res.locals.user!, parseInt(String(req.params.mediaItemId)), "up")
    res.redirect("/dashboard")
  })

  router.post("/move-series-down/:mediaItemId", requireAuth, (req, res) => {
    moveSeriesInQueue(db, res.locals.user!, parseInt(String(req.params.mediaItemId)), "down")
    res.redirect("/dashboard")
  })

  
  router.post("/reorder", requireAuth, (req, res) => {
    const { orderedIds } = req.body as { orderedIds: unknown }
    if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, msg: "Invalid payload" })
    const ids = (orderedIds as unknown[]).map(Number).filter((n) => !isNaN(n))
    const result = reorderSubtitles(db, res.locals.user!, ids)
    res.json(result)
  })

  
  router.get("/poster/:mediaItemId", requireAuth, (req, res) => {
    const mediaItem = getMediaItemById(db, parseInt(String(req.params.mediaItemId)))
    if (!mediaItem?.posterBase64) return res.status(404).end()
    const match = mediaItem.posterBase64.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return res.status(404).end()
    res.setHeader("Content-Type", match[1])
    res.setHeader("Cache-Control", "public, max-age=86400")
    res.send(Buffer.from(match[2], "base64"))
  })

  
  router.get("/inspect/:id", requireAuth, (req, res) => {
    try {
      const subtitleId = parseInt(String(req.params.id))
      const subtitle = getSubtitleById(db, subtitleId)
      if (!subtitle) return res.status(404).json({ error: "Not found" })

      const jobs = getSubtitleJobsBySubtitleId(db, subtitleId)
      const languages = getLanguages(db)
      const languageMap = Object.fromEntries(languages.map((l) => [l.id, l]))
      const mediaItem = subtitle.mediaItemId ? getMediaItemById(db, subtitle.mediaItemId) : null

      const perJob = jobs.map((job) => {
        const chunks = getChunksByJobId(db, job.id)
        const done = chunks.filter((c) => c.status === "completed").length
        const failed = chunks.filter((c) => c.status === "failed").length
        return {
          job,
          lang: languageMap[job.targetLangId] ?? null,
          total: chunks.length,
          done,
          failed,
          chunks: chunks.map((c) => ({
            id: c.id,
            chunkIndex: c.chunkIndex,
            srtIdFrom: c.srtIdFrom,
            srtIdTo: c.srtIdTo,
            status: c.status,
            retryCount: c.retryCount,
            judgeReason: c.judgeReason,
            errorMessage: c.errorMessage,
            durationMs: c.durationMs,
            startedAt: c.startedAt,
            finishedAt: c.finishedAt,
          })),
        }
      })

      res.json({
        subtitle: { ...subtitle, sourceLang: languageMap[subtitle.sourceLangId] },
        mediaItem,
        perJob,
      })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  
  router.post("/retry-chunk/:chunkId", requireAuth, (req, res) => {
    try {
      const chunkId = parseInt(String(req.params.chunkId))
      retryFailedChunk(db, chunkId)
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  
  router.post("/reset-chunk/:chunkId", requireAuth, (req, res) => {
    try {
      const chunkId = parseInt(String(req.params.chunkId))
      db.prepare(`DELETE FROM subtitleChunkCandidate WHERE subtitleChunkId = ?`).run(chunkId)
      db.prepare(
        `UPDATE subtitleChunk SET status = 'queued', retryCount = 0, startedAt = NULL, finishedAt = NULL, errorMessage = NULL, selectedCandidateId = NULL, updatedAt = datetime('now') WHERE id = ?`,
      ).run(chunkId)
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  
  router.get("/download/:jobId", requireAuth, (req, res) => {
    const u = res.locals.user!
    if (!u.isAdmin && !u.downloadSubtitles) return res.status(403).send("Permission denied")
    const job = getSubtitleJobById(db, parseInt(String(req.params.jobId)))
    if (!job || !job.translatedText) {
      return res.status(404).send("Translated file not available")
    }

    const subtitle = getSubtitleById(db, job.subtitleId)
    const languages = getLanguages(db)
    const lang = languages.find((l) => l.id === job.targetLangId)
    const mediaItem = subtitle?.mediaItemId ? getMediaItemById(db, subtitle.mediaItemId) : null

    const langCode = lang ? lang.iso639.toLowerCase() : String(job.targetLangId)
    const rawTitle = mediaItem?.title ?? subtitle?.name ?? "subtitle"
    const title = rawTitle
      .replace(/[/\\:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()

    const filename = getExportFileName(title, job.season, job.episode, mediaItem?.year ?? null, langCode)

    const exportContent = addCreditToSrt(job.translatedText)

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.send(exportContent)
  })

  return router
}
