using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public record SubtitleTaskResult(bool Success, string? Msg, long? SubtitleId = null);

public class SubtitleTaskService(
    BCookieSubsDbContext db,
    PermissionService permissions,
    ApplicationLogRepository logs,
    IDashboardEventPublisher dashboardEvents)
{

    public async Task<SubtitleTaskResult> CreateSubtitleTaskAsync(
        long userId, long? mediaItemId, long sourceLangId, List<long> targetLangIds,
        string rawContent, int chunkSetting, int? season, int? episode, string srtFileName,
        string? displayName = null, SubtitleSourceKind? source = null, string? sourcePath = null,
        string? mediaPath = null, long? libraryPathItemId = null,
        SubtitleTextOrigin? textOrigin = null, OriginalSubtitleFormat? originalSourceFormat = null,
        CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanAddSubtitleToTranslateDashboard, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var sourceLang = await db.Languages.FirstOrDefaultAsync(l => l.Id == sourceLangId, ct);
        if (sourceLang == null) return new SubtitleTaskResult(false, "Source language not found");
        targetLangIds = ExcludeSourceLanguage(targetLangIds, sourceLangId);
        var orderedLangs = await OrderLangsByConfigAsync(targetLangIds, ct);

        var sourceFormat = SubtitleFormatDetector.DetectSubtitleFormat(srtFileName, rawContent);
        var rows = SubtitleAdapter.ParseSubtitleRows(rawContent, sourceFormat);
        if (rows.Count == 0)
            return new SubtitleTaskResult(false, "Could not parse subtitle file — file may be empty or malformed");

        var fileHash = Trcnk.GetFileHash(rawContent);
        var existing = await db.Subtitles.FirstOrDefaultAsync(s => s.OriginalFileHash == fileHash && s.DeletedAt == null, ct);

        if (existing != null)
        {
            var added = await AddMissingJobsAsync(existing, userId, orderedLangs, chunkSetting, season, episode, ct);
            if (added == null) return new SubtitleTaskResult(false, "Subtitle not found");
            if (added.Count == 0)
                return new SubtitleTaskResult(true, "Subtitle already exists with all requested target languages", existing.Id);

            await LogAsync("subtitleCreate", existing.Id,
                "Added missing jobs for re-uploaded subtitle", new { langs = added.Select(l => l.Name) }, ct);
            dashboardEvents.TranslationChanged(existing.Id);
            return new SubtitleTaskResult(true, $"Added {added.Count} new language job(s) to existing subtitle", existing.Id);
        }

        var chunks = ChunkRows(rows, chunkSetting);
        var nextPriority = await NextSubtitlePriorityAsync(ct);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var now = DateTime.UtcNow;
        var subtitle = new Subtitle
        {
            UserId = userId,
            SourceLanguageId = sourceLangId,
            MediaItemId = mediaItemId,
            LibraryPathItemId = libraryPathItemId,
            Name = string.IsNullOrWhiteSpace(displayName) ? srtFileName : displayName,
            OriginalFileHash = fileHash,
            OriginalFileName = srtFileName,
            OriginalText = rawContent,
            SourceFormat = sourceFormat,
            Priority = nextPriority,
            Source = source,
            SourcePath = sourcePath,
            MediaPath = mediaPath,
            TextOrigin = textOrigin,
            OriginalSourceFormat = originalSourceFormat,
            Status = SubtitleStatus.Queued,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Subtitles.Add(subtitle);
        await db.SaveChangesAsync(ct);

        for (var i = 0; i < orderedLangs.Count; i++)
        {
            await CreateJobWithChunksAsync(subtitle.Id, userId, orderedLangs[i].Id,
                chunkSetting, chunks, season, episode, i + 1, ct);
        }
        await tx.CommitAsync(ct);

        await LogAsync("subtitleCreate", null, "Created subtitle task",
            new { name = srtFileName, langs = orderedLangs.Select(l => l.Name) }, ct);
        dashboardEvents.TranslationChanged(subtitle.Id);
        return new SubtitleTaskResult(true, "Subtitle task created successfully", subtitle.Id);
    }


    public async Task<SubtitleTaskResult> CreatePlaceholderTranslationJobsAsync(
        long userId, long subtitleId, List<long> targetLangIds, int? season, int? episode,
        CancellationToken ct = default)
    {
        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId && s.DeletedAt == null, ct);
        if (subtitle == null) return new SubtitleTaskResult(false, "Subtitle not found");
        targetLangIds = ExcludeSourceLanguage(targetLangIds, subtitle.SourceLanguageId);

        var existingJobs = await db.SubtitleJobs.Where(j => j.SubtitleId == subtitleId).ToListAsync(ct);
        var existingLangIds = existingJobs.Select(j => j.TargetLanguageId).ToHashSet();
        var newLangs = new List<Language>();
        foreach (var id in targetLangIds)
        {
            if (existingLangIds.Contains(id)) continue;
            var lang = await db.Languages.FirstOrDefaultAsync(l => l.Id == id, ct);
            if (lang != null) newLangs.Add(lang);
        }

        if (newLangs.Count == 0)
            return new SubtitleTaskResult(true, "All requested languages already exist", subtitleId);

        var maxPriority = existingJobs.Count == 0 ? 0 : existingJobs.Max(j => j.Priority);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        for (var i = 0; i < newLangs.Count; i++)
        {
            db.SubtitleJobs.Add(new SubtitleJob
            {
                SubtitleId = subtitleId,
                UserId = userId,
                TargetLanguageId = newLangs[i].Id,
                ChunkSetting = 10,
                TotalChunks = 0,
                CurrentChunk = 0,
                Season = season,
                Episode = episode,
                Priority = maxPriority + 1 + i,
                Status = SubtitleJobStatus.Queued,
                CreatedAt = DateTime.UtcNow,
                UpdatedAt = DateTime.UtcNow,
            });
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        await LogAsync("subtitleCreate", subtitleId,
            "Created placeholder translation jobs for Whisper workflow",
            new { addedLangs = newLangs.Select(l => l.Name) }, ct);
        dashboardEvents.TranslationChanged(subtitleId);
        return new SubtitleTaskResult(true, $"Added {newLangs.Count} placeholder translation job(s)", subtitleId);
    }

    public async Task<SubtitleTaskResult> CreateTranslationJobsForSubtitleAsync(
        long userId, long subtitleId, List<long> targetLangIds, int chunkSetting,
        int? season, int? episode, CancellationToken ct = default)
    {
        var subtitle = await db.Subtitles.AsNoTracking()
            .FirstOrDefaultAsync(s => s.Id == subtitleId && s.DeletedAt == null, ct);
        if (subtitle == null) return new SubtitleTaskResult(false, "Subtitle not found");
        targetLangIds = ExcludeSourceLanguage(targetLangIds, subtitle.SourceLanguageId);

        var rows = SubtitleAdapter.ParseSubtitleRows(subtitle.OriginalText, subtitle.SourceFormat);
        if (rows.Count == 0)
            return new SubtitleTaskResult(false, "Original SRT could not be parsed");

        var chunks = ChunkRows(rows, chunkSetting);
        var existingJobs = await db.SubtitleJobs.Where(j => j.SubtitleId == subtitleId).ToListAsync(ct);
        var existingLangIds = existingJobs.Select(j => j.TargetLanguageId).ToHashSet();

        var newLangs = new List<Language>();
        foreach (var id in targetLangIds)
        {
            if (existingLangIds.Contains(id)) continue;
            var lang = await db.Languages.FirstOrDefaultAsync(l => l.Id == id, ct);
            if (lang != null) newLangs.Add(lang);
        }
        var placeholderJobs = existingJobs.Where(j =>
            j.Status == SubtitleJobStatus.Queued && j.TotalChunks == 0 &&
            targetLangIds.Contains(j.TargetLanguageId)).ToList();

        if (newLangs.Count == 0 && placeholderJobs.Count == 0)
            return new SubtitleTaskResult(true, "All requested languages already exist", subtitleId);

        var maxPriority = existingJobs.Count == 0 ? 0 : existingJobs.Max(j => j.Priority);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        foreach (var job in placeholderJobs)
        {
            await db.SubtitleJobs.Where(j => j.Id == job.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.ChunkSetting, chunkSetting)
                .SetProperty(x => x.TotalChunks, chunks.Count)
                .SetProperty(x => x.CurrentChunk, 0)
                .SetProperty(x => x.Season, season)
                .SetProperty(x => x.Episode, episode)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
            await CreateChunksAsync(subtitleId, job.Id, job.TargetLanguageId, chunks, ct);
        }

        for (var i = 0; i < newLangs.Count; i++)
        {
            await CreateJobWithChunksAsync(subtitleId, userId, newLangs[i].Id,
                chunkSetting, chunks, season, episode, maxPriority + 1 + i, ct);
        }

        await RequeueTerminalSubtitleAsync(subtitleId, ct);
        await tx.CommitAsync(ct);

        await LogAsync("subtitleCreate", subtitleId,
            "Created translation jobs from Whisper-generated SRT",
            new { addedLangs = newLangs.Select(l => l.Name) }, ct);
        dashboardEvents.TranslationChanged(subtitleId);
        return new SubtitleTaskResult(true, $"Added {newLangs.Count} translation job(s)", subtitleId);
    }

    public async Task<SubtitleTaskResult> AddMissingTargetLanguageJobsAsync(
        long userId, long subtitleId, List<long> newTargetLangIds, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanAddSubtitleToTranslateFromLibrary, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId && s.DeletedAt == null, ct);
        if (subtitle == null) return new SubtitleTaskResult(false, "Subtitle not found");
        newTargetLangIds = ExcludeSourceLanguage(newTargetLangIds, subtitle.SourceLanguageId);
        if (newTargetLangIds.Count == 0)
            return new SubtitleTaskResult(true, "No new languages to add", subtitleId);

        var existingJobs = await db.SubtitleJobs.Where(j => j.SubtitleId == subtitleId).ToListAsync(ct);
        var existingLangIds = existingJobs.Select(j => j.TargetLanguageId).ToHashSet();

        var newLangs = new List<Language>();
        foreach (var id in newTargetLangIds)
        {
            if (existingLangIds.Contains(id)) continue;
            var lang = await db.Languages.FirstOrDefaultAsync(l => l.Id == id, ct);
            if (lang != null) newLangs.Add(lang);
        }
        if (newLangs.Count == 0)
            return new SubtitleTaskResult(true, "All requested languages already exist", subtitleId);

        var rows = SubtitleAdapter.ParseSubtitleRows(subtitle.OriginalText, subtitle.SourceFormat);
        if (rows.Count == 0)
            return new SubtitleTaskResult(false, "Original subtitle could not be parsed", subtitleId);

        var chunkSetting = existingJobs.FirstOrDefault()?.ChunkSetting ?? 10;
        var chunks = ChunkRows(rows, chunkSetting);

        var minPriority = await db.SubtitleJobs
            .Where(j => j.DeletedAt == null)
            .MinAsync(j => (int?)j.Priority, ct) ?? 1;
        var priorityStart = minPriority - newLangs.Count;

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        for (var i = 0; i < newLangs.Count; i++)
        {
            await CreateJobWithChunksAsync(subtitleId, userId, newLangs[i].Id,
                chunkSetting, chunks, existingJobs.FirstOrDefault()?.Season,
                existingJobs.FirstOrDefault()?.Episode, priorityStart + i, ct);
        }
        await RequeueTerminalSubtitleAsync(subtitleId, ct);
        await tx.CommitAsync(ct);

        await LogAsync("subtitleCreate", subtitleId, "Added missing language jobs",
            new { addedLangs = newLangs.Select(l => l.Name) }, ct);
        dashboardEvents.TranslationChanged(subtitleId);
        return new SubtitleTaskResult(true, $"Added {newLangs.Count} language job(s) with priority", subtitleId);
    }


    public async Task<SubtitleTaskResult> CancelSubtitleAsync(long userId, long subtitleId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanCancelTranslationJob, ct))
            return new SubtitleTaskResult(false, "User does not have permission to stop subtitles");

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId && s.DeletedAt == null, ct);
        if (subtitle == null) return new SubtitleTaskResult(false, "Subtitle not found");
        if (subtitle.Status == SubtitleStatus.Completed)
            return new SubtitleTaskResult(false, "Cannot cancel a completed subtitle");

        var now = DateTime.UtcNow;
        await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, SubtitleStatus.Cancelled)
            .SetProperty(x => x.CancelledAt, now)
            .SetProperty(x => x.CancelledByUserId, userId)
            .SetProperty(x => x.UpdatedAt, now), ct);

        await db.SubtitleJobs.Where(j => j.SubtitleId == subtitleId &&
                j.Status != SubtitleJobStatus.Completed && j.Status != SubtitleJobStatus.Cancelled)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleJobStatus.Cancelled)
                .SetProperty(x => x.CancelledAt, now)
                .SetProperty(x => x.CancelledByUserId, userId)
                .SetProperty(x => x.UpdatedAt, now), ct);

        await db.SubtitleChunks.Where(c => c.SubtitleId == subtitleId &&
                c.Status != SubtitleChunkStatus.Completed && c.Status != SubtitleChunkStatus.Cancelled)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleChunkStatus.Cancelled)
                .SetProperty(x => x.UpdatedAt, now), ct);

        await LogAsync("subtitleCancel", subtitleId, "Cancelled subtitle", new { cancelledBy = userId }, ct);
        dashboardEvents.TranslationChanged(subtitleId);
        return new SubtitleTaskResult(true, null, subtitleId);
    }

    public async Task<SubtitleTaskResult> RequeueCancelledSubtitleAsync(long userId, long subtitleId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanCancelTranslationJob, ct))
            return new SubtitleTaskResult(false, "User does not have permission to re-queue subtitles");

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId && s.DeletedAt == null, ct);
        if (subtitle == null) return new SubtitleTaskResult(false, "Subtitle not found");
        if (subtitle.Status != SubtitleStatus.Cancelled)
            return new SubtitleTaskResult(false, "Only cancelled subtitles can be re-added");

        var now = DateTime.UtcNow;
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, SubtitleStatus.Queued)
            .SetProperty(x => x.CancelledAt, (DateTime?)null)
            .SetProperty(x => x.CancelledByUserId, (long?)null)
            .SetProperty(x => x.UpdatedAt, now), ct);

        await db.SubtitleJobs.Where(j => j.SubtitleId == subtitleId &&
                j.Status == SubtitleJobStatus.Cancelled && j.DeletedAt == null)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleJobStatus.Queued)
                .SetProperty(x => x.CancelledAt, (DateTime?)null)
                .SetProperty(x => x.CancelledByUserId, (long?)null)
                .SetProperty(x => x.UpdatedAt, now), ct);

        await db.SubtitleChunkCandidates
            .Where(c => c.SubtitleChunk.SubtitleId == subtitleId &&
                        c.SubtitleChunk.Status == SubtitleChunkStatus.Cancelled)
            .ExecuteDeleteAsync(ct);

        await db.SubtitleChunks.Where(c => c.SubtitleId == subtitleId &&
                c.Status == SubtitleChunkStatus.Cancelled)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleChunkStatus.Queued)
                .SetProperty(x => x.RetryCount, 0)
                .SetProperty(x => x.StartedAt, (DateTime?)null)
                .SetProperty(x => x.FinishedAt, (DateTime?)null)
                .SetProperty(x => x.ErrorMessage, (string?)null)
                .SetProperty(x => x.SelectedCandidateId, (long?)null)
                .SetProperty(x => x.UpdatedAt, now), ct);

        await tx.CommitAsync(ct);

        await LogAsync("subtitleCancel", subtitleId, "Re-added cancelled subtitle to the queue",
            new { requeuedBy = userId }, ct);
        dashboardEvents.TranslationChanged(subtitleId);
        return new SubtitleTaskResult(true, null, subtitleId);
    }

    public async Task<SubtitleTaskResult> CancelSubtitleJobAsync(long userId, long jobId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanCancelTranslationJob, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var job = await db.SubtitleJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job == null) return new SubtitleTaskResult(false, "Job not found");
        if (job.Status == SubtitleJobStatus.Completed)
            return new SubtitleTaskResult(false, "Cannot cancel a completed job");
        if (job.Status == SubtitleJobStatus.Cancelled)
            return new SubtitleTaskResult(false, "Job already cancelled");

        var now = DateTime.UtcNow;
        await db.SubtitleJobs.Where(j => j.Id == jobId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, SubtitleJobStatus.Cancelled)
            .SetProperty(x => x.CancelledAt, now)
            .SetProperty(x => x.CancelledByUserId, userId)
            .SetProperty(x => x.UpdatedAt, now), ct);

        await db.SubtitleChunks.Where(c => c.SubtitleJobId == jobId &&
                c.Status != SubtitleChunkStatus.Completed && c.Status != SubtitleChunkStatus.Cancelled)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleChunkStatus.Cancelled)
                .SetProperty(x => x.UpdatedAt, now), ct);

        var remaining = await db.SubtitleJobs.CountAsync(j =>
            j.SubtitleId == job.SubtitleId && j.DeletedAt == null &&
            j.Status != SubtitleJobStatus.Completed && j.Status != SubtitleJobStatus.Cancelled, ct);
        if (remaining == 0)
        {
            await db.Subtitles.Where(s => s.Id == job.SubtitleId).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleStatus.Cancelled)
                .SetProperty(x => x.CancelledAt, now)
                .SetProperty(x => x.CancelledByUserId, userId)
                .SetProperty(x => x.UpdatedAt, now), ct);
        }

        await LogAsync("subtitleCancel", job.SubtitleId, "Cancelled subtitle job",
            new { jobId, cancelledBy = userId }, ct);
        dashboardEvents.TranslationChanged(job.SubtitleId);
        return new SubtitleTaskResult(true, null, job.SubtitleId);
    }


    private async Task<bool> HasPermissionAsync(long userId, string permission, CancellationToken ct)
    {
        var perms = await permissions.GetEffectivePermissionsAsync(userId, ct);
        return perms.Contains(permission);
    }

    private static List<long> ExcludeSourceLanguage(List<long> targetLangIds, long sourceLangId) =>
        targetLangIds.Where(id => id != sourceLangId).ToList();

    private async Task<List<Language>> OrderLangsByConfigAsync(List<long> targetLangIds, CancellationToken ct)
    {
        var configPositions = await db.ConfigTranslationLanguages
            .ToDictionaryAsync(c => c.LanguageId, c => (int?)c.Position, ct);

        var items = new List<(Language Lang, int OriginalIndex, int? Position)>();
        for (var i = 0; i < targetLangIds.Count; i++)
        {
            var lang = await db.Languages.FirstOrDefaultAsync(l => l.Id == targetLangIds[i], ct);
            if (lang == null) continue;
            items.Add((lang, i, configPositions.GetValueOrDefault(lang.Id)));
        }

        return items
            .OrderBy(x => x.Position.HasValue ? 0 : 1)
            .ThenBy(x => x.Position ?? 0)
            .ThenBy(x => x.OriginalIndex)
            .Select(x => x.Lang)
            .ToList();
    }

    private static List<List<SubtitleRow>> ChunkRows(List<SubtitleRow> rows, int size)
    {
        if (size <= 0) return [rows];
        var outChunks = new List<List<SubtitleRow>>();
        for (var i = 0; i < rows.Count; i += size)
            outChunks.Add(rows.Skip(i).Take(size).ToList());
        return outChunks;
    }

    private async Task<int> NextSubtitlePriorityAsync(CancellationToken ct)
    {
        var max = await db.Subtitles.Where(s => s.DeletedAt == null)
            .MaxAsync(s => (int?)s.Priority, ct);
        return (max ?? 0) + 1;
    }

    private async Task CreateJobWithChunksAsync(
        long subtitleId, long userId, long targetLanguageId, int chunkSetting,
        List<List<SubtitleRow>> chunks, int? season, int? episode, int priority, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var job = new SubtitleJob
        {
            SubtitleId = subtitleId,
            UserId = userId,
            TargetLanguageId = targetLanguageId,
            ChunkSetting = chunkSetting,
            TotalChunks = chunks.Count,
            CurrentChunk = 0,
            Season = season,
            Episode = episode,
            Priority = priority,
            Status = SubtitleJobStatus.Queued,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.SubtitleJobs.Add(job);
        await db.SaveChangesAsync(ct);
        await CreateChunksAsync(subtitleId, job.Id, targetLanguageId, chunks, ct);
    }

    private async Task CreateChunksAsync(
        long subtitleId, long jobId, long targetLanguageId, List<List<SubtitleRow>> chunks, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        for (var i = 0; i < chunks.Count; i++)
        {
            var chunk = chunks[i];
            db.SubtitleChunks.Add(new SubtitleChunk
            {
                SubtitleId = subtitleId,
                SubtitleJobId = jobId,
                TargetLanguageId = targetLanguageId,
                ChunkIndex = i,
                SrtIdFrom = int.Parse(chunk[0].Id),
                SrtIdTo = int.Parse(chunk[^1].Id),
                Status = SubtitleChunkStatus.Queued,
                CreatedAt = now,
                UpdatedAt = now,
            });
        }
        await db.SaveChangesAsync(ct);
    }

    private Task RequeueTerminalSubtitleAsync(long subtitleId, CancellationToken ct) =>
        db.Subtitles
            .Where(s => s.Id == subtitleId && (
                s.Status == SubtitleStatus.Completed ||
                s.Status == SubtitleStatus.Cancelled ||
                s.Status == SubtitleStatus.Failed))
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleStatus.Queued)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    private async Task<List<Language>?> AddMissingJobsAsync(
        Subtitle subtitle, long userId, List<Language> orderedLangs,
        int chunkSetting, int? season, int? episode, CancellationToken ct)
    {
        var existingJobs = await db.SubtitleJobs.Where(j => j.SubtitleId == subtitle.Id).ToListAsync(ct);
        var existingLangIds = existingJobs.Select(j => j.TargetLanguageId).ToHashSet();
        var missing = orderedLangs.Where(l => !existingLangIds.Contains(l.Id)).ToList();
        if (missing.Count == 0) return [];

        var rows = SubtitleAdapter.ParseSubtitleRows(subtitle.OriginalText, subtitle.SourceFormat);
        var chunks = ChunkRows(rows, chunkSetting);
        var maxPriority = existingJobs.Count == 0 ? 0 : existingJobs.Max(j => j.Priority);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        for (var i = 0; i < missing.Count; i++)
        {
            await CreateJobWithChunksAsync(subtitle.Id, userId, missing[i].Id,
                chunkSetting, chunks, season, episode, maxPriority + 1 + i, ct);
        }
        await RequeueTerminalSubtitleAsync(subtitle.Id, ct);
        await tx.CommitAsync(ct);
        return missing;
    }

    private async Task LogAsync(string type, long? subtitleId, string message, object? metadata, CancellationToken ct)
    {
        try
        {
            var log = new ApplicationLog
            {
                Level = LogLevelKind.Info,
                Type = type,
                EntityType = "subtitle",
                EntityId = subtitleId,
                Message = message,
                Metadata = metadata is null ? null : System.Text.Json.JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            };
            await logs.AddAsync(log, ct);
            dashboardEvents.LogAdded(log.Id);
        }
        catch (Exception)
        {
        }
    }


    public async Task<SubtitleTaskResult> SoftDeleteSubtitleAsync(long userId, long subtitleId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanDeleteTranslation, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId && s.DeletedAt == null, ct);
        if (subtitle == null) return new SubtitleTaskResult(false, "Subtitle not found");

        var now = DateTime.UtcNow;
        await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.DeletedAt, now)
            .SetProperty(x => x.DeletedByUserId, userId)
            .SetProperty(x => x.UpdatedAt, now), ct);

        await LogAsync("subtitleDelete", subtitleId, "Deleted subtitle", new { deletedBy = userId }, ct);
        dashboardEvents.TranslationRemoved(subtitleId);
        return new SubtitleTaskResult(true, null, subtitleId);
    }

    public async Task<SubtitleTaskResult> HideSubtitleAsync(long userId, long subtitleId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage subtitles");

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId && s.DeletedAt == null, ct);
        if (subtitle == null) return new SubtitleTaskResult(false, "Subtitle not found");

        await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Hide, true)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

        await LogAsync("subtitle", subtitleId, "Hidden subtitle from dashboard", new { hiddenBy = userId }, ct);
        dashboardEvents.TranslationRemoved(subtitleId);
        return new SubtitleTaskResult(true, null, subtitleId);
    }

    private IQueryable<Subtitle> MovableQueueQuery() =>
        db.Subtitles.AsNoTracking().Where(s =>
            s.DeletedAt == null &&
            s.Status != SubtitleStatus.Completed &&
            s.Status != SubtitleStatus.Cancelled &&
            s.Status != SubtitleStatus.Failed);

    public async Task<SubtitleTaskResult> MoveSubtitleInQueueAsync(
        long userId, long subtitleId, bool up, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage subtitles");

        var others = await MovableQueueQuery()
            .OrderBy(s => s.Priority).ToListAsync(ct);
        var idx = others.FindIndex(s => s.Id == subtitleId);
        if (idx == -1) return new SubtitleTaskResult(false, "Subtitle not in movable queue");
        var swap = up ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= others.Count) return new SubtitleTaskResult(true, null);

        await SwapPrioritiesAsync(others[idx], others[swap], ct);
        dashboardEvents.TranslationChanged(others[idx].Id);
        dashboardEvents.TranslationChanged(others[swap].Id);
        return new SubtitleTaskResult(true, null);
    }

    private async Task SwapPrioritiesAsync(Subtitle a, Subtitle b, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        await db.Subtitles.Where(s => s.Id == a.Id).ExecuteUpdateAsync(
            u => u.SetProperty(x => x.Priority, b.Priority).SetProperty(x => x.UpdatedAt, now), ct);
        await db.Subtitles.Where(s => s.Id == b.Id).ExecuteUpdateAsync(
            u => u.SetProperty(x => x.Priority, a.Priority).SetProperty(x => x.UpdatedAt, now), ct);
    }

    public async Task<SubtitleTaskResult> MoveSeriesInQueueAsync(
        long userId, long mediaItemId, bool up, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage subtitles");

        var all = await MovableQueueQuery().OrderBy(s => s.Priority).ToListAsync(ct);
        if (all.Count == 0) return new SubtitleTaskResult(true, null);

        var blocks = new List<List<Subtitle>>();
        foreach (var s in all)
        {
            var last = blocks.LastOrDefault();
            if (last != null && last[0].MediaItemId == s.MediaItemId) last.Add(s);
            else blocks.Add([s]);
        }

        var idx = blocks.FindIndex(b => b[0].MediaItemId == mediaItemId);
        if (idx == -1) return new SubtitleTaskResult(false, "Series not found in active queue");
        var swap = up ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= blocks.Count) return new SubtitleTaskResult(true, null);
        (blocks[idx], blocks[swap]) = (blocks[swap], blocks[idx]);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var order = 1;
        foreach (var block in blocks)
        {
            foreach (var s in block)
            {
                await db.Subtitles.Where(x => x.Id == s.Id).ExecuteUpdateAsync(
                    u => u.SetProperty(x => x.Priority, order).SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
                order++;
            }
        }
        await tx.CommitAsync(ct);
        return new SubtitleTaskResult(true, null);
    }

    public async Task<SubtitleTaskResult> ReorderSubtitlesAsync(long userId, List<long> orderedIds, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage subtitles");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        for (var i = 0; i < orderedIds.Count; i++)
        {
            await db.Subtitles.Where(s => s.Id == orderedIds[i]).ExecuteUpdateAsync(
                u => u.SetProperty(x => x.Priority, (i + 1) * 10).SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        }
        await tx.CommitAsync(ct);
        return new SubtitleTaskResult(true, null);
    }

    private IQueryable<Subtitle> MovableWhisperQueueQuery() =>
        db.Subtitles.AsNoTracking().Where(s =>
            s.Source == SubtitleSourceKind.Whisper &&
            s.DeletedAt == null &&
            s.Status != SubtitleStatus.Completed &&
            s.Status != SubtitleStatus.Cancelled &&
            s.Status != SubtitleStatus.Failed &&
            s.WhisperTranscriptionState != null &&
            s.WhisperTranscriptionState != WhisperTranscriptionState.TranscriptionCompleted &&
            s.WhisperTranscriptionState != WhisperTranscriptionState.TranscriptionFailed);

    public async Task<SubtitleTaskResult> MoveWhisperSubtitleInQueueAsync(
        long userId, long subtitleId, bool up, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage subtitles");

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId, ct);
        if (subtitle == null || subtitle.Source != SubtitleSourceKind.Whisper)
            return new SubtitleTaskResult(false, "Subtitle not found");

        var others = await MovableWhisperQueueQuery()
            .OrderBy(s => s.WhisperPriority ?? s.Priority).ThenBy(s => s.Id)
            .ToListAsync(ct);
        var idx = others.FindIndex(s => s.Id == subtitleId);
        if (idx == -1) return new SubtitleTaskResult(false, "Subtitle not in whisper queue");
        var swap = up ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= others.Count) return new SubtitleTaskResult(true, null);

        var a = others[idx];
        var b = others[swap];
        var now = DateTime.UtcNow;
        await db.Subtitles.Where(s => s.Id == a.Id).ExecuteUpdateAsync(
            u => u.SetProperty(x => x.WhisperPriority, b.WhisperPriority ?? b.Priority).SetProperty(x => x.UpdatedAt, now), ct);
        await db.Subtitles.Where(s => s.Id == b.Id).ExecuteUpdateAsync(
            u => u.SetProperty(x => x.WhisperPriority, a.WhisperPriority ?? a.Priority).SetProperty(x => x.UpdatedAt, now), ct);
        dashboardEvents.WhisperQueueChanged(a.Id);
        dashboardEvents.WhisperQueueChanged(b.Id);
        return new SubtitleTaskResult(true, null);
    }

    public async Task<SubtitleTaskResult> MoveWhisperSubtitleToTopAsync(long userId, long subtitleId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage subtitles");

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == subtitleId, ct);
        if (subtitle == null || subtitle.Source != SubtitleSourceKind.Whisper)
            return new SubtitleTaskResult(false, "Subtitle not found");

        var min = await MovableWhisperQueueQuery()
            .MinAsync(s => (int?)(s.WhisperPriority ?? s.Priority), ct);
        var now = DateTime.UtcNow;
        await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(
            u => u.SetProperty(x => x.WhisperPriority, (min ?? 0) - 10).SetProperty(x => x.UpdatedAt, now), ct);
        dashboardEvents.WhisperQueueChanged(subtitleId);
        return new SubtitleTaskResult(true, null);
    }

    public async Task<SubtitleTaskResult> ReorderWhisperSubtitlesAsync(long userId, List<long> orderedIds, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanChangeSubtitlePriority, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage subtitles");

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        for (var i = 0; i < orderedIds.Count; i++)
        {
            await db.Subtitles.Where(s => s.Id == orderedIds[i]).ExecuteUpdateAsync(
                u => u.SetProperty(x => x.WhisperPriority, (i + 1) * 10).SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        }
        await tx.CommitAsync(ct);
        return new SubtitleTaskResult(true, null);
    }

    private IQueryable<Subtitle> SeriesScopeQuery(long mediaItemId, string queueScope)
    {
        var query = db.Subtitles.AsNoTracking().Where(s => s.MediaItemId == mediaItemId && s.DeletedAt == null);
        return queueScope switch
        {
            "whisper" => query.Where(s =>
                s.Source == SubtitleSourceKind.Whisper &&
                s.WhisperTranscriptionState != null &&
                s.WhisperTranscriptionState != WhisperTranscriptionState.TranscriptionCompleted),
            "translation" => query.Where(s =>
                s.Source != SubtitleSourceKind.Whisper ||
                s.WhisperTranscriptionState == null ||
                s.WhisperTranscriptionState == WhisperTranscriptionState.TranscriptionCompleted),
            _ => query,
        };
    }

    public async Task<SubtitleTaskResult> SoftDeleteSubtitlesByMediaItemAsync(
        long userId, long mediaItemId, string queueScope, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanDeleteTranslation, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var subs = await SeriesScopeQuery(mediaItemId, queueScope)
            .Select(s => new { s.Id, s.Name })
            .ToListAsync(ct);
        if (subs.Count == 0) return new SubtitleTaskResult(false, "Series not found in queue");

        var now = DateTime.UtcNow;
        var ids = subs.Select(s => s.Id).ToList();
        await db.Subtitles.Where(s => ids.Contains(s.Id)).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.DeletedAt, now)
            .SetProperty(x => x.DeletedByUserId, userId)
            .SetProperty(x => x.UpdatedAt, now), ct);

        foreach (var s in subs)
            await LogAsync("subtitleDelete", s.Id, "Deleted subtitle (series delete)",
                new { deletedBy = userId, mediaItemId, queueScope, name = s.Name }, ct);
        foreach (var s in subs)
            dashboardEvents.TranslationRemoved(s.Id);
        return new SubtitleTaskResult(true, $"Deleted {subs.Count} subtitle(s)");
    }

    public async Task<SubtitleTaskResult> CancelSubtitlesByMediaItemAsync(
        long userId, long mediaItemId, string queueScope, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanCancelTranslationJob, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var subs = await SeriesScopeQuery(mediaItemId, queueScope)
            .Where(s => s.Status != SubtitleStatus.Completed &&
                        s.Status != SubtitleStatus.Cancelled &&
                        s.Status != SubtitleStatus.Failed)
            .Select(s => new { s.Id, s.Name })
            .ToListAsync(ct);
        if (subs.Count == 0) return new SubtitleTaskResult(false, "Series not found in queue");

        var now = DateTime.UtcNow;
        foreach (var s in subs)
        {
            await db.Subtitles.Where(x => x.Id == s.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleStatus.Cancelled)
                .SetProperty(x => x.CancelledAt, now)
                .SetProperty(x => x.CancelledByUserId, userId)
                .SetProperty(x => x.UpdatedAt, now), ct);
            await db.SubtitleJobs.Where(j => j.SubtitleId == s.Id &&
                    j.DeletedAt == null &&
                    j.Status != SubtitleJobStatus.Completed && j.Status != SubtitleJobStatus.Cancelled)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(x => x.Status, SubtitleJobStatus.Cancelled)
                    .SetProperty(x => x.CancelledAt, now)
                    .SetProperty(x => x.CancelledByUserId, userId)
                    .SetProperty(x => x.UpdatedAt, now), ct);
            await db.SubtitleChunks.Where(c => c.SubtitleId == s.Id &&
                    c.Status != SubtitleChunkStatus.Completed && c.Status != SubtitleChunkStatus.Cancelled)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(x => x.Status, SubtitleChunkStatus.Cancelled)
                    .SetProperty(x => x.UpdatedAt, now), ct);
            await LogAsync("subtitleCancel", s.Id, "Cancelled subtitle (series cancel)",
                new { cancelledBy = userId, mediaItemId, queueScope, name = s.Name }, ct);
        }
        foreach (var s in subs)
            dashboardEvents.TranslationChanged(s.Id);

        return new SubtitleTaskResult(true, $"Cancelled {subs.Count} subtitle(s)");
    }

    public async Task<BulkCancelDeleteResult> BulkCancelDeleteAsync(
        long userId, List<long> subtitleIds, List<long> jobIds, bool deleteNotCancel, CancellationToken ct = default)
    {
        int cancelled = 0, deleted = 0, skipped = 0, failed = 0;
        var processedSubtitles = new HashSet<long>();

        foreach (var subtitleId in subtitleIds)
        {
            var sub = await db.Subtitles.AsNoTracking().FirstOrDefaultAsync(s => s.Id == subtitleId, ct);
            if (sub == null || sub.DeletedAt != null) { skipped++; continue; }

            SubtitleTaskResult result;
            if (sub.Status == SubtitleStatus.Cancelled)
            {
                result = await SoftDeleteSubtitleAsync(userId, subtitleId, ct);
                if (result.Success) deleted++; else failed++;
            }
            else if (sub.Status is SubtitleStatus.Completed or SubtitleStatus.Failed)
            {
                skipped++;
            }
            else
            {
                result = deleteNotCancel
                    ? await SoftDeleteSubtitleAsync(userId, subtitleId, ct)
                    : await CancelSubtitleAsync(userId, subtitleId, ct);
                if (result.Success) { if (deleteNotCancel) deleted++; else cancelled++; }
                else failed++;
            }
        }

        foreach (var jobId in jobIds)
        {
            var job = await db.SubtitleJobs.AsNoTracking().FirstOrDefaultAsync(j => j.Id == jobId, ct);
            if (job == null || job.DeletedAt != null) { skipped++; continue; }
            if (processedSubtitles.Contains(job.SubtitleId)) { skipped++; continue; }

            SubtitleTaskResult result;
            if (job.Status == SubtitleJobStatus.Cancelled)
            {
                result = await SoftDeleteSubtitleJobAsync(userId, jobId, ct);
                if (result.Success) deleted++; else failed++;
            }
            else if (job.Status is SubtitleJobStatus.Completed or SubtitleJobStatus.Failed)
            {
                skipped++;
            }
            else
            {
                result = deleteNotCancel
                    ? await SoftDeleteSubtitleJobAsync(userId, jobId, ct)
                    : await CancelSubtitleJobAsync(userId, jobId, ct);
                if (result.Success) { if (deleteNotCancel) deleted++; else cancelled++; }
                else failed++;
            }
        }

        var msg = $"Cancelled {cancelled}, deleted {deleted}, skipped {skipped}" +
                  (failed > 0 ? $", failed {failed}" : "");
        return new BulkCancelDeleteResult(true, msg, cancelled, deleted, skipped, failed);
    }

    // Remove one completed/failed job from the Translated page (soft-delete);
    // still-active chunks are cancelled so the worker never re-picks them.
    public async Task<SubtitleTaskResult> SoftDeleteSubtitleJobAsync(long userId, long jobId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanDeleteTranslation, ct))
            return new SubtitleTaskResult(false, "Permission denied");

        var job = await db.SubtitleJobs.FirstOrDefaultAsync(j => j.Id == jobId, ct);
        if (job == null) return new SubtitleTaskResult(false, "Translation not found");

        var now = DateTime.UtcNow;
        await db.SubtitleJobs.Where(j => j.Id == jobId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.DeletedAt, now)
            .SetProperty(x => x.DeletedByUserId, userId)
            .SetProperty(x => x.UpdatedAt, now), ct);

        await db.SubtitleChunks.Where(c => c.SubtitleJobId == jobId &&
                c.Status != SubtitleChunkStatus.Completed && c.Status != SubtitleChunkStatus.Cancelled)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleChunkStatus.Cancelled)
                .SetProperty(x => x.UpdatedAt, now), ct);

        await LogAsync("subtitleDelete", job.SubtitleId, "Removed translation from Translated page",
            new { jobId, removedBy = userId }, ct);
        return new SubtitleTaskResult(true, null);
    }
}

public record BulkCancelDeleteResult(bool Success, string Msg, int Cancelled, int Deleted, int Skipped, int Failed);