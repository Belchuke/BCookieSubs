using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class PromptRepository(BCookieSubsDbContext db)
{
    public Task<List<Prompt>> GetAllAsync(CancellationToken ct = default) =>
        db.Prompts.AsNoTracking().OrderBy(p => p.Name).ToListAsync(ct);

    public Task<List<Prompt>> GetActiveByKindAsync(PromptKind kind, CancellationToken ct = default) =>
        db.Prompts.AsNoTracking()
            .Where(p => p.Kind == kind && p.Active)
            .OrderBy(p => p.Name)
            .ToListAsync(ct);

    public Task<List<PromptVersion>> GetVersionsAsync(long promptId, CancellationToken ct = default) =>
        db.PromptVersions.AsNoTracking()
            .Where(v => v.PromptId == promptId && v.DeletedAt == null)
            .OrderByDescending(v => v.Version)
            .ToListAsync(ct);

    public Task<PromptVersion?> GetActiveVersionAsync(long promptId, CancellationToken ct = default) =>
        db.PromptVersions
            .Where(v => v.PromptId == promptId && v.Active && v.DeletedAt == null)
            .OrderByDescending(v => v.Version)
            .FirstOrDefaultAsync(ct);

    public Task<PromptVersion?> GetActiveVersionByKindAsync(PromptKind kind, CancellationToken ct = default) =>
        db.PromptVersions.AsNoTracking()
            .Where(v => v.Active && v.DeletedAt == null && v.Prompt.Active && v.Prompt.Kind == kind)
            .OrderBy(v => v.Id)
            .FirstOrDefaultAsync(ct);

    public Task<List<PromptVersion>> GetActiveVersionsByKindAsync(PromptKind kind, CancellationToken ct = default) =>
        db.PromptVersions.AsNoTracking()
            .Where(v => v.Active && v.DeletedAt == null && v.Prompt.Active && v.Prompt.Kind == kind)
            .OrderBy(v => v.Id)
            .ToListAsync(ct);

    public async Task CreateOrUpdatePromptStatAsync(
        long promptId, long promptVersionId, long modelId, long? languageId,
        bool requestUp, bool failedUp, bool successUp, bool selectedUp, CancellationToken ct = default)
    {
        var stat = await db.PromptStats.FirstOrDefaultAsync(s =>
            s.PromptId == promptId && s.PromptVersionId == promptVersionId &&
            s.ModelId == modelId && s.LanguageId == languageId, ct);

        if (stat == null)
        {
            var now = DateTime.UtcNow;
            stat = new PromptStat
            {
                PromptId = promptId,
                PromptVersionId = promptVersionId,
                ModelId = modelId,
                LanguageId = languageId,
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.PromptStats.Add(stat);
            await db.SaveChangesAsync(ct);
        }

        stat.RequestCount += requestUp ? 1 : 0;
        stat.FailedCount += failedUp ? 1 : 0;
        stat.SuccessCount += successUp ? 1 : 0;
        stat.SelectedCount += selectedUp ? 1 : 0;
        stat.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public Task<PromptVersion?> GetActiveVersionByPromptNameAsync(string name, CancellationToken ct = default) =>
        db.PromptVersions.AsNoTracking()
            .Where(v => v.Active && v.DeletedAt == null && v.Prompt.Active && v.Prompt.Name == name)
            .OrderBy(v => v.Id)
            .FirstOrDefaultAsync(ct);

    public Task<Prompt?> GetByNameAsync(string name, CancellationToken ct = default) =>
        db.Prompts.FirstOrDefaultAsync(p => p.Name == name, ct);

    public async Task AddAsync(Prompt prompt, PromptVersion version, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        prompt.CreatedAt = now;
        prompt.UpdatedAt = now;
        version.CreatedAt = now;
        db.Prompts.Add(prompt);
        db.PromptVersions.Add(version);
        await db.SaveChangesAsync(ct);
    }

    public Task<Prompt?> GetTrackedAsync(long id, CancellationToken ct = default) =>
        db.Prompts.FirstOrDefaultAsync(p => p.Id == id, ct);

    public Task<Prompt?> GetNoTrackingAsync(long id, CancellationToken ct = default) =>
        db.Prompts.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct);

    public Task<PromptVersion?> GetVersionAsync(long promptId, int version, CancellationToken ct = default) =>
        db.PromptVersions.FirstOrDefaultAsync(v => v.PromptId == promptId && v.Version == version, ct);

    public Task<PromptVersion?> GetVersionByIdAsync(long promptId, long versionId, CancellationToken ct = default) =>
        db.PromptVersions.FirstOrDefaultAsync(v => v.PromptId == promptId && v.Id == versionId, ct);

    public async Task<int> GetMaxVersionAsync(long promptId, CancellationToken ct = default) =>
        await db.PromptVersions.Where(v => v.PromptId == promptId).MaxAsync(v => (int?)v.Version, ct) ?? 0;

    public Task<List<PromptVersion>> GetActiveVersionsTrackedAsync(long promptId, CancellationToken ct = default) =>
        db.PromptVersions.Where(v => v.PromptId == promptId && v.Active && v.DeletedAt == null).ToListAsync(ct);

    public async Task AddVersionAsync(PromptVersion version, CancellationToken ct = default)
    {
        version.CreatedAt = DateTime.UtcNow;
        db.PromptVersions.Add(version);
        await db.SaveChangesAsync(ct);
    }

    public Task<List<PromptStatRow>> GetStatsAsync(long promptId, CancellationToken ct = default) =>
        db.PromptStats.AsNoTracking()
            .Where(s => s.PromptId == promptId)
            .Select(s => new PromptStatRow(
                s.PromptVersion.Version,
                s.Model.ModelName,
                s.Language != null ? s.Language.Name : null,
                s.RequestCount, s.SuccessCount, s.FailedCount, s.SelectedCount,
                s.UpdatedAt))
            .ToListAsync(ct);

    public record PromptStatRow(
        int Version, string ModelName, string? LanguageName,
        int Requests, int Successes, int Failures, int Selected, DateTime UpdatedAt);

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);
}