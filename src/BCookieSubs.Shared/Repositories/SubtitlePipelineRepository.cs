using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace BCookieSubs.Shared.Repositories;

public class SubtitlePipelineRepository(BCookieSubsDbContext db)
{
    private const string ClaimGlobalSql = """
        SELECT claim.cid FROM subtitles AS s
        JOIN LATERAL (
          SELECT sj."Id" AS jid, sj."Priority" AS jp
          FROM subtitle_jobs AS sj
          WHERE sj."SubtitleId" = s."Id"
            AND sj."Status" NOT IN ($3, $4, $5)
        ) AS sj ON true
        JOIN LATERAL (
          SELECT sc."Id" AS cid, sc."ChunkIndex" AS ci
          FROM subtitle_chunks AS sc
          WHERE sc."SubtitleJobId" = sj.jid
            AND sc."Status" IN ($1, $2)
          ORDER BY sc."ChunkIndex", sc."Id"
          LIMIT 1
          FOR UPDATE OF sc SKIP LOCKED
        ) AS claim ON true
        WHERE s."Status" NOT IN ($6, $7, $8, $9)
          AND s."DeletedAt" IS NULL
        ORDER BY s."Priority", sj.jp, claim.ci, claim.cid
        LIMIT 1
        """;

    private const string ClaimFocusedSql = """
        SELECT sc."Id" FROM subtitle_chunks AS sc
        JOIN subtitle_jobs AS sj ON sc."SubtitleJobId" = sj."Id"
        WHERE sc."SubtitleId" = $1
          AND sc."Status" IN ($2, $3)
          AND sj."Status" NOT IN ($4, $5, $6)
        ORDER BY sj."Priority", sc."ChunkIndex", sc."Id"
        LIMIT 1
        FOR UPDATE OF sc SKIP LOCKED
        """;


    public async Task<SubtitleChunk?> ClaimNextChunkAsync(bool finishSingleSubtitleFirst, CancellationToken ct = default)
    {
        var queued = SubtitleChunkStatus.Queued.ToString();
        var retrying = SubtitleChunkStatus.Retrying.ToString();
        var jobDone = new object[]
        {
            SubtitleJobStatus.Cancelled.ToString(),
            SubtitleJobStatus.Completed.ToString(),
            SubtitleJobStatus.Failed.ToString(),
        };
        var subDone = new object[]
        {
            SubtitleStatus.Cancelled.ToString(),
            SubtitleStatus.Completed.ToString(),
            SubtitleStatus.Failed.ToString(),
            SubtitleStatus.Paused.ToString(),
        };

        var conn = (NpgsqlConnection)db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync(ct);
        await using var npgTx = await conn.BeginTransactionAsync(ct);
        await db.Database.UseTransactionAsync(npgTx, ct);

        long? chunkId = null;
        if (finishSingleSubtitleFirst)
        {
            var runningSubtitleId = await db.Subtitles
                .Where(s => s.Status == SubtitleStatus.Running && s.DeletedAt == null)
                .OrderBy(s => s.Priority)
                .Select(s => (long?)s.Id)
                .FirstOrDefaultAsync(ct);
            if (runningSubtitleId != null)
            {
                chunkId = await SelectClaimedChunkAsync(conn, npgTx, ClaimFocusedSql, ct,
                    runningSubtitleId.Value, queued, retrying, jobDone[0], jobDone[1], jobDone[2]);
            }
        }

        chunkId ??= await SelectClaimedChunkAsync(conn, npgTx, ClaimGlobalSql, ct,
            new[] { queued, retrying }.Concat(jobDone).Concat(subDone).ToArray());

        await db.Database.UseTransactionAsync(null, ct);
        if (chunkId == null)
        {
            await npgTx.RollbackAsync(ct);
            return null;
        }

        await MarkStartedAsync(chunkId.Value, ct);
        await npgTx.CommitAsync(ct);
        return await GetAsync(chunkId.Value, ct);
    }

    private static async Task<long?> SelectClaimedChunkAsync(
        NpgsqlConnection conn, NpgsqlTransaction tx, string sql, CancellationToken ct, params object[] args)
    {
        await using var cmd = new NpgsqlCommand(sql, conn, tx);
        foreach (var arg in args) cmd.Parameters.AddWithValue(arg);
        var result = await cmd.ExecuteScalarAsync(ct);
        return result is long id ? id : null;
    }

    private async Task MarkStartedAsync(long chunkId, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        await db.SubtitleChunks
            .Where(c => c.Id == chunkId)
            .ExecuteUpdateAsync(u => u
                .SetProperty(c => c.Status, SubtitleChunkStatus.Running)
                .SetProperty(c => c.StartedAt, now)
                .SetProperty(c => c.UpdatedAt, now), ct);
    }

    public Task<int> ResetStaleRunningChunksAsync(DateTime staleBefore, CancellationToken ct = default) =>
        db.SubtitleChunks
            .Where(c => c.Status == SubtitleChunkStatus.Running &&
                        c.StartedAt != null && c.StartedAt < staleBefore)
            .ExecuteUpdateAsync(u => u
                .SetProperty(c => c.Status, SubtitleChunkStatus.Queued)
                .SetProperty(c => c.StartedAt, (DateTime?)null)
                .SetProperty(c => c.UpdatedAt, DateTime.UtcNow), ct);

    public async Task ReleaseRunningChunksAsync(List<long> chunkIds, CancellationToken ct = default)
    {
        if (chunkIds.Count == 0) return;
        await db.SubtitleChunkCandidates
            .Where(c => chunkIds.Contains(c.SubtitleChunkId))
            .ExecuteDeleteAsync(ct);
        await db.SubtitleChunks
            .Where(c => chunkIds.Contains(c.Id) && c.Status == SubtitleChunkStatus.Running)
            .ExecuteUpdateAsync(u => u
                .SetProperty(c => c.Status, SubtitleChunkStatus.Queued)
                .SetProperty(c => c.StartedAt, (DateTime?)null)
                .SetProperty(c => c.UpdatedAt, DateTime.UtcNow), ct);
    }

    public Task<SubtitleChunk?> GetAsync(long id, CancellationToken ct = default) =>
        db.SubtitleChunks.FirstOrDefaultAsync(c => c.Id == id, ct);

    public Task<List<SubtitleChunk>> GetByJobAsync(long jobId, CancellationToken ct = default) =>
        db.SubtitleChunks.AsNoTracking()
            .Where(c => c.SubtitleJobId == jobId)
            .OrderBy(c => c.ChunkIndex)
            .ToListAsync(ct);

    public sealed record JobChunkRow(
        long Id, long SubtitleJobId, int ChunkIndex, int SrtIdFrom, int SrtIdTo,
        SubtitleChunkStatus Status, int RetryCount, string? JudgeReason, string? ErrorMessage,
        long? DurationMs, DateTime? StartedAt, DateTime? FinishedAt);

    public Task<List<JobChunkRow>> GetByJobsAsync(IReadOnlyCollection<long> jobIds, CancellationToken ct = default) =>
        db.SubtitleChunks.AsNoTracking()
            .Where(c => jobIds.Contains(c.SubtitleJobId))
            .OrderBy(c => c.SubtitleJobId).ThenBy(c => c.ChunkIndex)
            .Select(c => new JobChunkRow(
                c.Id, c.SubtitleJobId, c.ChunkIndex, c.SrtIdFrom, c.SrtIdTo,
                c.Status, c.RetryCount, c.JudgeReason, c.ErrorMessage,
                c.DurationMs, c.StartedAt, c.FinishedAt))
            .ToListAsync(ct);


    public Task MarkChunkFailedAsync(long chunkId, string errorMessage, CancellationToken ct = default) =>
        db.SubtitleChunks.Where(c => c.Id == chunkId).ExecuteUpdateAsync(u => u
            .SetProperty(c => c.Status, SubtitleChunkStatus.Failed)
            .SetProperty(c => c.ErrorMessage, errorMessage)
            .SetProperty(c => c.FinishedAt, DateTime.UtcNow)
            .SetProperty(c => c.UpdatedAt, DateTime.UtcNow), ct);

    public Task SetSelectedCandidateForChunkAsync(
        long chunkId, long candidateId, long? judgeModelId, string? judgeReason, long durationMs,
        CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        return db.SubtitleChunks.Where(c => c.Id == chunkId).ExecuteUpdateAsync(u => u
            .SetProperty(c => c.Status, SubtitleChunkStatus.Completed)
            .SetProperty(c => c.SelectedCandidateId, candidateId)
            .SetProperty(c => c.JudgeModelId, judgeModelId)
            .SetProperty(c => c.JudgeReason, judgeReason)
            .SetProperty(c => c.DurationMs, durationMs)
            .SetProperty(c => c.FinishedAt, now)
            .SetProperty(c => c.UpdatedAt, now), ct);
    }

    public Task MarkChunkCompletedNoCandidateAsync(long chunkId, string judgeReason, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        return db.SubtitleChunks.Where(c => c.Id == chunkId).ExecuteUpdateAsync(u => u
            .SetProperty(c => c.Status, SubtitleChunkStatus.Completed)
            .SetProperty(c => c.SelectedCandidateId, (long?)null)
            .SetProperty(c => c.JudgeReason, judgeReason)
            .SetProperty(c => c.FinishedAt, now)
            .SetProperty(c => c.UpdatedAt, now), ct);
    }


    public async Task<long> CreateOrUpdateCandidateAsync(
        long chunkId, long modelId, long promptId, long promptVersionId,
        string? translatedText, bool validationPassed,
        SubtitleChunkCandidateStatus status, long durationMs, string? errorMessage,
        CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var conn = (NpgsqlConnection)db.Database.GetDbConnection();
        if (conn.State != System.Data.ConnectionState.Open) await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand("""
            INSERT INTO "subtitle_chunk_candidates"
              ("SubtitleChunkId", "ModelId", "PromptId", "PromptVersionId", "TranslatedText",
               "ValidationPassed", "Status", "Selected", "RetryCount", "DurationMs", "ErrorMessage",
               "CreatedAt", "UpdatedAt")
            VALUES (@chunk, @model, @prompt, @version, @text, @passed, @status, false, 0,
                    @duration, @error, @now, @now)
            ON CONFLICT ("SubtitleChunkId", "ModelId", "PromptVersionId") DO UPDATE SET
              "PromptId" = EXCLUDED."PromptId",
              "TranslatedText" = EXCLUDED."TranslatedText",
              "ValidationPassed" = EXCLUDED."ValidationPassed",
              "Status" = EXCLUDED."Status",
              "DurationMs" = EXCLUDED."DurationMs",
              "ErrorMessage" = EXCLUDED."ErrorMessage",
              "RetryCount" = "subtitle_chunk_candidates"."RetryCount" + 1,
              "UpdatedAt" = EXCLUDED."UpdatedAt"
            RETURNING "Id";
            """, conn);

        cmd.Parameters.AddWithValue("chunk", chunkId);
        cmd.Parameters.AddWithValue("model", modelId);
        cmd.Parameters.AddWithValue("prompt", promptId);
        cmd.Parameters.AddWithValue("version", promptVersionId);
        cmd.Parameters.AddWithValue("text", (object?)translatedText ?? DBNull.Value);
        cmd.Parameters.AddWithValue("passed", validationPassed);
        cmd.Parameters.AddWithValue("status", status.ToString());
        cmd.Parameters.AddWithValue("duration", durationMs);
        cmd.Parameters.AddWithValue("error", (object?)errorMessage ?? DBNull.Value);
        cmd.Parameters.AddWithValue("now", now);

        var result = await cmd.ExecuteScalarAsync(ct);
        return (long)result!;
    }

    public Task<SubtitleChunkCandidate?> GetCandidateAsync(long id, CancellationToken ct = default) =>
        db.SubtitleChunkCandidates.FirstOrDefaultAsync(c => c.Id == id, ct);

    public Task<int> DeleteUnneededCandidatesAsync(long chunkId, CancellationToken ct = default) =>
        db.SubtitleChunkCandidates
            .Where(c => c.SubtitleChunkId == chunkId &&
                        !c.Selected &&
                        c.Status != SubtitleChunkCandidateStatus.Failed &&
                        c.Status != SubtitleChunkCandidateStatus.ValidationFailed)
            .ExecuteDeleteAsync(ct);

    public Task MarkCandidateSelectedAsync(long candidateId, CancellationToken ct = default) =>
        db.SubtitleChunkCandidates.Where(c => c.Id == candidateId).ExecuteUpdateAsync(u => u
            .SetProperty(c => c.Selected, true)
            .SetProperty(c => c.Status, SubtitleChunkCandidateStatus.Completed)
            .SetProperty(c => c.UpdatedAt, DateTime.UtcNow), ct);


    public Task<int> CountCompletedChunksAsync(long jobId, CancellationToken ct = default) =>
        db.SubtitleChunks.CountAsync(c => c.SubtitleJobId == jobId && c.Status == SubtitleChunkStatus.Completed, ct);

    public Task<int> CountPendingChunksAsync(long jobId, CancellationToken ct = default) =>
        db.SubtitleChunks.CountAsync(c => c.SubtitleJobId == jobId && (
            c.Status == SubtitleChunkStatus.Queued ||
            c.Status == SubtitleChunkStatus.Running ||
            c.Status == SubtitleChunkStatus.Retrying ||
            c.Status == SubtitleChunkStatus.WaitingForJudge), ct);

    public Task UpdateJobProgressAsync(long jobId, int chunkCurrent, CancellationToken ct = default) =>
        db.SubtitleJobs.Where(j => j.Id == jobId).ExecuteUpdateAsync(j => j
            .SetProperty(x => x.CurrentChunk, chunkCurrent)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public async Task UpdateSubtitleStatusAsync(long subtitleId, SubtitleStatus status, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, status)
            .SetProperty(x => x.UpdatedAt, now), ct);
        if (status == SubtitleStatus.Completed)
            await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.FinishedAt, now), ct);
        if (status == SubtitleStatus.Cancelled)
            await db.Subtitles.Where(s => s.Id == subtitleId).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.CancelledAt, now), ct);
    }

    public async Task UpdateJobStatusAsync(long jobId, SubtitleJobStatus status, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        await db.SubtitleJobs.Where(j => j.Id == jobId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, status)
            .SetProperty(x => x.UpdatedAt, now), ct);
        if (status == SubtitleJobStatus.Completed)
            await db.SubtitleJobs.Where(j => j.Id == jobId).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.FinishedAt, now), ct);
    }

    public Task UpdateJobAssembledAsync(long jobId, string? translatedText, string? outputHash,
        CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        return db.SubtitleJobs.Where(j => j.Id == jobId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, SubtitleJobStatus.Completed)
            .SetProperty(x => x.TranslatedText, translatedText)
            .SetProperty(x => x.OutputHash, outputHash)
            .SetProperty(x => x.FinishedAt, now)
            .SetProperty(x => x.UpdatedAt, now), ct);
    }

    public async Task<bool> TryFinalizeJobAsync(long jobId, SubtitleJobStatus target, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var rows = await db.SubtitleJobs
            .Where(j => j.Id == jobId &&
                        j.Status != SubtitleJobStatus.Completed &&
                        j.Status != SubtitleJobStatus.Cancelled &&
                        j.Status != SubtitleJobStatus.Failed)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, target)
                .SetProperty(x => x.FinishedAt, target == SubtitleJobStatus.Completed ? (DateTime?)now : null)
                .SetProperty(x => x.UpdatedAt, now), ct);
        return rows != 0;
    }

    public async Task<bool> TryFinalizeSubtitleAsync(long subtitleId, SubtitleStatus target, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var rows = await db.Subtitles
            .Where(s => s.Id == subtitleId &&
                        s.Status != SubtitleStatus.Completed &&
                        s.Status != SubtitleStatus.Cancelled)
            .ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, target)
                .SetProperty(x => x.FinishedAt, target == SubtitleStatus.Completed ? (DateTime?)now : null)
                .SetProperty(x => x.CancelledAt, target == SubtitleStatus.Cancelled ? (DateTime?)now : null)
                .SetProperty(x => x.UpdatedAt, now), ct);
        return rows != 0;
    }


    public sealed record CandidateRow(long ChunkIndex, long CandidateId, string? TranslatedText);

    public async Task<List<CandidateRow>> GetSelectedCandidatesForJobAsync(long jobId, CancellationToken ct = default)
    {
        var rows = await db.SubtitleChunks.AsNoTracking()
            .Where(c => c.SubtitleJobId == jobId && c.SelectedCandidateId != null)
            .OrderBy(c => c.ChunkIndex)
            .Select(c => new { c.ChunkIndex, c.SelectedCandidateId })
            .ToListAsync(ct);

        var candidateIds = rows.Select(r => r.SelectedCandidateId!.Value).ToList();
        var texts = await db.SubtitleChunkCandidates.AsNoTracking()
            .Where(c => candidateIds.Contains(c.Id))
            .Select(c => new { c.Id, c.TranslatedText })
            .ToDictionaryAsync(c => c.Id, c => c.TranslatedText, ct);

        return rows
            .Select(r => new CandidateRow(r.ChunkIndex, r.SelectedCandidateId!.Value,
                texts.GetValueOrDefault(r.SelectedCandidateId!.Value)))
            .ToList();
    }


    public async Task ResetChunkAsync(long chunkId, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        var chunk = await db.SubtitleChunks.FirstOrDefaultAsync(c => c.Id == chunkId, ct);
        if (chunk == null)
        {
            await tx.RollbackAsync(ct);
            return;
        }

        await db.SubtitleChunkCandidates
            .Where(c => c.SubtitleChunkId == chunkId)
            .ExecuteDeleteAsync(ct);

        var now = DateTime.UtcNow;
        await db.SubtitleChunks.Where(c => c.Id == chunkId).ExecuteUpdateAsync(u => u
            .SetProperty(c => c.Status, SubtitleChunkStatus.Queued)
            .SetProperty(c => c.RetryCount, 0)
            .SetProperty(c => c.StartedAt, (DateTime?)null)
            .SetProperty(c => c.FinishedAt, (DateTime?)null)
            .SetProperty(c => c.ErrorMessage, (string?)null)
            .SetProperty(c => c.SelectedCandidateId, (long?)null)
            .SetProperty(c => c.UpdatedAt, now), ct);

        var job = await db.SubtitleJobs.FirstOrDefaultAsync(j => j.Id == chunk.SubtitleJobId, ct);
        if (job is { Status: SubtitleJobStatus.Completed or SubtitleJobStatus.Failed or SubtitleJobStatus.Cancelled })
        {
            var completedChunks = await db.SubtitleChunks
                .CountAsync(c => c.SubtitleJobId == job.Id && c.Status == SubtitleChunkStatus.Completed, ct);
            await db.SubtitleJobs.Where(j => j.Id == job.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleJobStatus.Queued)
                .SetProperty(x => x.CurrentChunk, completedChunks)
                .SetProperty(x => x.TranslatedText, (string?)null)
                .SetProperty(x => x.OutputFilePath, (string?)null)
                .SetProperty(x => x.OutputHash, (string?)null)
                .SetProperty(x => x.FinishedAt, (DateTime?)null)
                .SetProperty(x => x.CancelledAt, (DateTime?)null)
                .SetProperty(x => x.UpdatedAt, now), ct);
        }

        var sub = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == chunk.SubtitleId, ct);
        if (sub is { Status: SubtitleStatus.Completed or SubtitleStatus.Failed or SubtitleStatus.Cancelled })
        {
            await db.Subtitles.Where(s => s.Id == sub.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleStatus.Queued)
                .SetProperty(x => x.FinishedAt, (DateTime?)null)
                .SetProperty(x => x.CancelledAt, (DateTime?)null)
                .SetProperty(x => x.UpdatedAt, now), ct);
        }

        await tx.CommitAsync(ct);
    }

    public async Task<bool> RetryFailedChunkAsync(long chunkId, CancellationToken ct = default)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        var chunk = await db.SubtitleChunks.FirstOrDefaultAsync(c => c.Id == chunkId, ct);
        if (chunk == null || chunk.Status != SubtitleChunkStatus.Failed)
        {
            await tx.RollbackAsync(ct);
            return false;
        }

        var now = DateTime.UtcNow;
        await db.SubtitleChunkCandidates
            .Where(c => c.SubtitleChunkId == chunkId)
            .ExecuteDeleteAsync(ct);
        await db.SubtitleChunks.Where(c => c.Id == chunkId).ExecuteUpdateAsync(u => u
            .SetProperty(c => c.RetryCount, 0)
            .SetProperty(c => c.ErrorMessage, (string?)null)
            .SetProperty(c => c.Status, SubtitleChunkStatus.Queued)
            .SetProperty(c => c.SelectedCandidateId, (long?)null)
            .SetProperty(c => c.StartedAt, (DateTime?)null)
            .SetProperty(c => c.FinishedAt, (DateTime?)null)
            .SetProperty(c => c.UpdatedAt, now), ct);

        var job = await db.SubtitleJobs.FirstOrDefaultAsync(j => j.Id == chunk.SubtitleJobId, ct);
        if (job is { Status: SubtitleJobStatus.Completed or SubtitleJobStatus.Failed or SubtitleJobStatus.Cancelled })
        {
            var completedChunks = await db.SubtitleChunks
                .CountAsync(c => c.SubtitleJobId == job.Id && c.Status == SubtitleChunkStatus.Completed, ct);
            await db.SubtitleJobs.Where(j => j.Id == job.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleJobStatus.Queued)
                .SetProperty(x => x.CurrentChunk, completedChunks)
                .SetProperty(x => x.TranslatedText, (string?)null)
                .SetProperty(x => x.OutputHash, (string?)null)
                .SetProperty(x => x.FinishedAt, (DateTime?)null)
                .SetProperty(x => x.UpdatedAt, now), ct);
        }

        var sub = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == chunk.SubtitleId, ct);
        if (sub is { Status: SubtitleStatus.Completed or SubtitleStatus.Failed or SubtitleStatus.Cancelled })
        {
            await db.Subtitles.Where(s => s.Id == sub.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, SubtitleStatus.Queued)
                .SetProperty(x => x.FinishedAt, (DateTime?)null)
                .SetProperty(x => x.UpdatedAt, now), ct);
        }

        await tx.CommitAsync(ct);
        return true;
    }

    public async Task IncrementChunkRetryAsync(long chunkId, string? errorMessage, CancellationToken ct = default)
    {
        await db.SubtitleChunkCandidates
            .Where(c => c.SubtitleChunkId == chunkId)
            .ExecuteDeleteAsync(ct);
        await db.SubtitleChunks.Where(c => c.Id == chunkId).ExecuteUpdateAsync(u => u
            .SetProperty(c => c.RetryCount, c => c.RetryCount + 1)
            .SetProperty(c => c.ErrorMessage, errorMessage)
            .SetProperty(c => c.Status, SubtitleChunkStatus.Retrying)
            .SetProperty(c => c.SelectedCandidateId, (long?)null)
            .SetProperty(c => c.UpdatedAt, DateTime.UtcNow), ct);
    }

    public async Task<long> CleanupExpiredCandidatesAsync(DateTime cutoff, int batchSize = 5000, CancellationToken ct = default)
    {
        var total = 0;
        int deleted;
        do
        {
            deleted = await db.Database.ExecuteSqlAsync($"""
                DELETE FROM subtitle_chunk_candidates
                WHERE "Id" IN (
                    SELECT "Id" FROM subtitle_chunk_candidates
                    WHERE "Selected" = false
                      AND "Status" = {SubtitleChunkCandidateStatus.Completed.ToString()}
                      AND "UpdatedAt" < {cutoff}
                    ORDER BY "Id"
                    LIMIT {batchSize})
                """, ct);
            total += deleted;
        } while (deleted > 0);
        return total;
    }
}