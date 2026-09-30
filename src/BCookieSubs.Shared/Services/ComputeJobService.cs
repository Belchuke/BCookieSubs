using System.Text.Json;
using System.Text.Json.Serialization;
using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace BCookieSubs.Shared.Services;

public record ComputeJobReply(bool Success, string Msg, long? JobId = null, long? SubtitleId = null);

public sealed record OcrJobInput(
    long ItemId, long UserId, string? Name, bool ResetStatus,
    LibraryAutoTranslateService.SubtitleSourceOverride? SourceOverride, string? SourceLanguageHint);

public sealed record WhisperJobInput(
    long SubtitleId, string MediaPath, string Model, int TimestampsLength, bool UseCuda,
    string? ResumeSrt, long ResumeMs, string? ModelRootPath);

public sealed record OcrDispatchInput(string ImageKind, string ImagePath, string? OcrLang, string? Name);

public class ComputeJobService(
    BCookieSubsDbContext db,
    WorkerJobRepository jobs,
    SubtitleRepository subtitles,
    SubtitleTaskService tasks,
    LibraryAutoTranslateService autoTranslate,
    LibrarySubtitleExportService export,
    MediaItemService mediaItems,
    LanguageRepository languages,
    ApplicationConfigRepository configRepo,
    ApplicationLogRepository logs,
    PermissionService permissions,
    IDashboardEventPublisher dashboardEvents)
{
    public const string OcrJobType = WorkerJobTypes.Ocr;
    public const string WhisperJobType = WorkerJobTypes.WhisperTranscribe;

    public const string OcrCapability = "ocr";
    public const string WhisperCapability = "whisper";

    private static readonly JsonSerializerOptions PayloadJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly JsonSerializerOptions ResultJson = new()
    {
        PropertyNameCaseInsensitive = true,
    };


    public async Task<ComputeJobReply> EnqueueOcrJobAsync(
        long itemId, long userId, string? name, LibraryAutoTranslateService.SubtitleSourceOverride? sourceOverride,
        string? sourceLanguageHint, bool resetStatus, CancellationToken ct = default)
    {
        var item = await db.LibraryPathItems.FirstOrDefaultAsync(i => i.Id == itemId, ct);
        if (item == null) return new ComputeJobReply(false, "Item not found");

        if (sourceOverride is { Type: "external", Path.Length: > 0 })
        {
            var root = await db.LibraryPaths
                .Where(p => p.Id == item.LibraryPathId)
                .Select(p => p.Path)
                .FirstOrDefaultAsync(ct);
            if (!LibraryPathsService.IsWithinRoot(sourceOverride.Path, root))
                return new ComputeJobReply(false, "Source file is outside the library path");
        }

        name ??= await OcrJobDisplayNameAsync(item, ct);
        var maxPriority = await db.WorkerJobs
            .Where(j => j.JobType == OcrJobType)
            .MaxAsync(j => (int?)j.Priority, ct) ?? 0;

        var job = new WorkerJob
        {
            JobType = OcrJobType,
            RequiredCapability = OcrCapability,
            SubjectType = "libraryPathItem",
            SubjectId = itemId,
            Payload = JsonSerializer.Serialize(new OcrJobInput(
                itemId, userId, name, resetStatus, sourceOverride, sourceLanguageHint), PayloadJson),
            DisplayName = name,
            CreatedByUserId = userId,
            MaxRetries = 3,
            Priority = maxPriority + 1,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };
        if (!await TryAddJobAsync(jobs, job, ct))
            return new ComputeJobReply(false, "This item is already in the OCR queue");

        await LogAsync(LogLevelKind.Info, "libraryScanner", itemId,
            $"Added to OCR queue: {name}", new { ocrJobId = job.Id, name }, ct);
        dashboardEvents.OcrQueueChanged(job.Id);
        return new ComputeJobReply(true, "Added to OCR queue", job.Id);
    }

    private static async Task<bool> TryAddJobAsync(WorkerJobRepository jobs, WorkerJob job, CancellationToken ct)
    {
        try
        {
            await jobs.AddAsync(job, ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: "23505" })
        {
            return false;
        }
    }

    private async Task<string> OcrJobDisplayNameAsync(LibraryPathItem item, CancellationToken ct)
    {
        if (item.MediaItemId != null)
        {
            var title = await db.MediaItems.Where(m => m.Id == item.MediaItemId.Value)
                .Select(m => (string?)m.Title).FirstOrDefaultAsync(ct);
            if (title != null) return title;
        }
        return Path.GetFileName(item.Path);
    }


    public async Task<List<WorkerJobRepository.OcrDashboardRow>> GetOcrJobsForDashboardAsync(CancellationToken ct = default)
    {
        var rows = await jobs.GetOcrDashboardRowsAsync(ct);
        return rows.Where(r => r.Status is WorkerJobStatus.Queued or WorkerJobStatus.Running or WorkerJobStatus.Failed)
            .ToList();
    }

    public async Task<ComputeJobReply> MoveOcrJobAsync(long jobId, bool up, CancellationToken ct = default)
    {
        var queued = await jobs.GetQueuedOcrJobsAsync(ct);
        var idx = queued.FindIndex(j => j.Id == jobId);
        if (idx == -1) return new ComputeJobReply(true, "");
        var swap = up ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= queued.Count) return new ComputeJobReply(true, "");

        await jobs.SetOcrPrioritiesAsync(
        [
            (queued[idx].Id, queued[swap].Priority),
            (queued[swap].Id, queued[idx].Priority),
        ], ct);
        dashboardEvents.OcrQueueChanged(jobId);
        return new ComputeJobReply(true, "");
    }

    public async Task<ComputeJobReply> ReorderOcrJobsAsync(long userId, List<long> orderedIds, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new ComputeJobReply(false, "Permission denied");

        await jobs.SetOcrPrioritiesAsync(
            orderedIds.Select((id, i) => (id, (i + 1) * 10)).ToList(), ct);
        return new ComputeJobReply(true, "");
    }

    public async Task<ComputeJobReply> RetryOcrJobAsync(long userId, long jobId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new ComputeJobReply(false, "Permission denied");
        await jobs.ResetOcrForRetryAsync(jobId, ct);
        dashboardEvents.OcrQueueChanged(jobId);
        return new ComputeJobReply(true, "");
    }

    public async Task<ComputeJobReply> DeleteOcrJobAsync(long userId, long jobId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new ComputeJobReply(false, "Permission denied");
        await jobs.DeleteAsync(jobId, ct);
        dashboardEvents.OcrQueueChanged(jobId);
        return new ComputeJobReply(true, "");
    }

    // ── Whisper workflow creation ─────────

    public async Task<SubtitleTaskResult> CreateWhisperSubtitleAsync(
        long userId, long itemId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanCreateSubtitlesWithWhisper, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var item = await db.LibraryPathItems.FirstOrDefaultAsync(i => i.Id == itemId, ct);
        if (item == null) return new SubtitleTaskResult(false, "Item not found");
        var libraryPath = await db.LibraryPaths.FirstOrDefaultAsync(p => p.Id == item.LibraryPathId, ct);
        if (libraryPath == null) return new SubtitleTaskResult(false, "Library path not found");
        var sourceLang = await db.Languages.FirstOrDefaultAsync(l => l.Id == libraryPath.SourceLanguageId, ct);
        if (sourceLang == null) return new SubtitleTaskResult(false, "Source language not found");

        var targetLangIds = (await languages.GetUserTranslationLanguagesAsync(userId, ct))
            .Select(t => t.LanguageId).ToList();
        if (targetLangIds.Count == 0)
            targetLangIds = (await languages.GetDefaultTranslationLanguagesAsync(ct))
                .Select(t => t.LanguageId).ToList();
        if (targetLangIds.Count == 0) return new SubtitleTaskResult(false, "No target languages configured");

        var mediaItemId = item.MediaItemId;
        if (mediaItemId == null)
        {
            var title = Path.GetFileNameWithoutExtension(item.Path).Replace(".", " ").Replace("_", " ").Trim();
            var created = await mediaItems.CreateAsync(userId, title, null,
                libraryPath.Type == LibraryPathType.Movie ? MediaKind.Movie : MediaKind.Series,
                null, false, null, ct: ct);
            if (!created.Success || created.MediaItem == null)
                return new SubtitleTaskResult(false, created.Msg ?? "Could not create media item");
            mediaItemId = created.MediaItem.Id;
            await db.LibraryPathItems.Where(i => i.Id == item.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.MediaItemId, mediaItemId)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        }

        if (await subtitles.GetActiveWhisperSubtitleForMediaItemAsync(mediaItemId.Value, ct) != null)
            return new SubtitleTaskResult(true, "Whisper subtitle workflow already exists");

        var config = await configRepo.GetAsync(ct);
        if (config == null) return new SubtitleTaskResult(false, "Configuration not found");

        var displayName = await db.MediaItems.Where(m => m.Id == mediaItemId.Value)
            .Select(m => (string?)m.Title).FirstOrDefaultAsync(ct)
            ?? Path.GetFileName(item.Path);
        var srtFileName = $"{Path.GetFileNameWithoutExtension(item.Path)}.whisper.srt";

        var nextPriority = await db.Subtitles.Where(s => s.DeletedAt == null)
            .MaxAsync(s => (int?)s.Priority, ct) ?? 0;
        var nextWhisperPriority = await subtitles.NextWhisperOrderNumberAsync(ct);

        var now = DateTime.UtcNow;
        var subtitle = new Subtitle
        {
            UserId = userId,
            SourceLanguageId = sourceLang.Id,
            MediaItemId = mediaItemId,
            LibraryPathItemId = item.Id,
            Name = displayName,
            OriginalFileHash = "",
            OriginalFileName = srtFileName,
            OriginalText = "",
            Source = SubtitleSourceKind.Whisper,
            SourcePath = null,
            MediaPath = item.Path,
            Status = SubtitleStatus.Queued,
            WhisperTranscriptionState = WhisperTranscriptionState.QueuedForTranscription,
            WhisperModel = config.WhisperModel,
            WhisperTimestampsLength = config.WhisperTimestampsLength,
            WhisperUseCuda = config.WhisperUseCuda,
            Season = item.Season,
            Episode = item.Episode,
            Priority = nextPriority + 1,
            WhisperPriority = nextWhisperPriority,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await subtitles.AddAsync(subtitle);

        await LogAsync(LogLevelKind.Info, "subtitleCreate", subtitle.Id, "Created Whisper subtitle workflow",
            new { mediaItemId, libraryPathItemId = item.Id, model = config.WhisperModel }, ct);
        dashboardEvents.WhisperQueueChanged(subtitle.Id);

        if (targetLangIds.Count > 0)
        {
            await tasks.CreatePlaceholderTranslationJobsAsync(userId, subtitle.Id, targetLangIds,
                item.Season, item.Episode, ct);
        }

        return new SubtitleTaskResult(true, "Whisper subtitle workflow created", subtitle.Id);
    }

    // ── Whisper queue ─────────

    public Task<Subtitle?> GetNextWhisperSubtitleAsync(bool separateTask, CancellationToken ct = default) =>
        subtitles.GetNextWhisperSubtitleAsync(separateTask, ct);

    /// <summary>
    /// Creates the dispatch job for the next queued whisper subtitle, if none exists.
    /// A queued transcription with Whisper disabled fails outright.
    /// </summary>
    public async Task<WorkerJob?> EnsureWhisperJobAsync(Subtitle subtitle, CancellationToken ct = default)
    {
        if (await jobs.HasActiveForSubjectAsync("subtitle", subtitle.Id, WhisperJobType, ct))
            return null;

        var config = await configRepo.GetAsync(ct);
        if (config is not { WhisperEnabled: true })
        {
            await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
                WhisperTranscriptionState.TranscriptionFailed, ct);
            await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.Status, SubtitleStatus.Failed)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
            await LogAsync(LogLevelKind.Error, "whisperTranscription", subtitle.Id,
                "Whisper transcription is not enabled", new { }, ct);
            dashboardEvents.TranslationChanged(subtitle.Id);
            return null;
        }

        var job = new WorkerJob
        {
            JobType = WhisperJobType,
            RequiredCapability = WhisperCapability,
            SubjectType = "subtitle",
            SubjectId = subtitle.Id,
            Payload = WhisperPayload(subtitle, config),
            DisplayName = subtitle.Name,
            CreatedByUserId = subtitle.UserId,
            MaxRetries = 3,
            Priority = 0,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };
        if (!await TryAddJobAsync(jobs, job, ct))
            return null;

        await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
            WhisperTranscriptionState.QueuedForTranscription, ct);
        return job;
    }

    private static string WhisperPayload(Subtitle subtitle, ApplicationConfig config) =>
        JsonSerializer.Serialize(new WhisperJobInput(
            subtitle.Id,
            subtitle.MediaPath ?? "",
            subtitle.WhisperModel ?? config.WhisperModel,
            subtitle.WhisperTimestampsLength ?? config.WhisperTimestampsLength,
            subtitle.WhisperUseCuda ?? config.WhisperUseCuda,
            subtitle.WhisperResumeSrt,
            subtitle.WhisperResumeMs,
            config.WhisperModelRootPath), PayloadJson);

    /// <summary>Payload rebuilt at claim time so the resume checkpoint is always fresh.</summary>
    public async Task<string> BuildWhisperPayloadAsync(Subtitle subtitle, CancellationToken ct = default) =>
        WhisperPayload(subtitle, (await configRepo.GetAsync(ct))!);

    // ── Gateway callbacks ───────────────────────────────────────────────────

    /// <summary>
    /// Progress also refreshes the job lease, so it doubles as the job heartbeat.
    /// Whisper gets the longer lease: its progress can be sparse over long silences.
    /// </summary>
    public async Task HandleProgressAsync(
        long jobId, long workerId, int progress, string? status, CancellationToken ct = default)
    {
        var job = await jobs.GetAsync(jobId, ct);
        if (job == null) return;

        var lease = job.JobType == WhisperJobType ? TimeSpan.FromMinutes(10) : TimeSpan.FromMinutes(5);
        await jobs.UpdateHeartbeatAsync(jobId, workerId, lease, ct);
        await jobs.UpdateProgressAsync(jobId, workerId, progress, ct);

        if (job.JobType == WhisperJobType && job.SubjectType == "subtitle" && job.SubjectId != null)
        {
            var subtitle = await subtitles.GetAsync(job.SubjectId.Value, ct);
            if (subtitle == null) return;

            long positionMs = 0, durationMs = 0;
            try
            {
                if (!string.IsNullOrEmpty(status))
                {
                    var info = JsonSerializer.Deserialize<WhisperProgressInfo>(status, ResultJson);
                    positionMs = info?.PositionMs ?? 0;
                    durationMs = info?.DurationMs ?? 0;
                }
            }
            catch (JsonException)
            {
            }
            await subtitles.SetWhisperProgressAsync(subtitle.Id, progress, positionMs, durationMs, ct);
            dashboardEvents.TranslationChanged(subtitle.Id);

            var mark = positionMs / (15 * 60 * 1000);
            if (positionMs > 0 && mark > subtitle.WhisperPositionMs / (15 * 60 * 1000))
                await LogWhisperRunAsync(subtitle.Id, $"Whispered {mark * 15} min for {subtitle.Name}",
                    new { positionMs, durationMs }, ct);
        }
    }

    private sealed record WhisperProgressInfo(long PositionMs, long DurationMs);

    public async Task HandleResultAsync(
        long jobId, long workerId, bool success, string? result, string? errorCode, string? errorMessage,
        CancellationToken ct = default)
    {
        var job = await jobs.GetAsync(jobId, ct);
        if (job == null) return;

        if (!await jobs.DeleteClaimedByWorkerAsync(jobId, workerId, ct))
        {
            await LogAsync(LogLevelKind.Warning, "workerState", job.SubjectId ?? 0,
                $"Ignored stale result for job {jobId} (claim no longer held)",
                new { jobId, workerId }, ct);
            return;
        }

        if (job.JobType == OcrJobType)
        {
            await HandleOcrResultAsync(job, success, result, errorMessage, ct);
            dashboardEvents.OcrQueueChanged(job.Id);
        }
        else if (job.JobType == WhisperJobType)
        {
            await HandleWhisperResultAsync(job, success, result, errorCode, errorMessage, ct);
            if (job.SubjectId != null)
            {
                dashboardEvents.WhisperQueueChanged(job.SubjectId.Value);
                dashboardEvents.TranslationChanged(job.SubjectId.Value);
            }
        }
    }

    private async Task HandleOcrResultAsync(
        WorkerJob job, bool success, string? result, string? errorMessage, CancellationToken ct)
    {
        var input = TryDeserialize<OcrJobInput>(job.Payload);
        if (input == null)
        {
            await LogAsync(LogLevelKind.Error, "libraryScanner", job.SubjectId ?? 0,
                "OCR job failed: could not parse stored job input", new { ocrJobId = job.Id }, ct);
            return;
        }

        if (!success)
        {
            await LogAsync(LogLevelKind.Error, "libraryScanner", input.ItemId,
                $"OCR job failed: {errorMessage ?? "unknown error"}",
                new { ocrJobId = job.Id, name = input.Name, error = errorMessage }, ct);
            return;
        }

        var ocr = TryDeserialize<OcrResultPayload>(result);
        if (ocr == null || string.IsNullOrWhiteSpace(ocr.Srt))
        {
            await LogAsync(LogLevelKind.Error, "libraryScanner", input.ItemId,
                "OCR job returned no subtitle text",
                new { ocrJobId = job.Id, name = input.Name }, ct);
            return;
        }

        await LogAsync(LogLevelKind.Info, "libraryScanner", input.ItemId,
            $"OCR completed ({ocr.OcrRows} rows, {ocr.EmptyRows} empty) — queuing translation",
            new { ocrJobId = job.Id, ocrRows = ocr.OcrRows, emptyRows = ocr.EmptyRows, kind = ocr.Kind }, ct);
        await QueueTranslationFromOcrAsync(job, input, ocr.Srt, ct);
    }

    /// <summary>Text-source OCR jobs complete inline (dispatcher resolution); no Python needed.</summary>
    public async Task CompleteOcrTextSourceAsync(WorkerJob job, string srtContent, CancellationToken ct)
    {
        var input = TryDeserialize<OcrJobInput>(job.Payload);
        if (input == null) return;
        await QueueTranslationFromOcrAsync(job, input, srtContent, ct);
    }

    /// <summary>Fail an OCR job during dispatcher source resolution (before any Python dispatch).</summary>
    public async Task FailOcrJobDuringResolutionAsync(
        WorkerJob job, string message, CancellationToken ct = default)
    {
        var input = TryDeserialize<OcrJobInput>(job.Payload);
        await LogAsync(LogLevelKind.Error, "libraryScanner", input?.ItemId ?? job.SubjectId ?? 0,
            $"OCR job failed: {message}", new { ocrJobId = job.Id, name = input?.Name }, ct);
    }

    private async Task QueueTranslationFromOcrAsync(
        WorkerJob job, OcrJobInput input, string srt, CancellationToken ct)
    {
        ExtractTemp.EnsureDir();
        var srtPath = ExtractTemp.MakePath("ocr", $"job{job.Id}");
        await File.WriteAllTextAsync(srtPath, srt, ct);

        var translation = await autoTranslate.PrepareTranslationForItemAsync(
            input.ItemId, input.ResetStatus, input.UserId, input.SourceOverride,
            input.SourceLanguageHint, srtPath, ct);
        if (!translation.Success)
        {
            await LogAsync(LogLevelKind.Error, "libraryScanner", input.ItemId,
                $"OCR job {job.Id} completed but translation queueing failed: {translation.Msg}",
                new { ocrJobId = job.Id, msg = translation.Msg }, ct);
        }
        else
        {
            await LogAsync(LogLevelKind.Info, "libraryScanner", input.ItemId,
                $"OCR job {job.Id} completed; translation jobs created", new { ocrJobId = job.Id }, ct);
        }
    }

    private sealed record OcrResultPayload(string Srt, int OcrRows, int EmptyRows, string? Kind);

    private async Task HandleWhisperResultAsync(
        WorkerJob job, bool success, string? result, string? errorCode, string? errorMessage, CancellationToken ct)
    {
        if (job.SubjectType != "subtitle" || job.SubjectId == null) return;
        var subtitle = await subtitles.GetAsync(job.SubjectId.Value, ct);
        if (subtitle == null) return;

        if (!success && errorCode == "aborted")
        {
            var checkpoint = TryDeserialize<CheckpointPayload>(result);
            if (checkpoint != null && !string.IsNullOrEmpty(checkpoint.Srt))
            {
                await subtitles.SaveWhisperCheckpointAsync(subtitle.Id, checkpoint.Srt, checkpoint.Ms, ct);
                await LogAsync(LogLevelKind.Info, "whisperTranscription", subtitle.Id,
                    $"Whisper transcription paused at {checkpoint.Ms}ms; will resume from there",
                    new { checkpointMs = checkpoint.Ms, segments = checkpoint.Segments }, ct);
            }
            return;
        }

        if (!success)
        {
            await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
                WhisperTranscriptionState.TranscriptionFailed, ct);
            await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.Status, SubtitleStatus.Failed)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
            await LogAsync(LogLevelKind.Error, "whisperTranscription", subtitle.Id,
                $"Whisper transcription failed: {(errorMessage ?? "unknown error").Truncate(200)}",
                new { error = (errorMessage ?? "").Truncate(200) }, ct);
            return;
        }

        await FinalizeWhisperTranscriptionAsync(subtitle, result ?? "", ct);
    }

    private sealed record CheckpointPayload(string Srt, long Ms, int Segments);

    // Transcription finalize: persist the generated SRT,
    // write the original-language export, then create the translation jobs.
    private async Task FinalizeWhisperTranscriptionAsync(Subtitle subtitle, string result, CancellationToken ct)
    {
        var payload = TryDeserialize<WhisperResultPayload>(result);
        var rawSrt = payload?.Srt;
        if (string.IsNullOrWhiteSpace(rawSrt))
        {
            await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
                WhisperTranscriptionState.TranscriptionFailed, ct);
            await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.Status, SubtitleStatus.Failed)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
            await LogAsync(LogLevelKind.Error, "whisperTranscription", subtitle.Id,
                "Whisper transcription failed: worker returned no SRT", new { }, ct);
            return;
        }

        var entries = SrtParser.Parse(rawSrt);
        var deduped = WhisperSupport.DeduplicateSrtEntries(entries);
        if (deduped.Count == 0)
        {
            await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
                WhisperTranscriptionState.TranscriptionFailed, ct);
            await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.Status, SubtitleStatus.Failed)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
            await LogAsync(LogLevelKind.Error, "whisperTranscription", subtitle.Id,
                "Whisper generated an empty or unparseable SRT", new { }, ct);
            return;
        }
        var dedupedSrt = SrtParser.Serialize(deduped);

        await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.OriginalText, dedupedSrt)
            .SetProperty(x => x.OriginalFileHash, Trcnk.GetFileHash(rawSrt))
            .SetProperty(x => x.WhisperTranscriptionState, WhisperTranscriptionState.TranscriptionCompleted)
            .SetProperty(x => x.WhisperResumeSrt, (string?)null)
            .SetProperty(x => x.WhisperResumeMs, 0L)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

        await LogAsync(LogLevelKind.Info, "whisperCompleted", subtitle.Id,
            $"Whisper transcription completed for media item {subtitle.MediaItemId}",
            new { model = payload?.Model, lineCount = deduped.Count }, ct);

        var fresh = await db.Subtitles.AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == subtitle.Id, ct);
        if (fresh != null)
        {
            await export.ExportSubtitleToLibraryFolderAsync(fresh,
                new ExportOptions { IncludeOriginal = true, IncludeTranslated = true, MarkCompleted = false }, ct);
        }

        var actingUserId = subtitle.UserId;
        var userLangs = (await languages.GetUserTranslationLanguagesAsync(actingUserId, ct))
            .Select(t => t.LanguageId).ToList();
        var targetLangIds = userLangs.Count > 0
            ? userLangs
            : (await languages.GetDefaultTranslationLanguagesAsync(ct)).Select(t => t.LanguageId).ToList();

        if (targetLangIds.Count == 0)
        {
            await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
                WhisperTranscriptionState.TranscriptionFailed, ct);
            await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.Status, SubtitleStatus.Failed)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
            await LogAsync(LogLevelKind.Error, "subtitleCompleted", subtitle.Id,
                "Whisper transcription completed but no target languages configured; cannot create translation jobs", new { }, ct);
            return;
        }

        var config = await configRepo.GetAsync(ct);
        await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
            WhisperTranscriptionState.QueuedForTranslation, ct);
        var jobResult = await tasks.CreateTranslationJobsForSubtitleAsync(
            actingUserId, subtitle.Id, targetLangIds,
            config?.DefaultChunkSize ?? 10, subtitle.Season, subtitle.Episode, ct);

        if (!jobResult.Success)
        {
            await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
                WhisperTranscriptionState.TranscriptionFailed, ct);
            await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
                .SetProperty(x => x.Status, SubtitleStatus.Failed)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
            await LogAsync(LogLevelKind.Error, "whisperTranscription", subtitle.Id,
                $"Failed to create translation jobs from Whisper SRT: {jobResult.Msg}", new { }, ct);
            return;
        }

        await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id, null, ct);
        await db.Subtitles.Where(s => s.Id == subtitle.Id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.Status, SubtitleStatus.Queued)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        await LogAsync(LogLevelKind.Info, "subtitleCreate", subtitle.Id,
            "Whisper-generated SRT imported and translation jobs created",
            new { targetLangCount = targetLangIds.Count }, ct);
    }

    private sealed record WhisperResultPayload(string Srt, int LineCount, string? Model);

    private static T? TryDeserialize<T>(string? json) where T : class
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<T>(json, ResultJson);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private async Task LogWhisperRunAsync(long subtitleId, string message, object metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new ApplicationLog
            {
                Level = LogLevelKind.Info,
                Type = "whisperRun",
                EntityType = "subtitle",
                EntityId = subtitleId,
                Message = message,
                Metadata = JsonSerializer.Serialize(metadata, PayloadJson),
                CreatedAt = DateTime.UtcNow,
            }, ct);
        }
        catch (Exception)
        {
        }
    }

    private async Task<bool> HasPermissionAsync(long userId, string permission, CancellationToken ct)
    {
        var effective = await permissions.GetEffectivePermissionsAsync(userId, ct);
        return effective.Contains(permission);
    }

    private async Task LogAsync(LogLevelKind level, string type, long? entityId,
        string message, object? metadata, CancellationToken ct)
    {
        try
        {
            var log = new ApplicationLog
            {
                Level = level,
                Type = type,
                EntityType = type,
                EntityId = entityId,
                Message = message,
                Metadata = metadata is null ? null : JsonSerializer.Serialize(metadata, PayloadJson),
                CreatedAt = DateTime.UtcNow,
            };
            await logs.AddAsync(log, ct);
            dashboardEvents.LogAdded(log.Id);
        }
        catch (Exception)
        {
        }
    }
}

public static class WhisperSupport
{
    public static List<SrtEntry> DeduplicateSrtEntries(List<SrtEntry> entries)
    {
        if (entries.Count == 0) return [];

        var result = new List<SrtEntry>();
        var runStart = 0;
        var runText = entries[0].Text;

        for (var i = 1; i <= entries.Count; i++)
        {
            var atEnd = i == entries.Count;
            var sameAsRun = !atEnd && entries[i].Text == runText;

            if (!sameAsRun)
            {
                var runLength = i - runStart;
                if (runLength > 3)
                {
                    var first = entries[runStart];
                    var last = entries[i - 1];
                    result.Add(first with { EndMs = last.EndMs, EndTime = last.EndTime, Text = runText });
                }
                else
                {
                    for (var j = runStart; j < i; j++) result.Add(entries[j]);
                }

                if (!atEnd)
                {
                    runStart = i;
                    runText = entries[i].Text;
                }
            }
        }

        return result.Select((e, idx) => e with { Id = (idx + 1).ToString() }).ToList();
    }
}

public static class StringTruncateExtensions
{
    public static string Truncate(this string s, int max) =>
        string.IsNullOrEmpty(s) || s.Length <= max ? s : s[..max];
}