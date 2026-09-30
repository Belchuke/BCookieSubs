using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class SubtitleRepository(BCookieSubsDbContext db)
{
    public Task<List<Subtitle>> GetQueueAsync(int limit = 100, CancellationToken ct = default) =>
        db.Subtitles.AsNoTracking()
            .Include(s => s.SourceLanguage)
            .Include(s => s.User)
            .Where(s => s.Status == SubtitleStatus.Queued && s.DeletedAt == null)
            .OrderBy(s => s.Priority).ThenBy(s => s.CreatedAt)
            .Take(limit)
            .ToListAsync(ct);

    public Task<Subtitle?> GetAsync(long id, CancellationToken ct = default) =>
        db.Subtitles.FirstOrDefaultAsync(s => s.Id == id, ct);

    public Task<Subtitle?> GetWithMediaItemAsync(long id, CancellationToken ct = default) =>
        db.Subtitles.AsNoTracking()
            .Include(s => s.MediaItem)
            .FirstOrDefaultAsync(s => s.Id == id, ct);

    public Task<List<Subtitle>> GetFinishedAsync(int limit = 100, CancellationToken ct = default) =>
        db.Subtitles.AsNoTracking()
            .Include(s => s.SourceLanguage)
            .Where(s => s.Status == SubtitleStatus.Completed && s.DeletedAt == null && !s.Hide)
            .OrderByDescending(s => s.FinishedAt)
            .Take(limit)
            .ToListAsync(ct);

    public Task<bool> HashExistsAsync(string originalFileHash, CancellationToken ct = default) =>
        db.Subtitles.AnyAsync(s => s.OriginalFileHash == originalFileHash && s.DeletedAt == null, ct);


    public async Task<Subtitle?> GetNextWhisperSubtitleAsync(bool separateTask, CancellationToken ct = default)
    {
        var query = db.Subtitles.AsNoTracking()
            .Where(s => s.Source == SubtitleSourceKind.Whisper && s.DeletedAt == null &&
                        s.Status != SubtitleStatus.Cancelled && s.Status != SubtitleStatus.Failed &&
                        s.WhisperTranscriptionState != null &&
                        s.WhisperTranscriptionState != WhisperTranscriptionState.TranscriptionCompleted &&
                        s.WhisperTranscriptionState != WhisperTranscriptionState.TranscriptionFailed);
        if (separateTask)
        {
            return await query.OrderBy(s => s.WhisperPriority ?? int.MaxValue).ThenBy(s => s.Id)
                .FirstOrDefaultAsync(ct);
        }
        return await query.OrderBy(s => s.Priority).ThenBy(s => s.Id).FirstOrDefaultAsync(ct);
    }

    public async Task<int> NextWhisperOrderNumberAsync(CancellationToken ct = default)
    {
        var max = await db.Subtitles
            .Where(s => s.DeletedAt == null && s.Source == SubtitleSourceKind.Whisper)
            .MaxAsync(s => (int?)s.WhisperPriority, ct);
        return (max ?? 0) + 1;
    }

    public Task<Subtitle?> GetActiveWhisperSubtitleForMediaItemAsync(long mediaItemId, CancellationToken ct = default) =>
        db.Subtitles.AsNoTracking()
            .Where(s => s.MediaItemId == mediaItemId && s.Source == SubtitleSourceKind.Whisper &&
                        s.DeletedAt == null && s.Status != SubtitleStatus.Cancelled && s.Status != SubtitleStatus.Failed)
            .OrderByDescending(s => s.Id)
            .FirstOrDefaultAsync(ct);

    public Task SetWhisperTranscriptionStateAsync(long id, WhisperTranscriptionState? state, CancellationToken ct = default) =>
        db.Subtitles.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.WhisperTranscriptionState, state)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public Task SetWhisperProgressAsync(long id, int progress, long positionMs, long durationMs, CancellationToken ct = default) =>
        db.Subtitles.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.WhisperProgress, progress)
            .SetProperty(x => x.WhisperPositionMs, positionMs)
            .SetProperty(x => x.WhisperDurationMs, durationMs)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public Task ResetWhisperProgressAsync(long id, CancellationToken ct = default) =>
        db.Subtitles.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.WhisperProgress, 0)
            .SetProperty(x => x.WhisperPositionMs, 0L)
            .SetProperty(x => x.WhisperDurationMs, 0L)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public Task SaveWhisperCheckpointAsync(long id, string resumeSrt, long resumeMs, CancellationToken ct = default) =>
        db.Subtitles.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.WhisperResumeSrt, resumeSrt)
            .SetProperty(x => x.WhisperResumeMs, resumeMs)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public async Task AddAsync(Subtitle subtitle, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        subtitle.CreatedAt = now;
        subtitle.UpdatedAt = now;
        db.Subtitles.Add(subtitle);
        await db.SaveChangesAsync(ct);
    }

    public Task SetPriorityAsync(long id, int priority, CancellationToken ct = default) =>
        db.Subtitles.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.Priority, priority)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);

    public async Task SoftDeleteAsync(Subtitle subtitle, long deletedByUserId, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        subtitle.DeletedAt = now;
        subtitle.DeletedByUserId = deletedByUserId;
        await db.SaveChangesAsync(ct);
    }

    public sealed record SubtitleJobLangRow(long SubtitleId, long JobId, SubtitleJobStatus Status,
        long TargetLangId, string? LangName, string? LangFlag, string? LangIso);

    public sealed record SubtitleInfoRow(long LibraryPathItemId, long SubtitleId, bool Deleted, List<SubtitleJobLangRow> Jobs);

    public async Task<Dictionary<long, SubtitleInfoRow>> GetSubtitleInfoByItemIdsAsync(
        List<long> itemIds, CancellationToken ct = default)
    {
        if (itemIds.Count == 0) return [];

        var latest = await db.Subtitles.AsNoTracking()
            .Where(s => s.LibraryPathItemId != null && itemIds.Contains(s.LibraryPathItemId.Value))
            .GroupBy(s => s.LibraryPathItemId!.Value)
            .Select(g => new { ItemId = g.Key, SubtitleId = g.Max(s => s.Id) })
            .ToListAsync(ct);
        if (latest.Count == 0) return [];

        var subIds = latest.Select(l => l.SubtitleId).ToList();
        var subById = await db.Subtitles.AsNoTracking()
            .Where(s => subIds.Contains(s.Id))
            .Select(s => new { s.Id, s.LibraryPathItemId, s.DeletedAt })
            .ToDictionaryAsync(s => s.Id, ct);

        var activeSubIds = subById.Values.Where(s => s.DeletedAt == null).Select(s => s.Id).ToList();
        var jobRows = await db.SubtitleJobs.AsNoTracking()
            .Where(j => activeSubIds.Contains(j.SubtitleId) && j.DeletedAt == null)
            .OrderBy(j => j.Id)
            .Select(j => new SubtitleJobLangRow(
                j.SubtitleId, j.Id, j.Status, j.TargetLanguageId,
                j.TargetLanguage.Name, j.TargetLanguage.Flag, j.TargetLanguage.Iso639))
            .ToListAsync(ct);
        var jobsBySub = jobRows.GroupBy(j => j.SubtitleId).ToDictionary(g => g.Key, g => g.ToList());

        var result = new Dictionary<long, SubtitleInfoRow>();
        foreach (var l in latest)
        {
            var sub = subById[l.SubtitleId];
            var deleted = sub.DeletedAt != null;
            var jobs = deleted ? [] : jobsBySub.GetValueOrDefault(l.SubtitleId, []);
            result[l.ItemId] = new SubtitleInfoRow(l.ItemId, l.SubtitleId, deleted, jobs);
        }
        return result;
    }

    public async Task<Dictionary<long, WhisperTranscriptionState?>> GetWhisperStateByItemIdsAsync(
        List<long> itemIds, CancellationToken ct = default)
    {
        if (itemIds.Count == 0) return [];
        var rows = await db.Subtitles.AsNoTracking()
            .Where(s => s.LibraryPathItemId != null && itemIds.Contains(s.LibraryPathItemId.Value) &&
                        s.Source == SubtitleSourceKind.Whisper && s.DeletedAt == null &&
                        s.Status != SubtitleStatus.Cancelled && s.Status != SubtitleStatus.Failed)
            .OrderByDescending(s => s.Id)
            .Select(s => new { s.LibraryPathItemId, s.WhisperTranscriptionState })
            .ToListAsync(ct);
        var result = new Dictionary<long, WhisperTranscriptionState?>();
        foreach (var row in rows)
        {
            var itemId = row.LibraryPathItemId!.Value;
            if (!result.ContainsKey(itemId)) result[itemId] = row.WhisperTranscriptionState;
        }
        return result;
    }


    public sealed record DashboardTargetRow(
        long JobId, long TargetLangId, string JobStatus, int Total, int Done, int Failed, bool HasTranslation);

    public sealed record DashboardSubtitleRow(
        long Id, long UserId, long SourceLanguageId, long? MediaItemId, long? LibraryPathItemId,
        string Name, string OriginalFileName,
        int Priority, int? WhisperPriority,
        int OrderNumber, int? WhisperOrderNumber,
        string? Source, string? SourcePath, string? MediaPath,
        string Status, string? WhisperTranscriptionStatus,
        string? WhisperModel, int? WhisperTimestampsLength, bool? WhisperUseCuda, int WhisperProgress,
        int? Season, int? Episode, string? MediaItemTitle,
        DateTime? FinishedAt, DateTime CreatedAt, DateTime UpdatedAt,
        List<DashboardTargetRow> Targets);

    public async Task<List<DashboardSubtitleRow>> GetDashboardSubtitlesAsync(CancellationToken ct = default)
    {
        var subtitles = await db.Subtitles.AsNoTracking()
            .Where(s => s.DeletedAt == null && !s.Hide)
            .OrderBy(s => s.Priority).ThenByDescending(s => s.CreatedAt)
            .Select(DashboardSubtitleProjection)
            .ToListAsync(ct);

        var jobs = await db.SubtitleJobs.AsNoTracking()
            .Where(j => j.DeletedAt == null)
            .OrderBy(j => j.Priority).ThenBy(j => j.Id)
            .Select(DashboardJobProjection)
            .ToListAsync(ct);

        var jobIds = jobs.Select(j => j.Id).ToList();
        var countsByJob = await GetDashboardChunkCountsAsync(jobIds, ct);
        return BuildDashboardRows(subtitles, jobs, countsByJob);
    }

    public async Task<DashboardSubtitleRow?> GetDashboardSubtitleAsync(long id, CancellationToken ct = default)
    {
        var subtitle = await db.Subtitles.AsNoTracking()
            .Where(s => s.Id == id && s.DeletedAt == null && !s.Hide)
            .Select(DashboardSubtitleProjection)
            .FirstOrDefaultAsync(ct);
        if (subtitle == null) return null;

        var jobs = await db.SubtitleJobs.AsNoTracking()
            .Where(j => j.DeletedAt == null && j.SubtitleId == id)
            .OrderBy(j => j.Priority).ThenBy(j => j.Id)
            .Select(DashboardJobProjection)
            .ToListAsync(ct);
        var countsByJob = await GetDashboardChunkCountsAsync(jobs.Select(j => j.Id).ToList(), ct);
        return BuildDashboardRows([subtitle], jobs, countsByJob).FirstOrDefault();
    }

    public sealed record DashboardQueueCounts(
        int Queued, int Running, int Completed, int Failed, int Cancelled, int Paused, int Total);

    public async Task<DashboardQueueCounts> GetDashboardQueueCountsAsync(CancellationToken ct = default)
    {
        var rows = await db.Subtitles.AsNoTracking()
            .Where(s => s.DeletedAt == null && !s.Hide)
            .GroupBy(s => s.Status)
            .Select(g => new { Status = g.Key, Count = g.Count() })
            .ToListAsync(ct);
        var byStatus = rows.ToDictionary(r => r.Status, r => r.Count);
        int Of(SubtitleStatus s) => byStatus.GetValueOrDefault(s);
        var queued = Of(SubtitleStatus.Queued);
        var running = Of(SubtitleStatus.Running);
        var completed = Of(SubtitleStatus.Completed);
        var failed = Of(SubtitleStatus.Failed);
        var cancelled = Of(SubtitleStatus.Cancelled);
        var paused = Of(SubtitleStatus.Paused);
        return new DashboardQueueCounts(queued, running, completed, failed, cancelled, paused,
            queued + running + completed + failed + cancelled + paused);
    }

    private static readonly System.Linq.Expressions.Expression<Func<Subtitle, DashboardSubtitleSourceRow>> DashboardSubtitleProjection = s => new(
        s.Id, s.UserId, s.SourceLanguageId, s.MediaItemId, s.LibraryPathItemId,
        s.Name, s.OriginalFileName, s.Priority, s.WhisperPriority,
        s.Source, s.SourcePath, s.MediaPath, s.Status, s.WhisperTranscriptionState,
        s.WhisperModel, s.WhisperTimestampsLength, s.WhisperUseCuda, s.WhisperProgress,
        s.FinishedAt, s.CreatedAt, s.UpdatedAt,
        s.MediaItem != null ? s.MediaItem.Title : null);

    private static readonly System.Linq.Expressions.Expression<Func<SubtitleJob, DashboardJobRow>> DashboardJobProjection = j => new(
        j.Id, j.SubtitleId, j.TargetLanguageId, j.Status, j.Season, j.Episode,
        j.TranslatedText != null && j.TranslatedText.Trim() != "");

    private async Task<Dictionary<long, (int Total, int Done, int Failed)>> GetDashboardChunkCountsAsync(
        List<long> jobIds, CancellationToken ct)
    {
        var chunksForJobs = db.SubtitleChunks.AsNoTracking();
        chunksForJobs = jobIds.Count == 0
            ? chunksForJobs.Where(c => false)
            : chunksForJobs.Where(c => jobIds.Contains(c.SubtitleJobId));
        var chunkCounts = await chunksForJobs
            .GroupBy(c => c.SubtitleJobId)
            .Select(g => new
            {
                SubtitleJobId = g.Key,
                Total = g.Count(),
                Done = g.Count(c => c.Status == SubtitleChunkStatus.Completed),
                Failed = g.Count(c => c.Status == SubtitleChunkStatus.Failed),
            })
            .ToListAsync(ct);
        return chunkCounts.ToDictionary(c => c.SubtitleJobId, c => (c.Total, c.Done, c.Failed));
    }

    private static List<DashboardSubtitleRow> BuildDashboardRows(
        List<DashboardSubtitleSourceRow> subtitles, List<DashboardJobRow> jobs,
        Dictionary<long, (int Total, int Done, int Failed)> countsByJob)
    {
        var jobsBySubtitle = jobs.GroupBy(j => j.SubtitleId).ToDictionary(g => g.Key, g => g.ToList());
        var result = new List<DashboardSubtitleRow>(subtitles.Count);
        foreach (var s in subtitles)
        {
            var sJobs = jobsBySubtitle.GetValueOrDefault(s.Id, []);
            var firstJob = sJobs.FirstOrDefault();
            var targets = sJobs.Select(j =>
            {
                var counts = countsByJob.GetValueOrDefault(j.Id);
                return new DashboardTargetRow(
                    j.Id, j.TargetLanguageId, EnumText.Snake(j.Status),
                    counts.Total, counts.Done, counts.Failed, j.HasTranslation);
            }).ToList();
            result.Add(new DashboardSubtitleRow(
                s.Id, s.UserId, s.SourceLanguageId, s.MediaItemId, s.LibraryPathItemId,
                s.Name, s.OriginalFileName ?? "", s.Priority, s.WhisperPriority,
                s.Priority, s.WhisperPriority,
                s.Source == null ? null : EnumText.Snake(s.Source.Value), s.SourcePath, s.MediaPath,
                EnumText.Snake(s.Status), s.WhisperTranscriptionState == null
                    ? null
                    : EnumText.Snake(s.WhisperTranscriptionState.Value),
                s.WhisperModel, s.WhisperTimestampsLength, s.WhisperUseCuda, s.WhisperProgress,
                firstJob?.Season, firstJob?.Episode, s.MediaItemTitle,
                s.FinishedAt, s.CreatedAt, s.UpdatedAt, targets));
        }
        return result;
    }

    public sealed record DashboardSubtitleSourceRow(
        long Id, long UserId, long SourceLanguageId, long? MediaItemId, long? LibraryPathItemId,
        string Name, string? OriginalFileName, int Priority, int? WhisperPriority,
        SubtitleSourceKind? Source, string? SourcePath, string? MediaPath, SubtitleStatus Status,
        WhisperTranscriptionState? WhisperTranscriptionState, string? WhisperModel,
        int? WhisperTimestampsLength, bool? WhisperUseCuda, int WhisperProgress,
        DateTime? FinishedAt, DateTime CreatedAt, DateTime UpdatedAt, string? MediaItemTitle);

    public sealed record DashboardJobRow(
        long Id, long SubtitleId, long TargetLanguageId, SubtitleJobStatus Status,
        int? Season, int? Episode, bool HasTranslation);

    // ── Translated page (V7) ───────────────

    public sealed record FinishedSubtitleRow(
        long SubtitleId, long JobId, string SubtitleName, string TargetLang, string SourceLang,
        int? Season, int? Episode, string? MediaItemPhotoPath, int? Year,
        SubtitleJobStatus Status, DateTime? FinishedAt, DateTime? EarliestChunkStartedAt);

    public sealed record FinishedSubtitlesPage(
        List<FinishedSubtitleRow> Items, int Total, int Page, int TotalPages);

    public async Task<FinishedSubtitlesPage> GetFinishedJobsPageAsync(int page, int pageSize, CancellationToken ct = default)
    {
        pageSize = Math.Max(1, pageSize);
        var total = await db.SubtitleJobs.AsNoTracking()
            .CountAsync(j => (j.Status == SubtitleJobStatus.Completed || j.Status == SubtitleJobStatus.Failed) &&
                             j.DeletedAt == null, ct);

        var totalPages = Math.Max(1, (int)Math.Ceiling(total / (double)pageSize));
        var clamped = Math.Min(Math.Max(0, page), totalPages - 1);

        var items = await (from sj in db.SubtitleJobs.AsNoTracking()
                           join s in db.Subtitles.AsNoTracking() on sj.SubtitleId equals s.Id
                           join tl in db.Languages.AsNoTracking() on sj.TargetLanguageId equals tl.Id
                           join sl in db.Languages.AsNoTracking() on s.SourceLanguageId equals sl.Id
                           join m in db.MediaItems.AsNoTracking() on s.MediaItemId equals m.Id into media
                           from m in media.DefaultIfEmpty()
                           where (sj.Status == SubtitleJobStatus.Completed || sj.Status == SubtitleJobStatus.Failed) &&
                                 sj.DeletedAt == null
                           orderby (sj.FinishedAt ?? sj.UpdatedAt) descending, sj.Id descending
                           select new FinishedSubtitleRow(
                               s.Id, sj.Id, s.Name, tl.Name, sl.Name,
                               sj.Season, sj.Episode,
                               m != null ? m.PhotoPath : null, m != null ? m.Year : null,
                               sj.Status, sj.FinishedAt,
                               db.SubtitleChunks.Where(c => c.SubtitleJobId == sj.Id)
                                   .OrderBy(c => c.ChunkIndex)
                                   .Select(c => (DateTime?)c.StartedAt)
                                   .FirstOrDefault()))
            .Skip(clamped * pageSize).Take(pageSize)
            .ToListAsync(ct);

        return new FinishedSubtitlesPage(items, total, clamped, totalPages);
    }
}

public class SubtitleJobRepository(BCookieSubsDbContext db)
{
    public Task<SubtitleJob?> GetAsync(long id, CancellationToken ct = default) =>
        db.SubtitleJobs.FirstOrDefaultAsync(j => j.Id == id, ct);

    public Task<List<SubtitleJob>> GetBySubtitleAsync(long subtitleId, CancellationToken ct = default) =>
        db.SubtitleJobs.AsNoTracking()
            .Include(j => j.TargetLanguage)
            .Where(j => j.SubtitleId == subtitleId)
            .OrderBy(j => j.CreatedAt)
            .ToListAsync(ct);

    public Task<int> CountActiveAsync(long subtitleId, CancellationToken ct = default) =>
        db.SubtitleJobs.CountAsync(j =>
            j.SubtitleId == subtitleId &&
            (j.Status == SubtitleJobStatus.Queued || j.Status == SubtitleJobStatus.Running), ct);

    public async Task AddAsync(SubtitleJob job, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        job.CreatedAt = now;
        job.UpdatedAt = now;
        db.SubtitleJobs.Add(job);
        await db.SaveChangesAsync(ct);
    }

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);
}