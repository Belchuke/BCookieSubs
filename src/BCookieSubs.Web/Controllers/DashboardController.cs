using System.Text;
using System.Text.RegularExpressions;
using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Translation;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize]
[Route("dashboard")]
public partial class DashboardController(
    OrchestrationClient orchestration,
    CurrentUserContext currentUser,
    SubtitleTaskService tasks,
    ComputeJobService compute,
    SubtitleRepository subtitles,
    SubtitleJobRepository subtitleJobs,
    SubtitlePipelineRepository pipeline,
    ApplicationConfigRepository configs,
    ApplicationLogRepository logs,
    LanguageRepository languages,
    LibraryMatchingService matching,
    MediaItemService mediaItems,
    MediaItemRepository mediaItemRepo,
    ILogger<DashboardController> logger) : Controller
{
    [HttpGet]
    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        var config = await configs.GetAsync();
        ViewBag.Config = config;
        ViewBag.Languages = await languages.GetAllAsync();
        ViewBag.ShowPosters = config?.ShowPosters == true &&
                               (currentUser.User == null || currentUser.User.ShowPosters);
        ViewBag.DeleteNotCancel = config?.DeleteNotCancel == true;
        var states = await orchestration.GetComputeRunnerStatesAsync();
        ViewBag.WorkerPaused = states?.TranslationPaused ?? false;
        ViewBag.WhisperWorkerPaused = states?.WhisperPaused ?? false;
        ViewBag.OcrWorkerPaused = states?.OcrPaused ?? false;
        var defaults = await languages.GetUserTranslationLanguagesAsync(currentUser.Id);
        ViewBag.DefaultTargetLangIds = defaults.Select(d => d.LanguageId).ToList();
        return View();
    }

    [HttpGet("poll")]
    public async Task<IActionResult> Poll(CancellationToken ct)
    {
        var subs = await subtitles.GetDashboardSubtitlesAsync(ct);
        var langs = await languages.GetAllAsync(ct);
        var recent = currentUser.HasPermission(Permissions.CanViewLogsDashboard)
            ? await logs.GetRecentAsync(20, ct: ct)
            : [];
        var ocrJobs = await compute.GetOcrJobsForDashboardAsync(ct);
        var states = await orchestration.GetComputeRunnerStatesAsync();
        var config = await configs.GetAsync(ct);

        return Json(new
        {
            subtitles = subs,
            languageMap = langs.ToDictionary(l => l.Id, l => new
            {
                l.Id, l.Name, l.Iso639, l.Locale,
                FlagCode = FlagCodes.Derive(l.Locale),
            }),
            logs = recent.Select(DashboardPayloads.Log),
            workerPaused = states?.TranslationPaused ?? false,
            whisperSeparate = config?.WhisperRunAsSeparateTask == true,
            whisperWorkerPaused = states?.WhisperPaused ?? false,
            ocrJobs = ocrJobs.Select(DashboardPayloads.OcrJob),
            ocrWorkerPaused = states?.OcrPaused ?? false,
            deleteNotCancel = config?.DeleteNotCancel == true,
        });
    }


    [HttpGet("queue-row/{id:long}")]
    public async Task<IActionResult> QueueRow(long id, CancellationToken ct) =>
        Json(new { row = await subtitles.GetDashboardSubtitleAsync(id, ct) });

    [HttpGet("logs")]
    public async Task<IActionResult> Logs(CancellationToken ct)
    {
        if (!currentUser.HasPermission(Permissions.CanViewLogsDashboard))
            return Json(new { logs = Array.Empty<object>() });
        var recent = await logs.GetRecentAsync(20, ct: ct);
        return Json(new { logs = recent.Select(DashboardPayloads.Log) });
    }

    [HttpGet("ocr-jobs")]
    public async Task<IActionResult> OcrJobs(CancellationToken ct) =>
        Json(new { ocrJobs = (await compute.GetOcrJobsForDashboardAsync(ct)).Select(DashboardPayloads.OcrJob) });


    [HttpPost("worker/pause")]
    [Authorize(Policy = Policies.Prefix + "canManageWorker")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> PauseWorker()
    {
        var (success, paused) = await orchestration.SetTranslationRunnerPausedAsync(
            true, currentUser.User?.UserName);
        return Json(new { success, workerPaused = paused });
    }

    [HttpPost("worker/resume")]
    [Authorize(Policy = Policies.Prefix + "canManageWorker")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ResumeWorker()
    {
        var (success, paused) = await orchestration.SetTranslationRunnerPausedAsync(
            false, currentUser.User?.UserName);
        return Json(new { success, workerPaused = paused });
    }

    [HttpPost("whisper-worker/pause")]
    [Authorize(Policy = Policies.Prefix + "canManageWorker")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> PauseWhisperWorker()
    {
        var (success, paused) = await orchestration.SetComputeRunnerPausedAsync(
            ComputeRunnerKind.Whisper, true, currentUser.User?.UserName);
        return Json(new { success, workerPaused = paused });
    }

    [HttpPost("whisper-worker/resume")]
    [Authorize(Policy = Policies.Prefix + "canManageWorker")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ResumeWhisperWorker()
    {
        var (success, paused) = await orchestration.SetComputeRunnerPausedAsync(
            ComputeRunnerKind.Whisper, false, currentUser.User?.UserName);
        return Json(new { success, workerPaused = paused });
    }

    [HttpPost("ocr-worker/pause")]
    [Authorize(Policy = Policies.Prefix + "canManageWorker")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> PauseOcrWorker()
    {
        var (success, paused) = await orchestration.SetComputeRunnerPausedAsync(
            ComputeRunnerKind.Ocr, true, currentUser.User?.UserName);
        return Json(new { success, workerPaused = paused });
    }

    [HttpPost("ocr-worker/resume")]
    [Authorize(Policy = Policies.Prefix + "canManageWorker")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ResumeOcrWorker()
    {
        var (success, paused) = await orchestration.SetComputeRunnerPausedAsync(
            ComputeRunnerKind.Ocr, false, currentUser.User?.UserName);
        return Json(new { success, workerPaused = paused });
    }


    [HttpPost("ocr/move-up/{id:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanChangeSubtitlePriority)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> OcrMoveUp(long id)
    {
        await compute.MoveOcrJobAsync(id, true);
        return RedirectBack();
    }

    [HttpPost("ocr/move-down/{id:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanChangeSubtitlePriority)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> OcrMoveDown(long id)
    {
        await compute.MoveOcrJobAsync(id, false);
        return RedirectBack();
    }

    [HttpPost("ocr/reorder")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanChangeSubtitlePriority)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> OcrReorder([FromBody] OrderedIdsRequest body)
    {
        var ids = NormalizeIds(body.OrderedIds);
        if (body.OrderedIds == null) return BadRequest(new { success = false, msg = "Invalid payload" });
        await currentUser.EnsureLoadedAsync();
        await compute.ReorderOcrJobsAsync(currentUser.Id, ids);
        return Json(new { success = true });
    }

    [HttpPost("ocr/delete/{id:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanChangeSubtitlePriority)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> OcrDelete(long id)
    {
        await currentUser.EnsureLoadedAsync();
        await compute.DeleteOcrJobAsync(currentUser.Id, id);
        return RedirectBack(toast: "success", msg: "OCR job removed");
    }

    [HttpPost("ocr/retry/{id:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanChangeSubtitlePriority)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> OcrRetry(long id)
    {
        await currentUser.EnsureLoadedAsync();
        await compute.RetryOcrJobAsync(currentUser.Id, id);
        return RedirectBack(toast: "success", msg: "OCR job re-queued");
    }


    [HttpPost("upload/step1")]
    [RequestFormLimits(MultipartBodyLengthLimit = 268_435_456)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> UploadStep1(IFormFile? srtFile, string? filename)
    {
        if (srtFile == null || srtFile.Length == 0)
            return Json(new { success = false, msg = "No file uploaded" });

        await using var stream = srtFile.OpenReadStream();
        using var reader = new StreamReader(stream);
        var rawContent = await reader.ReadToEndAsync();
        var name = string.IsNullOrWhiteSpace(filename) ? srtFile.FileName : filename;

        NameFormatterDetection? detected = null;
        await currentUser.EnsureLoadedAsync();
        try
        {
            detected = await matching.DetectSubtitleNameAsync(currentUser.Id, name);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Name detection failed for upload step1");
        }

        var lineCount = LineCountRegex().Count(rawContent);

        return Json(new
        {
            success = true,
            filename = name,
            lineCount,
            detected,
        });
    }

    [HttpPost("upload/step2")]
    [RequestFormLimits(MultipartBodyLengthLimit = 268_435_456)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> UploadStep2(
        IFormFile? srtFile, string? mediaTitle, string? mediaType, string? mediaYear,
        string? theMovieDbId, string? posterUrl, string? originalTitle, string? isAnime, string? genres,
        string? mediaItemId, string sourceLangId, string targetLangIds, string? chunkSetting,
        string? season, string? episode)
    {
        if (srtFile == null || srtFile.Length == 0)
            return RedirectBack(toast: "error", msg: "No file uploaded");

        if (string.IsNullOrEmpty(sourceLangId) || string.IsNullOrEmpty(targetLangIds))
            return RedirectBack(toast: "error", msg: "Source and target languages are required");

        if (!long.TryParse(sourceLangId, out var sourceLang) || sourceLang <= 0)
            return RedirectBack(toast: "error", msg: "Invalid source language");
        var targetIds = targetLangIds.Split(',')
            .Select(s => long.TryParse(s, out var n) ? n : 0)
            .Where(n => n > 0)
            .ToList();
        if (targetIds.Count == 0)
            return RedirectBack(toast: "error", msg: "At least one target language is required");

        await currentUser.EnsureLoadedAsync();
        var config = await configs.GetAsync();
        var chunk = int.TryParse(chunkSetting, out var parsedChunk) && parsedChunk > 0
            ? parsedChunk
            : config?.DefaultChunkSize ?? 12;
        int? seasonValue = int.TryParse(season, out var parsedSeason) ? parsedSeason : null;
        int? episodeValue = int.TryParse(episode, out var parsedEpisode) ? parsedEpisode : null;

        await using var stream = srtFile.OpenReadStream();
        using var reader = new StreamReader(stream);
        var rawContent = await reader.ReadToEndAsync();
        var srtFileName = srtFile.FileName;

        long? resolvedMediaItemId = null;
        if (long.TryParse(mediaItemId, out var existingId) && existingId > 0)
        {
            resolvedMediaItemId = existingId;
        }
        else if (!string.IsNullOrWhiteSpace(mediaTitle))
        {
            var type = mediaType switch
            {
                "movie" => MediaKind.Movie,
                "series" => MediaKind.Series,
                _ => MediaKind.Unknown,
            };
            int? year = int.TryParse(mediaYear, out var parsedYear) ? parsedYear : null;
            var mediaResult = await mediaItems.CreateAsync(
                currentUser.Id, mediaTitle, originalTitle, type, year,
                isAnime == "1" || string.Equals(isAnime, "true", StringComparison.OrdinalIgnoreCase),
                genres, theMovieDbId, posterUrl);
            if (mediaResult.Success && mediaResult.MediaItem != null)
            {
                resolvedMediaItemId = mediaResult.MediaItem.Id;
            }
        }

        var result = await tasks.CreateSubtitleTaskAsync(
            currentUser.Id, resolvedMediaItemId, sourceLang, targetIds,
            rawContent, chunk, seasonValue, episodeValue, srtFileName, mediaTitle);

        if (!result.Success)
        {
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to create subtitle task");
        }
        return RedirectBack(toast: "success", msg: result.Msg ?? "Subtitle added to queue");
    }


    [HttpPost("cancel/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Cancel(long id)
    {
        await currentUser.EnsureLoadedAsync();
        var config = await configs.GetAsync();
        var deleteNotCancel = config?.DeleteNotCancel == true;
        var result = deleteNotCancel
            ? await tasks.SoftDeleteSubtitleAsync(currentUser.Id, id)
            : await tasks.CancelSubtitleAsync(currentUser.Id, id);
        if (!result.Success)
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to cancel");
        return RedirectBack(toast: "success", msg: deleteNotCancel ? "Subtitle deleted" : "Job cancelled");
    }

    [HttpPost("cancel-job/{jobId:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CancelJob(long jobId)
    {
        await currentUser.EnsureLoadedAsync();
        var result = await tasks.CancelSubtitleJobAsync(currentUser.Id, jobId);
        if (!result.Success)
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to cancel");
        return RedirectBack();
    }

    [HttpPost("requeue/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Requeue(long id)
    {
        await currentUser.EnsureLoadedAsync();
        var result = await tasks.RequeueCancelledSubtitleAsync(currentUser.Id, id);
        if (!result.Success)
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to re-add");
        return RedirectBack(toast: "success", msg: "Subtitle re-added to queue");
    }

    [HttpPost("hide/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Hide(long id)
    {
        await currentUser.EnsureLoadedAsync();
        var result = await tasks.HideSubtitleAsync(currentUser.Id, id);
        if (!result.Success)
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to hide");
        return RedirectBack(toast: "success", msg: "Subtitle hidden");
    }

    [HttpPost("delete/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(long id)
    {
        await currentUser.EnsureLoadedAsync();
        var result = await tasks.SoftDeleteSubtitleAsync(currentUser.Id, id);
        if (!result.Success)
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to delete");
        return RedirectBack(toast: "success", msg: "Job deleted");
    }

    [HttpPost("delete-job/{jobId:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteJob(long jobId)
    {
        await currentUser.EnsureLoadedAsync();
        var result = await tasks.SoftDeleteSubtitleJobAsync(currentUser.Id, jobId);
        if (!result.Success)
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to delete");
        return RedirectBack(toast: "success", msg: "Translation removed");
    }


    [HttpPost("move-up/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> MoveUp(long id)
    {
        await DoMoveAsync(id, up: true);
        return RedirectBack();
    }

    [HttpPost("move-down/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> MoveDown(long id)
    {
        await DoMoveAsync(id, up: false);
        return RedirectBack();
    }

    [HttpPost("move-series-up/{mediaItemId:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> MoveSeriesUp(long mediaItemId)
    {
        await DoMoveSeriesAsync(mediaItemId, up: true);
        return RedirectBack();
    }

    [HttpPost("move-series-down/{mediaItemId:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> MoveSeriesDown(long mediaItemId)
    {
        await DoMoveSeriesAsync(mediaItemId, up: false);
        return RedirectBack();
    }

    [HttpPost("whisper/move-up/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> WhisperMoveUp(long id)
    {
        await WhisperMoveAsync(id, up: true);
        return RedirectBack();
    }

    [HttpPost("whisper/move-down/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> WhisperMoveDown(long id)
    {
        await WhisperMoveAsync(id, up: false);
        return RedirectBack();
    }

    [HttpPost("whisper/move-top/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> WhisperMoveTop(long id)
    {
        await currentUser.EnsureLoadedAsync();
        await tasks.MoveWhisperSubtitleToTopAsync(currentUser.Id, id);
        return RedirectBack();
    }

    [HttpPost("delete-series/{mediaItemId:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteSeries(long mediaItemId, string? queue)
    {
        await currentUser.EnsureLoadedAsync();
        var queueScope = queue is "whisper" or "translation" ? queue : "all";
        var config = await configs.GetAsync();
        var result = config?.DeleteNotCancel == true
            ? await tasks.SoftDeleteSubtitlesByMediaItemAsync(currentUser.Id, mediaItemId, queueScope)
            : await tasks.CancelSubtitlesByMediaItemAsync(currentUser.Id, mediaItemId, queueScope);
        if (!result.Success)
            return RedirectBack(toast: "error", msg: result.Msg ?? "Failed to delete series");
        return RedirectBack(toast: "success", msg: result.Msg);
    }

    public record OrderedIdsRequest(List<long>? OrderedIds);
    public record BulkRequest(List<long>? SubtitleIds, List<long>? JobIds);

    [HttpPost("bulk")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Bulk([FromBody] BulkRequest body)
    {
        if (body.SubtitleIds == null && body.JobIds == null)
            return BadRequest(new { success = false, msg = "Invalid payload" });
        if ((body.SubtitleIds?.Count ?? 0) == 0 && (body.JobIds?.Count ?? 0) == 0)
            return Json(new { success = false, msg = "Nothing selected" });
        await currentUser.EnsureLoadedAsync();
        var config = await configs.GetAsync();
        var result = await tasks.BulkCancelDeleteAsync(
            currentUser.Id, body.SubtitleIds ?? [], body.JobIds ?? [], config?.DeleteNotCancel == true);
        return Json(new
        {
            result.Success, result.Msg, result.Cancelled, result.Deleted, result.Skipped, result.Failed,
        });
    }

    [HttpPost("reorder")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Reorder([FromBody] OrderedIdsRequest body)
    {
        if (body.OrderedIds == null) return BadRequest(new { success = false, msg = "Invalid payload" });
        await currentUser.EnsureLoadedAsync();
        var result = await tasks.ReorderSubtitlesAsync(currentUser.Id, body.OrderedIds);
        return Json(new { result.Success, result.Msg });
    }

    [HttpPost("whisper/reorder")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> WhisperReorder([FromBody] OrderedIdsRequest body)
    {
        if (body.OrderedIds == null) return BadRequest(new { success = false, msg = "Invalid payload" });
        await currentUser.EnsureLoadedAsync();
        var result = await tasks.ReorderWhisperSubtitlesAsync(currentUser.Id, body.OrderedIds);
        return Json(new { result.Success, result.Msg });
    }


    [HttpGet("poster/{mediaItemId:long}")]
    public async Task<IActionResult> Poster(long mediaItemId, CancellationToken ct)
    {
        var photoPath = await mediaItemRepo.GetPhotoPathAsync(mediaItemId, ct);
        if (string.IsNullOrEmpty(photoPath)) return NotFound();

        var dir = Path.GetFullPath(MediaPhotosService.ResolveDirectory());
        var safe = Path.GetFileName(photoPath);
        var full = Path.GetFullPath(Path.Combine(dir, safe));
        if (!full.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            return NotFound();
        if (!System.IO.File.Exists(full)) return NotFound();

        var contentType = Path.GetExtension(safe).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".jpg" or ".jpeg" => "image/jpeg",
            _ => "application/octet-stream",
        };
        Response.Headers.CacheControl = "public, max-age=86400";
        return PhysicalFile(full, contentType);
    }

    [HttpGet("inspect/{id:long}")]
    public async Task<IActionResult> Inspect(long id, CancellationToken ct)
    {
        var subtitle = await subtitles.GetWithMediaItemAsync(id, ct);
        if (subtitle == null) return NotFound();
        await currentUser.EnsureLoadedAsync();

        var jobs = await subtitleJobs.GetBySubtitleAsync(id, ct);
        var langs = await languages.GetAllAsync(ct);
        var langById = langs.ToDictionary(l => l.Id);

        var jobIds = jobs.Select(j => j.Id).ToList();
        List<SubtitlePipelineRepository.JobChunkRow> allChunks = jobIds.Count == 0
            ? []
            : await pipeline.GetByJobsAsync(jobIds, ct);
        var chunksByJob = allChunks.GroupBy(c => c.SubtitleJobId).ToDictionary(g => g.Key, g => g.ToList());

        var perJob = new List<object>();
        foreach (var job in jobs)
        {
            var chunks = chunksByJob.GetValueOrDefault(job.Id, []);
            var done = chunks.Count(c => c.Status == SubtitleChunkStatus.Completed);
            var failed = chunks.Count(c => c.Status == SubtitleChunkStatus.Failed);
            var jobLang = langById.GetValueOrDefault(job.TargetLanguageId);
            perJob.Add(new
            {
                job = new
                {
                    job.Id, job.TargetLanguageId, job.ChunkSetting,
                    job.Season, job.Episode, job.FinishedAt,
                    Status = EnumText.Snake(job.Status),
                },
                lang = jobLang == null
                    ? null
                    : new
                    {
                        jobLang.Id, jobLang.Name, jobLang.Iso639, jobLang.Locale,
                        FlagCode = FlagCodes.Derive(jobLang.Locale),
                    },
                total = chunks.Count,
                done,
                failed,
                chunks = chunks.Select(c => new
                {
                    c.Id, c.ChunkIndex, c.SrtIdFrom, c.SrtIdTo,
                    Status = EnumText.Snake(c.Status), c.RetryCount, c.JudgeReason,
                    c.ErrorMessage, c.DurationMs, c.StartedAt, c.FinishedAt,
                }),
            });
        }

        var srcLang = langById.GetValueOrDefault(subtitle.SourceLanguageId);
        return Json(new
        {
            subtitle = new
            {
                subtitle.Id, subtitle.Name, subtitle.OriginalFileName, subtitle.CreatedAt,
                Source = subtitle.Source == null ? null : EnumText.Snake(subtitle.Source.Value),
                SourceLangId = subtitle.SourceLanguageId,
                SourceLang = srcLang == null
                    ? null
                    : new
                    {
                        srcLang.Id, srcLang.Name, srcLang.Iso639, srcLang.Locale,
                        FlagCode = FlagCodes.Derive(srcLang.Locale),
                    },
                Status = EnumText.Snake(subtitle.Status),
                WhisperTranscriptionStatus = subtitle.WhisperTranscriptionState == null
                    ? null
                    : EnumText.Snake(subtitle.WhisperTranscriptionState.Value),
                subtitle.WhisperProgress, subtitle.WhisperPositionMs, subtitle.WhisperDurationMs,
                subtitle.WhisperModel,
            },
            mediaItem = subtitle.MediaItem == null ? null : new
            {
                subtitle.MediaItem.Id, subtitle.MediaItem.Title,
                subtitle.MediaItem.Year, subtitle.MediaItem.PhotoPath,
                Type = subtitle.MediaItem.Type.ToString(),
            },
            perJob,
        });
    }

    [HttpPost("retry-chunk/{chunkId:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanRestartTranslationChunk)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RetryChunk(long chunkId)
    {
        var retried = await pipeline.RetryFailedChunkAsync(chunkId);
        return Json(new { success = retried, msg = retried ? null : "Chunk is no longer failed" });
    }

    [HttpPost("reset-chunk/{chunkId:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanRestartTranslationChunk)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ResetChunk(long chunkId)
    {
        await pipeline.ResetChunkAsync(chunkId);
        return Json(new { success = true });
    }

    [HttpGet("download/{jobId:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanDownloadFinishedSubtitles)]
    public async Task<IActionResult> Download(long jobId, CancellationToken ct)
    {
        var job = await subtitleJobs.GetAsync(jobId, ct);
        if (job == null || string.IsNullOrEmpty(job.TranslatedText))
            return NotFound("Translated file not available");

        var subtitle = await subtitles.GetAsync(job.SubtitleId, ct);
        var langs = await languages.GetAllAsync(ct);
        var lang = langs.FirstOrDefault(l => l.Id == job.TargetLanguageId);
        var mediaItem = subtitle?.MediaItemId != null ? subtitle.MediaItem : null;

        var langCode = lang != null ? lang.Iso639.ToLowerInvariant() : job.TargetLanguageId.ToString();
        var rawTitle = mediaItem?.Title ?? subtitle?.Name ?? "subtitle";
        var title = SubtitleExport.SanitizeExportTitle(rawTitle);
        var fileName = SubtitleExport.GetExportFileName(
            title, job.Season, job.Episode, mediaItem?.Year, langCode, subtitle?.SourceFormat ?? SubtitleFormat.Srt);

        var config = await configs.GetAsync(ct);
        var exportContent = SubtitleExport.FinalizeSubtitleForOutput(
            job.TranslatedText, subtitle?.SourceFormat ?? SubtitleFormat.Srt,
            langCode, lang?.Name ?? "", config?.ThaiAssFont ?? SubtitleExport.DefaultThaiAssFont);

        // File(string, ...) is the virtual-path overload — encode to bytes.
        return File(Encoding.UTF8.GetBytes(exportContent), "text/plain; charset=utf-8", fileName);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async Task DoMoveAsync(long id, bool up)
    {
        await currentUser.EnsureLoadedAsync();
        await tasks.MoveSubtitleInQueueAsync(currentUser.Id, id, up);
    }

    private async Task DoMoveSeriesAsync(long mediaItemId, bool up)
    {
        await currentUser.EnsureLoadedAsync();
        await tasks.MoveSeriesInQueueAsync(currentUser.Id, mediaItemId, up);
    }

    private async Task WhisperMoveAsync(long id, bool up)
    {
        await currentUser.EnsureLoadedAsync();
        await tasks.MoveWhisperSubtitleInQueueAsync(currentUser.Id, id, up);
    }

    private static List<long> NormalizeIds(List<long>? ids) =>
        ids?.Where(n => n > 0).ToList() ?? [];

    private IActionResult RedirectBack(string? toast = null, string? msg = null) =>
        string.IsNullOrEmpty(toast)
            ? RedirectToAction("Index")
            : RedirectToAction("Index", new { toast, msg = msg ?? "" });

    [GeneratedRegex(@"^\d+$", RegexOptions.Multiline)]
    private static partial Regex LineCountRegex();
}