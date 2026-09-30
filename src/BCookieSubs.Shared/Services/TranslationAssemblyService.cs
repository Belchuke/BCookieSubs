using System.Text.Json;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public class TranslationAssemblyService(
    BCookieSubsDbContext db,
    SubtitlePipelineRepository pipeline,
    ApplicationLogRepository logs,
    LibrarySubtitleExportService export,
    IDashboardEventPublisher dashboardEvents)
{
    private static readonly JsonSerializerOptions RowJson = new() { PropertyNameCaseInsensitive = true };
    public async Task<bool> CheckAndFinalizeJobAsync(SubtitleJob job, Subtitle subtitle, CancellationToken ct = default)
    {
        var allChunks = await pipeline.GetByJobAsync(job.Id, ct);
        var pending = allChunks.Count(c =>
            c.Status is SubtitleChunkStatus.Queued or SubtitleChunkStatus.Running
                or SubtitleChunkStatus.Retrying or SubtitleChunkStatus.WaitingForJudge);
        if (pending > 0) return false;

        var failed = allChunks.Count(c => c.Status == SubtitleChunkStatus.Failed);
        var target = failed > 0 ? SubtitleJobStatus.Failed : SubtitleJobStatus.Completed;
        if (!await pipeline.TryFinalizeJobAsync(job.Id, target, ct)) return false;

        if (target == SubtitleJobStatus.Failed)
        {
            await pipeline.UpdateJobStatusAsync(job.Id, SubtitleJobStatus.Failed, ct);
            await LogAsync(LogLevelKind.Error, "subtitleJobFailed", "subtitleJob", job.Id,
                $"Subtitle job {job.Id} failed: {failed}/{allChunks.Count} chunks could not be translated",
                new { subtitleId = job.SubtitleId, failedChunks = failed, totalChunks = allChunks.Count }, ct);
        }
        else
        {
            await AssembleAndFinishJobAsync(job, subtitle, ct);
        }

        if (subtitle.LibraryPathItemId != null)
        {
            try
            {
                await export.ExportSubtitleToLibraryFolderAsync(subtitle,
                    new ExportOptions { IncludeOriginal = false, IncludeTranslated = true, MarkCompleted = false }, ct);
            }
            catch (Exception)
            {
            }
        }

        await CheckAndFinalizeSubtitleAsync(subtitle, ct);
        dashboardEvents.TranslationChanged(job.SubtitleId);
        dashboardEvents.LibraryRequestsChanged();
        return true;
    }

    public async Task CheckAndFinalizeSubtitleAsync(Subtitle subtitle, CancellationToken ct = default)
    {
        var allJobs = await db.SubtitleJobs
            .AsNoTracking()
            .Where(j => j.SubtitleId == subtitle.Id)
            .ToListAsync(ct);
        if (allJobs.Any(j => j.Status is SubtitleJobStatus.Queued or SubtitleJobStatus.Running)) return;

        var failedJobs = allJobs.Count(j => j.Status == SubtitleJobStatus.Failed);
        var target = failedJobs > 0 ? SubtitleStatus.Failed : SubtitleStatus.Completed;
        if (!await pipeline.TryFinalizeSubtitleAsync(subtitle.Id, target, ct)) return;

        if (target == SubtitleStatus.Failed)
        {
            await LogAsync(LogLevelKind.Error, "subtitleCompleted", "subtitle", subtitle.Id,
                $"Subtitle \"{subtitle.Name}\" completed with failures: {failedJobs}/{allJobs.Count} target languages failed",
                new { name = subtitle.Name, failedJobs, totalJobs = allJobs.Count }, ct);
        }
        else
        {
            await LogAsync(LogLevelKind.Info, "subtitleCompleted", "subtitle", subtitle.Id,
                $"Subtitle \"{subtitle.Name}\" fully translated to {allJobs.Count} target language{(allJobs.Count == 1 ? "" : "s")}",
                new { name = subtitle.Name, jobs = allJobs.Count }, ct);
        }

        if (subtitle.LibraryPathItemId != null)
        {
            try
            {
                await export.ExportSubtitleToLibraryFolderAsync(subtitle,
                    new ExportOptions { IncludeOriginal = true, IncludeTranslated = true, MarkCompleted = true }, ct);
            }
            catch (Exception)
            {
            }
        }
    }

    public async Task AssembleAndFinishJobAsync(SubtitleJob job, Subtitle subtitle, CancellationToken ct = default)
    {
        var candidateRows = await pipeline.GetSelectedCandidatesForJobAsync(job.Id, ct);
        var allRows = new List<TranslatedRow>();

        foreach (var row in candidateRows)
        {
            if (string.IsNullOrEmpty(row.TranslatedText)) continue;
            List<TranslatedRow>? rows = null;
            try
            {
                rows = JsonSerializer.Deserialize<List<TranslatedRow>>(row.TranslatedText, RowJson);
            }
            catch (JsonException)
            {
                var parsed = Trcnk.ParseLLMResponse(row.TranslatedText);
                if (parsed != null)
                    rows = parsed.Rows.Select(r => new TranslatedRow(r.Id, r.Text)).ToList();
            }
            if (rows == null) continue;
            allRows.AddRange(rows);
        }

        var translatedText = SubtitleAdapter.SerializeSubtitle(subtitle.OriginalText, allRows, subtitle.SourceFormat);
        var outputHash = translatedText.Length > 0 ? Trcnk.GetFileHash(translatedText) : null;

        await pipeline.UpdateJobAssembledAsync(job.Id, translatedText.Length > 0 ? translatedText : null, outputHash, ct);
        await LogAsync(LogLevelKind.Info, "subtitleJobCompleted", "subtitleJob", job.Id,
            "Subtitle job completed", new { targetLangId = job.TargetLanguageId }, ct);
    }

    private async Task LogAsync(LogLevelKind level, string type, string entityType, long entityId,
        string message, object? metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new ApplicationLog
            {
                Level = level,
                Type = type,
                EntityType = entityType,
                EntityId = entityId,
                Message = message,
                Metadata = metadata is null ? null : JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            }, ct);
        }
        catch (Exception)
        {
        }
    }
}