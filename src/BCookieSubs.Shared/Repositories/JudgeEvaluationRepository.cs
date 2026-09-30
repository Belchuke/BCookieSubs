using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class JudgeEvaluationRepository(BCookieSubsDbContext db)
{
    public Task<List<JudgeEvaluation>> GetByChunkAsync(long chunkId, CancellationToken ct = default) =>
        db.JudgeEvaluations.AsNoTracking()
            .Where(e => e.SubtitleChunkId == chunkId)
            .OrderBy(e => e.CreatedAt)
            .ToListAsync(ct);

    public async Task AddAsync(JudgeEvaluation evaluation, CancellationToken ct = default)
    {
        evaluation.CreatedAt = DateTime.UtcNow;
        db.JudgeEvaluations.Add(evaluation);
        await db.SaveChangesAsync(ct);
    }

    public Task<int> PurgeOlderThanAsync(DateTime cutoff, CancellationToken ct = default) =>
        db.JudgeEvaluations.Where(e => e.CreatedAt < cutoff).ExecuteDeleteAsync(ct);

    public async Task<long> PurgeOlderThanBatchedAsync(DateTime cutoff, int batchSize = 5000, CancellationToken ct = default)
    {
        var total = 0;
        int deleted;
        do
        {
            deleted = await db.Database.ExecuteSqlAsync($"""
                DELETE FROM judge_evaluations
                WHERE "Id" IN (
                    SELECT "Id" FROM judge_evaluations
                    WHERE "CreatedAt" < {cutoff}
                    ORDER BY "Id"
                    LIMIT {batchSize})
                """, ct);
            total += deleted;
        } while (deleted > 0);
        return total;
    }
}