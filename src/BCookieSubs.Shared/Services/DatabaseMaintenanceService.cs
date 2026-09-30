using System.Text.Json.Serialization;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public sealed record MaintenanceReport
{
    [JsonPropertyName("candidatesDeleted")]
    public long CandidatesDeleted { get; init; }

    [JsonPropertyName("judgeEvaluationsDeleted")]
    public long JudgeEvaluationsDeleted { get; init; }

    [JsonPropertyName("startedAt")]
    public DateTime StartedAt { get; init; }

    [JsonPropertyName("finishedAt")]
    public DateTime FinishedAt { get; init; }
}

public class DatabaseMaintenanceService(
    SubtitlePipelineRepository pipeline,
    JudgeEvaluationRepository judgeEvaluations)
{
    public async Task<MaintenanceReport> RunAsync(
        int candidateDays = 14, int judgeDays = 30, CancellationToken ct = default)
    {
        var started = DateTime.UtcNow;
        var candidates = await pipeline.CleanupExpiredCandidatesAsync(
            DateTime.UtcNow.AddDays(-candidateDays), ct: ct);
        var judges = await judgeEvaluations.PurgeOlderThanBatchedAsync(
            DateTime.UtcNow.AddDays(-judgeDays), ct: ct);
        return new MaintenanceReport
        {
            CandidatesDeleted = candidates,
            JudgeEvaluationsDeleted = judges,
            StartedAt = started,
            FinishedAt = DateTime.UtcNow,
        };
    }
}