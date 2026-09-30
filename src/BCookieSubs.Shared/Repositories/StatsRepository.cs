using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class StatsRepository(BCookieSubsDbContext db)
{

    public sealed record PromptStatListRow(
        long Id, string PromptName, int PromptVersionId, string ModelName, string LanguageName,
        int RequestCount, int FailedCount, int SuccessCount, int SelectedCount,
        DateTime CreatedAt, DateTime UpdatedAt);

    public Task<List<PromptStatListRow>> GetAllPromptStatsAsync(CancellationToken ct = default) =>
        db.PromptStats.AsNoTracking()
            .Where(s => s.LanguageId != null)
            .OrderByDescending(s => s.SelectedCount)
            .Select(s => new PromptStatListRow(
                s.Id, s.PromptVersion.Prompt.Name, s.PromptVersion.Version, s.Model.Name, s.Language!.Name,
                s.RequestCount, s.FailedCount, s.SuccessCount, s.SelectedCount,
                s.CreatedAt, s.UpdatedAt))
            .ToListAsync(ct);


    public sealed record ModelStatRow(long Id, string Name, bool Active);

    public Task<List<ModelStatRow>> GetModelsStatsAsync(CancellationToken ct = default) =>
        db.Models.AsNoTracking()
            .Where(m => m.DeletedAt == null &&
                        (db.ModelRoles.Any(r => r.ModelId == m.Id && r.Role == ModelRoleKind.Translation) ||
                         db.SubtitleChunkCandidates.Any(c => c.ModelId == m.Id)))
            .OrderBy(m => m.Name)
            .Select(m => new ModelStatRow(m.Id, m.Name, m.Active))
            .ToListAsync(ct);


    public sealed record SubtitleWithLangRow(
        long Id, string DisplayName, string FileName, string SourceLangName,
        int? Season, int? Episode, DateTime CreatedAt);

    public async Task<List<SubtitleWithLangRow>> GetSubtitlesWithLangAsync(CancellationToken ct = default)
    {
        var rows = await db.Subtitles.AsNoTracking()
            .Where(s => s.DeletedAt == null &&
                        db.SubtitleChunks.Any(c => c.SubtitleId == s.Id && c.Status == SubtitleChunkStatus.Completed))
            .OrderByDescending(s => s.CreatedAt)
            .Select(s => new
            {
                s.Id,
                FileName = s.Name,
                s.SourceLanguage.Name,
                s.CreatedAt,
                MediaTitle = s.MediaItem != null ? s.MediaItem.Title : null,
                Season = db.SubtitleJobs.Where(j => j.SubtitleId == s.Id).Min(j => (int?)j.Season),
                Episode = db.SubtitleJobs.Where(j => j.SubtitleId == s.Id).Min(j => (int?)j.Episode),
            })
            .ToListAsync(ct);

        return rows.Select(r => new SubtitleWithLangRow(
            r.Id, r.MediaTitle ?? r.FileName, r.FileName, r.Name,
            r.Season, r.Episode, r.CreatedAt)).ToList();
    }


    public sealed record JobChunkStatRow(
        long Id, int ChunkIndex, string Status, string? JudgeReason, long? DurationMs, int RetryCount,
        int ValidCandidateCount, int TotalCandidateCount,
        string? SelectedModelName, string? SelectedPromptName, int? SelectedPromptVersion);

    public async Task<List<JobChunkStatRow>> GetJobChunkStatsDataAsync(long jobId, CancellationToken ct = default)
    {
        var rows = await db.SubtitleChunks.AsNoTracking()
            .Where(c => c.SubtitleJobId == jobId)
            .OrderBy(c => c.ChunkIndex)
            .Select(c => new
            {
                c.Id, c.ChunkIndex, c.Status, c.JudgeReason, c.DurationMs, c.RetryCount,
                ValidCandidateCount = db.SubtitleChunkCandidates.Count(x => x.SubtitleChunkId == c.Id &&
                                                                            x.Status == SubtitleChunkCandidateStatus.Completed),
                TotalCandidateCount = db.SubtitleChunkCandidates.Count(x => x.SubtitleChunkId == c.Id),
                SelectedModelName = c.SelectedCandidate != null && c.SelectedCandidate.Model != null
                    ? c.SelectedCandidate.Model.Name
                    : null,
                SelectedPromptName = c.SelectedCandidate != null && c.SelectedCandidate.PromptVersion != null
                    ? c.SelectedCandidate.PromptVersion.Prompt.Name
                    : null,
                SelectedPromptVersion = (int?)c.SelectedCandidate!.PromptVersion!.Version,
            })
            .ToListAsync(ct);

        return rows.Select(c => new JobChunkStatRow(
            c.Id, c.ChunkIndex, EnumText.Snake(c.Status), c.JudgeReason, c.DurationMs, c.RetryCount,
            c.ValidCandidateCount, c.TotalCandidateCount,
            c.SelectedModelName, c.SelectedPromptName, c.SelectedPromptVersion)).ToList();
    }


    public sealed record CandidateOverallRow(
        int TotalCandidates, int SuccessCount, int FailedCount, int SelectedCount, double? AvgDurationMs);

    public sealed record CandidatePromptRow(
        string PromptName, int TotalCandidates, int SelectedCount, double? AvgDurationMs);

    public sealed record CandidateLanguageRow(
        string LanguageName, int TotalCandidates, int SelectedCount, double? AvgDurationMs);

    public sealed record ModelCandidateStats(
        CandidateOverallRow Overall, List<CandidatePromptRow> ByPrompt, List<CandidateLanguageRow> ByLanguage);

    public async Task<ModelCandidateStats> GetModelCandidateStatsAsync(long modelId, CancellationToken ct = default)
    {
        var overall = await db.SubtitleChunkCandidates.AsNoTracking()
            .Where(c => c.ModelId == modelId)
            .GroupBy(_ => 1)
            .Select(g => new CandidateOverallRow(
                g.Count(),
                g.Count(c => c.Status == SubtitleChunkCandidateStatus.Completed),
                g.Count(c => c.Status == SubtitleChunkCandidateStatus.Failed ||
                             c.Status == SubtitleChunkCandidateStatus.ValidationFailed),
                g.Count(c => c.Selected),
                g.Where(c => c.DurationMs != null).Average(c => (double?)c.DurationMs!.Value)))
            .FirstOrDefaultAsync(ct)
            ?? new CandidateOverallRow(0, 0, 0, 0, null);

        var byPrompt = await db.SubtitleChunkCandidates.AsNoTracking()
            .Where(c => c.ModelId == modelId)
            .GroupBy(c => new { c.PromptId, PromptName = c.Prompt != null ? c.Prompt.Name : null })
            .OrderByDescending(g => g.Count(c => c.Selected))
            .Select(g => new CandidatePromptRow(
                g.Key.PromptName ?? "Unknown",
                g.Count(), g.Count(c => c.Selected),
                g.Average(c => (double?)c.DurationMs)))
            .ToListAsync(ct);

        var byLanguage = await db.SubtitleChunkCandidates.AsNoTracking()
            .Where(c => c.ModelId == modelId)
            .GroupBy(c => new { c.SubtitleChunk.TargetLanguageId, c.SubtitleChunk.TargetLanguage.Name })
            .OrderByDescending(g => g.Count(c => c.Selected))
            .Select(g => new CandidateLanguageRow(
                g.Key.Name,
                g.Count(), g.Count(c => c.Selected),
                g.Average(c => (double?)c.DurationMs)))
            .ToListAsync(ct);

        return new ModelCandidateStats(overall, byPrompt, byLanguage);
    }


    public sealed record JudgeEvalRow(
        long Id, long SubtitleChunkId, long? ModelId, string? ModelName,
        string JudgeInput, string? JudgeReason, string CreatedAt,
        int? ChunkIndex, string? SubtitleName, int? Season, int? Episode);

    public sealed record JudgeEvaluationsPage(List<JudgeEvalRow> Rows, int Total);

    public async Task<JudgeEvaluationsPage> GetJudgeEvaluationsAsync(
        long? modelId, int limit, int offset, CancellationToken ct = default)
    {
        var query = db.JudgeEvaluations.AsNoTracking().AsQueryable();
        if (modelId != null) query = query.Where(j => j.ModelId == modelId);

        var total = await query.CountAsync(ct);
        var rows = await query
            .OrderByDescending(j => j.CreatedAt)
            .Skip(offset).Take(limit)
            .Select(j => new
            {
                j.Id, j.SubtitleChunkId, j.ModelId,
                ModelName = j.Model != null ? j.Model.Name : null,
                JudgeInput = j.JudgeInput ?? "", j.JudgeReason, j.CreatedAt,
                ChunkIndex = (int?)j.SubtitleChunk.ChunkIndex,
                SubtitleName = j.SubtitleChunk.Subtitle.Name,
                Season = (int?)j.SubtitleChunk.SubtitleJob.Season,
                Episode = (int?)j.SubtitleChunk.SubtitleJob.Episode,
            })
            .ToListAsync(ct);

        // Timestamps use "YYYY-MM-DD HH:mm:ss"; the stats page splits on the space.
        return new JudgeEvaluationsPage(rows.Select(j => new JudgeEvalRow(
                j.Id, j.SubtitleChunkId, j.ModelId, j.ModelName,
                j.JudgeInput, j.JudgeReason,
                j.CreatedAt.ToString("yyyy-MM-dd HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture),
                j.ChunkIndex, j.SubtitleName, j.Season, j.Episode))
            .ToList(), total);
    }
}