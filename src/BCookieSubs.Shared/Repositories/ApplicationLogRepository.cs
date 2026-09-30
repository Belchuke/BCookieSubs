using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class ApplicationLogRepository(BCookieSubsDbContext db)
{
    public Task<List<ApplicationLog>> GetRecentAsync(int limit = 100, int offset = 0, CancellationToken ct = default) =>
        db.ApplicationLogs.AsNoTracking()
            .OrderByDescending(l => l.CreatedAt).ThenByDescending(l => l.Id)
            .Skip(offset).Take(limit)
            .ToListAsync(ct);

    public Task<ApplicationLog?> GetAsync(long id, CancellationToken ct = default) =>
        db.ApplicationLogs.AsNoTracking().FirstOrDefaultAsync(l => l.Id == id, ct);


    public sealed record LogPage(List<ApplicationLog> Logs, int Total);

    public async Task<LogPage> GetPagedAsync(
        int skip, int limit, LogLevelKind? level, string? type, string? search, CancellationToken ct = default)
    {
        var query = FilterAsync(level, type, search);
        var total = await query.CountAsync(ct);
        var logs = await query
            .OrderByDescending(l => l.CreatedAt)
            .Skip(skip).Take(limit)
            .ToListAsync(ct);
        return new LogPage(logs, total);
    }

    public Task<List<string>> GetTypesAsync(CancellationToken ct = default) =>
        db.ApplicationLogs.AsNoTracking()
            .Where(l => l.Type != null)
            .Select(l => l.Type!)
            .Distinct()
            .OrderBy(t => t)
            .ToListAsync(ct);

    public Task<List<ApplicationLog>> GetForExportAsync(
        LogLevelKind? level, string? type, DateTime? from, DateTime? to, string? search, CancellationToken ct = default)
    {
        var query = FilterAsync(level, type, search);
        if (from != null) query = query.Where(l => l.CreatedAt >= from);
        if (to != null) query = query.Where(l => l.CreatedAt <= to);
        return query.OrderBy(l => l.CreatedAt).ToListAsync(ct);
    }

    private IQueryable<ApplicationLog> FilterAsync(LogLevelKind? level, string? type, string? search)
    {
        var query = db.ApplicationLogs.AsNoTracking().AsQueryable();
        if (level != null) query = query.Where(l => l.Level == level);
        if (!string.IsNullOrEmpty(type)) query = query.Where(l => l.Type == type);
        var term = search?.Trim();
        if (!string.IsNullOrEmpty(term))
        {
            var like = $"%{term}%";
            query = query.Where(l =>
                EF.Functions.ILike(l.Message, like) ||
                (l.Type != null && EF.Functions.ILike(l.Type, like)) ||
                (l.EntityType != null && EF.Functions.ILike(l.EntityType, like)));
        }
        return query;
    }

    public async Task AddAsync(ApplicationLog entry, CancellationToken ct = default)
    {
        entry.CreatedAt = DateTime.UtcNow;
        db.ApplicationLogs.Add(entry);
        await db.SaveChangesAsync(ct);
    }

    public async Task AddRangeAsync(IEnumerable<ApplicationLog> entries, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var logs = entries.ToList();
        foreach (var log in logs)
        {
            log.CreatedAt = now;
        }
        db.ApplicationLogs.AddRange(logs);
        await db.SaveChangesAsync(ct);
    }

    public Task<int> PurgeOlderThanAsync(DateTime cutoff, CancellationToken ct = default) =>
        db.ApplicationLogs.Where(l => l.CreatedAt < cutoff).ExecuteDeleteAsync(ct);
}