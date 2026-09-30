using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class SubtitleChunkRepository(BCookieSubsDbContext db)
{
    public Task<List<SubtitleChunk>> GetByJobAsync(long jobId, CancellationToken ct = default) =>
        db.SubtitleChunks.AsNoTracking()
            .Where(c => c.SubtitleJobId == jobId)
            .OrderBy(c => c.ChunkIndex)
            .ToListAsync(ct);

    public Task<List<SubtitleChunk>> GetPendingByJobAsync(long jobId, CancellationToken ct = default) =>
        db.SubtitleChunks.AsNoTracking()
            .Where(c => c.SubtitleJobId == jobId && c.Status != SubtitleChunkStatus.Completed)
            .OrderBy(c => c.ChunkIndex)
            .ToListAsync(ct);

    public Task<SubtitleChunk?> GetAsync(long id, CancellationToken ct = default) =>
        db.SubtitleChunks.FirstOrDefaultAsync(c => c.Id == id, ct);

    public async Task<SubtitleChunkCandidate> GetOrCreateCandidateAsync(
        long chunkId, long? modelId, long? promptId, long? promptVersionId, CancellationToken ct = default)
    {
        var candidate = await db.SubtitleChunkCandidates.FirstOrDefaultAsync(c =>
            c.SubtitleChunkId == chunkId &&
            c.ModelId == modelId &&
            c.PromptVersionId == promptVersionId, ct);
        if (candidate is not null)
        {
            return candidate;
        }

        var now = DateTime.UtcNow;
        candidate = new SubtitleChunkCandidate
        {
            SubtitleChunkId = chunkId,
            ModelId = modelId,
            PromptId = promptId,
            PromptVersionId = promptVersionId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.SubtitleChunkCandidates.Add(candidate);
        await db.SaveChangesAsync(ct);
        return candidate;
    }

    public Task<List<SubtitleChunkCandidate>> GetCandidatesAsync(long chunkId, CancellationToken ct = default) =>
        db.SubtitleChunkCandidates.AsNoTracking()
            .Where(c => c.SubtitleChunkId == chunkId)
            .OrderBy(c => c.Id)
            .ToListAsync(ct);

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);
}