import { Router } from "express"
import multer from "multer"
import path from "path"
import Database from "better-sqlite3"
import { getConfig, getLogs } from "../repositories/configRepository"
import { getConfigTranslationLanguages, getLanguages, getUserConfigTranslationLanguages } from "../repositories/languageRepository"
import { createMediaItem, getMediaItemById, MEDIA_PHOTOS_DIR } from "../repositories/mediaRepository"
import { getSubtitleItemMediaItemFromPrompt } from "../repositories/promptFormattingRepository"
import { bulkCancelDelete, cancelSubtitle, cancelSubtitleJob, cancelSubtitlesByMediaItem, createSubtitleTask, getChunksByJobId, getDashboardData, getExportFileName, getSubtitleById, getSubtitleJobById, getSubtitleJobsBySubtitleId, hideSubtitle, moveSeriesInQueue, moveSubtitleInQueue, moveWhisperSubtitleInQueue, moveWhisperSubtitleToTop, reorderSubtitles, reorderWhisperSubtitles, requeueCancelledSubtitle, resetChunk, retryFailedChunk, softDeleteSubtitle, softDeleteSubtitleJob, softDeleteSubtitlesByMediaItem } from "../repositories/subtitleRepository"
import { getActiveTheme } from "../repositories/themeRepository"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"
import { NameFormatterResult } from "../types/modelTypes"
import { getTranslateWorkerBridge } from "../tasks/translateWorkerBridge"
import { getWhisperWorkerBridge } from "../tasks/whisperWorkerBridge"
import { getOcrWorkerBridge } from "../tasks/ocrWorkerBridge"
import {
  deleteOcrJob,
  getOcrJobsForDashboard,
  moveOcrJob,
  reorderOcrJobs,
  retryOcrJob,
} from "../repositories/ocrJobRepository"
import { finalizeSubtitleForOutput } from "../services/subtitleExportService"

const upload = multer({ storage: multer.memoryStorage() })

export function dashboardRouter(db: Database.Database) {
  const router = Router()

  
  router.get("/", requireAuth, (req, res) => {
    const config = getConfig(db)
    const languages = getLanguages(db)
    const configLangs = getConfigTranslationLanguages(db)
    const theme = getActiveTheme(db, res.locals.user!.id)
    const user = res.locals.user!
    const userConfigLangs = getUserConfigTranslationLanguages(db, user.id)

    res.render("dashboard", {
      user,
      activeNav: "dashboard",
      config,
      languages,
      configLangs,
      userConfigLangs,
      workerPaused: getTranslateWorkerBridge().isWorkerPaused(),
      whisperSeparate: config.whisperRunAsSeparateTask === 1,
      whisperWorkerPaused: getWhisperWorkerBridge().isWorkerPaused(),
      ocrWorkerPaused: getOcrWorkerBridge().isWorkerPaused(),
      showPosters: config.showPosters && user.showPosters !== 0,
      deleteNotCancel: config.deleteNotCancel === 1,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })


  router.get("/poll", requireAuth, (_req, res) => {
    const startedMs = Date.now()
    try {
      const { subtitles, languageMap } = getDashboardData(db)
      const { logs } = getLogs(db, res.locals.user!, 20)
      const config = getConfig(db)
      const payload = {
        subtitles,
        languageMap,
        logs: logs ?? [],
        workerPaused: getTranslateWorkerBridge().isWorkerPaused(),
        whisperSeparate: config.whisperRunAsSeparateTask === 1,
        whisperWorkerPaused: getWhisperWorkerBridge().isWorkerPaused(),
        ocrJobs: getOcrJobsForDashboard(db),
        ocrWorkerPaused: getOcrWorkerBridge().isWorkerPaused(),
        deleteNotCancel: config.deleteNotCancel === 1,
      }
      // Slow/heavy poll instrumentation (DATABASE_ASSESSMENT.md): the poll
      // runs every 15s per open dashboard tab, so regressions compound. Warn
      // on the console instead of the log table — a DB log per slow poll
      // would itself add write load.
      const elapsedMs = Date.now() - startedMs
      const bodySize = JSON.stringify(payload).length
      if (elapsedMs > 250 || bodySize > 200_000) {
        console.warn(
          `[dashboard] slow poll: ${elapsedMs}ms, payload ${(bodySize / 1024).toFixed(0)}KB, ${subtitles.length} subtitles`,
        )
      }
      res.json(payload)
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })


  router.post("/worker/pause", requireAuth, requirePermission("canManageWorker"), async (_req, res) => {
    try {
      await getTranslateWorkerBridge().pauseWorker(res.locals.user!.username)
      res.json({ success: true, workerPaused: getTranslateWorkerBridge().isWorkerPaused() })
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  router.post("/worker/resume", requireAuth, requirePermission("canManageWorker"), async (_req, res) => {
    try {
      await getTranslateWorkerBridge().resumeWorker(res.locals.user!.username)
      res.json({ success: true, workerPaused: getTranslateWorkerBridge().isWorkerPaused() })
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  // Whisper worker pause/resume — independent of the translation worker.
  router.post("/whisper-worker/pause", requireAuth, requirePermission("canManageWorker"), async (_req, res) => {
    try {
      await getWhisperWorkerBridge().pauseWorker(res.locals.user!.username)
      res.json({ success: true, workerPaused: getWhisperWorkerBridge().isWorkerPaused() })
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  router.post("/whisper-worker/resume", requireAuth, requirePermission("canManageWorker"), async (_req, res) => {
    try {
      await getWhisperWorkerBridge().resumeWorker(res.locals.user!.username)
      res.json({ success: true, workerPaused: getWhisperWorkerBridge().isWorkerPaused() })
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  // OCR worker pause/resume — independent of the translation + whisper workers.
  router.post("/ocr-worker/pause", requireAuth, requirePermission("canManageWorker"), async (_req, res) => {
    try {
      await getOcrWorkerBridge().pauseWorker(res.locals.user!.username)
      res.json({ success: true, workerPaused: getOcrWorkerBridge().isWorkerPaused() })
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  router.post("/ocr-worker/resume", requireAuth, requirePermission("canManageWorker"), async (_req, res) => {
    try {
      await getOcrWorkerBridge().resumeWorker(res.locals.user!.username)
      res.json({ success: true, workerPaused: getOcrWorkerBridge().isWorkerPaused() })
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  // OCR-queue reordering + delete/retry. Mirrors the whisper-queue controls.
  router.post("/ocr/move-up/:id", requireAuth, requirePermission("canChangeSubtitlePriority"), (req, res) => {
    moveOcrJob(db, parseInt(String(req.params.id)), "up")
    res.redirect("/dashboard")
  })

  router.post("/ocr/move-down/:id", requireAuth, requirePermission("canChangeSubtitlePriority"), (req, res) => {
    moveOcrJob(db, parseInt(String(req.params.id)), "down")
    res.redirect("/dashboard")
  })

  router.post("/ocr/reorder", requireAuth, requirePermission("canChangeSubtitlePriority"), (req, res) => {
    const { orderedIds } = req.body as { orderedIds: unknown }
    if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, msg: "Invalid payload" })
    const ids = (orderedIds as unknown[]).map(Number).filter((n) => !isNaN(n))
    reorderOcrJobs(db, ids)
    res.json({ success: true })
  })

  router.post("/ocr/delete/:id", requireAuth, requirePermission("canChangeSubtitlePriority"), (req, res) => {
    deleteOcrJob(db, parseInt(String(req.params.id)))
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent("OCR job removed"))
  })

  router.post("/ocr/retry/:id", requireAuth, requirePermission("canChangeSubtitlePriority"), (req, res) => {
    retryOcrJob(db, parseInt(String(req.params.id)))
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent("OCR job re-queued"))
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
      posterUrl,
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
      posterUrl?: string
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
      const result = await createMediaItem(
        db,
        res.locals.user!,
        mediaTitle,
        originalTitle || null,
        type,
        year,
        isAnime === "1",
        genres || null,
        theMovieDbId || null,
        posterUrl || null,
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
    const id = parseInt(String(req.params.id))
    // deleteNotCancel: when enabled, the cancel action fully deletes the
    // subtitle instead of marking it cancelled. The delete path enforces
    // canDeleteTranslation (inside softDeleteSubtitle); the cancel path
    // enforces canCancelTranslationJob (inside cancelSubtitle) — so the right
    // permission is checked for whichever action actually runs.
    const config = getConfig(db)
    const result = config.deleteNotCancel
      ? softDeleteSubtitle(db, res.locals.user!, id)
      : cancelSubtitle(db, res.locals.user!, id)
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to cancel"))
    }
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent(config.deleteNotCancel ? "Subtitle deleted" : "Job cancelled"))
  })

  router.post("/cancel-job/:jobId", requireAuth, (req, res) => {
    const result = cancelSubtitleJob(db, res.locals.user!, parseInt(String(req.params.jobId)))
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to cancel"))
    }
    res.redirect("/dashboard")
  })

  // Re-add a cancelled subtitle to the queue — the inverse of /cancel/:id.
  // Resets the subtitle and its cancelled jobs/chunks back to 'queued'
  // (completed work is preserved). Gated on the same permission as cancel.
  router.post("/requeue/:id", requireAuth, (req, res) => {
    const result = requeueCancelledSubtitle(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to re-add"))
    }
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent("Subtitle re-added to queue"))
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

  // Delete (or cancel) the series (its episodes) from the queue the button was
  // clicked in. `queue` (whisper|translation|all) scopes the action so removing
  // a series from the whisper queue doesn't also wipe its translation-queue
  // episodes (and vice versa). By default (config.deleteNotCancel = false) this
  // CANCELS the series so it stays visible and can be deleted later; when
  // deleteNotCancel is enabled it fully deletes. Permissions are enforced in the
  // repo: cancel path checks canCancelTranslationJob, delete path checks
  // canDeleteTranslation — matching the per-subtitle routes.
  router.post("/delete-series/:mediaItemId", requireAuth, (req, res) => {
    const queue = String(req.query.queue ?? "all")
    const queueScope: "whisper" | "translation" | "all" =
      queue === "whisper" || queue === "translation" ? queue : "all"
    const mediaItemId = parseInt(String(req.params.mediaItemId))
    const config = getConfig(db)
    const result = config.deleteNotCancel
      ? softDeleteSubtitlesByMediaItem(db, res.locals.user!, mediaItemId, queueScope)
      : cancelSubtitlesByMediaItem(db, res.locals.user!, mediaItemId, queueScope)
    if (!result.success) {
      return res.redirect("/dashboard?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to delete series"))
    }
    res.redirect("/dashboard?toast=success&msg=" + encodeURIComponent(result.msg ?? (config.deleteNotCancel ? "Series deleted" : "Series cancelled")))
  })

  // Whisper-queue reordering (separate whisper queue). Any reorder that can
  // change which item is at the top preempts the in-progress transcription so
  // the worker picks up the new top on its next tick (the killed run's progress
  // is saved as a checkpoint and resumed later).
  router.post("/whisper/move-up/:id", requireAuth, (req, res) => {
    moveWhisperSubtitleInQueue(db, res.locals.user!, parseInt(String(req.params.id)), "up")
    getWhisperWorkerBridge().preemptWorker().catch(() => {})
    res.redirect("/dashboard")
  })

  router.post("/whisper/move-down/:id", requireAuth, (req, res) => {
    moveWhisperSubtitleInQueue(db, res.locals.user!, parseInt(String(req.params.id)), "down")
    getWhisperWorkerBridge().preemptWorker().catch(() => {})
    res.redirect("/dashboard")
  })

  // "Whisper this next": move a subtitle straight to the top of the whisper
  // queue and preempt whatever is currently transcribing so this one starts now.
  router.post("/whisper/move-top/:id", requireAuth, (req, res) => {
    moveWhisperSubtitleToTop(db, res.locals.user!, parseInt(String(req.params.id)))
    getWhisperWorkerBridge().preemptWorker().catch(() => {})
    res.redirect("/dashboard")
  })


  // Bulk cancel/delete for the dashboard multi-select flow. Accepts a JSON body:
  //   { subtitleIds: number[], jobIds: number[] }
  // Active items cancel (or delete when config.deleteNotCancel is on); cancelled
  // items are deleted. Permissions are enforced per item inside bulkCancelDelete
  // (canCancelTranslationJob for cancel, canDeleteTranslation for delete), so a
  // user only needs the permission relevant to the action that actually runs.
  router.post("/bulk", requireAuth, (req, res) => {
    const body = req.body as { subtitleIds?: unknown; jobIds?: unknown }
    if (!Array.isArray(body.subtitleIds) && !Array.isArray(body.jobIds)) {
      return res.status(400).json({ success: false, msg: "Invalid payload" })
    }
    const subtitleIds = Array.isArray(body.subtitleIds) ? (body.subtitleIds as unknown[]).map(Number).filter((n) => !isNaN(n)) : []
    const jobIds = Array.isArray(body.jobIds) ? (body.jobIds as unknown[]).map(Number).filter((n) => !isNaN(n)) : []
    if (subtitleIds.length === 0 && jobIds.length === 0) {
      return res.json({ success: false, msg: "Nothing selected" })
    }
    const config = getConfig(db)
    const result = bulkCancelDelete(db, res.locals.user!, subtitleIds, jobIds, config.deleteNotCancel === 1)
    res.json(result)
  })

  router.post("/reorder", requireAuth, (req, res) => {
    const { orderedIds } = req.body as { orderedIds: unknown }
    if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, msg: "Invalid payload" })
    const ids = (orderedIds as unknown[]).map(Number).filter((n) => !isNaN(n))
    const result = reorderSubtitles(db, res.locals.user!, ids)
    res.json(result)
  })

  router.post("/whisper/reorder", requireAuth, (req, res) => {
    const { orderedIds } = req.body as { orderedIds: unknown }
    if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, msg: "Invalid payload" })
    const ids = (orderedIds as unknown[]).map(Number).filter((n) => !isNaN(n))
    const result = reorderWhisperSubtitles(db, res.locals.user!, ids)
    getWhisperWorkerBridge().preemptWorker().catch(() => {})
    res.json(result)
  })

  
  router.get("/poster/:mediaItemId", requireAuth, (req, res) => {
    const mediaItem = getMediaItemById(db, parseInt(String(req.params.mediaItemId)))
    if (!mediaItem?.mediaItemPhotoPath) return res.status(404).end()
    res.setHeader("Cache-Control", "public, max-age=86400")
    res.sendFile(path.join(MEDIA_PHOTOS_DIR, mediaItem.mediaItemPhotoPath))
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
      resetChunk(db, chunkId)
      res.json({ success: true })
    } catch (e) {
      res.status(500).json({ error: String(e) })
    }
  })

  
  router.get("/download/:jobId", requireAuth, requirePermission("canDownloadFinishedSubtitles"), (req, res) => {
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

    const sourceFormat = subtitle?.sourceFormat ?? "srt"
    const filename = getExportFileName(title, job.season, job.episode, mediaItem?.year ?? null, langCode, sourceFormat)

    const config = getConfig(db)
    const exportContent = finalizeSubtitleForOutput(
      job.translatedText,
      sourceFormat,
      langCode,
      lang?.name ?? "",
      config.thaiAssFont,
    )

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.send(exportContent)
  })

  return router
}
