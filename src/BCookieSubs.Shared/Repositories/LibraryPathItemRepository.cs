using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class LibraryPathItemRepository(BCookieSubsDbContext db)
{
    public Task<LibraryPathItem?> GetAsync(long id, CancellationToken ct = default) =>
        db.LibraryPathItems.Include(i => i.MediaItem).FirstOrDefaultAsync(i => i.Id == id, ct);

    public Task<LibraryPathItem?> GetByPathAsync(long libraryPathId, string path, CancellationToken ct = default) =>
        db.LibraryPathItems.FirstOrDefaultAsync(i => i.LibraryPathId == libraryPathId && i.Path == path, ct);

    public Task<List<LibraryPathItem>> GetByLibraryPathAsync(
        long libraryPathId, int limit = 200, CancellationToken ct = default) =>
        db.LibraryPathItems.AsNoTracking()
            .Include(i => i.MediaItem)
            .Where(i => i.LibraryPathId == libraryPathId)
            .OrderBy(i => i.Season).ThenBy(i => i.Episode).ThenBy(i => i.Path)
            .Take(limit)
            .ToListAsync(ct);

    public Task<List<LibraryPathItem>> GetAllByLibraryPathAsync(long libraryPathId, CancellationToken ct = default) =>
        db.LibraryPathItems.AsNoTracking()
            .Include(i => i.MediaItem)
            .Where(i => i.LibraryPathId == libraryPathId)
            .ToListAsync(ct);

    public Task<List<LibraryPathItem>> GetByLibraryPathIdsAsync(List<long> libraryPathIds, CancellationToken ct = default) =>
        libraryPathIds.Count == 0
            ? Task.FromResult(new List<LibraryPathItem>())
            : db.LibraryPathItems.AsNoTracking()
                .Where(i => libraryPathIds.Contains(i.LibraryPathId))
                .OrderByDescending(i => i.CreatedAt)
                .ToListAsync(ct);

    public Task<List<LibraryPathItem>> GetByIdsAsync(List<long> ids, CancellationToken ct = default) =>
        ids.Count == 0
            ? Task.FromResult(new List<LibraryPathItem>())
            : db.LibraryPathItems.AsNoTracking()
                .Where(i => ids.Contains(i.Id))
                .ToListAsync(ct);

    public Task<int> CountByLibraryPathAsync(long libraryPathId, CancellationToken ct = default) =>
        db.LibraryPathItems.CountAsync(i => i.LibraryPathId == libraryPathId, ct);

    public Task<int> CountByStatusAsync(long libraryPathId, LibraryPathItemStatus status, CancellationToken ct = default) =>
        db.LibraryPathItems.CountAsync(i => i.LibraryPathId == libraryPathId && i.Status == status, ct);

    public async Task<LibraryPathItem?> CreateAsync(LibraryPathItem item, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        item.CreatedAt = now;
        item.UpdatedAt = now;
        db.LibraryPathItems.Add(item);
        try
        {
            await db.SaveChangesAsync(ct);
            return item;
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            db.Entry(item).State = EntityState.Detached;
            return null;
        }
    }

    public async Task DeleteAsync(LibraryPathItem item, CancellationToken ct = default)
    {
        db.LibraryPathItems.Remove(item);
        await db.SaveChangesAsync(ct);
    }

    public Task SetStatusAsync(long id, LibraryPathItemStatus status, CancellationToken ct = default) =>
        db.LibraryPathItems.Where(i => i.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(i => i.Status, status)
            .SetProperty(i => i.UpdatedAt, DateTime.UtcNow), ct);

    public async Task<LibraryPathItemBlacklist> UpsertBlacklistAsync(
        long itemId, long? userId, string? reason, CancellationToken ct = default)
    {
        var row = await db.LibraryPathItemBlacklist.FirstOrDefaultAsync(b => b.LibraryPathItemId == itemId, ct);
        var now = DateTime.UtcNow;
        if (row == null)
        {
            row = new LibraryPathItemBlacklist
            {
                LibraryPathItemId = itemId,
                BlacklistedByUserId = userId,
                Reason = reason,
                CreatedAt = now,
            };
            db.LibraryPathItemBlacklist.Add(row);
        }
        else
        {
            row.BlacklistedByUserId = userId;
            row.Reason = reason;
        }
        row.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        return row;
    }

    public Task<int> DeleteBlacklistAsync(long itemId, CancellationToken ct = default) =>
        db.LibraryPathItemBlacklist
            .Where(b => b.LibraryPathItemId == itemId)
            .ExecuteDeleteAsync(ct);

    public async Task AddCandidateAsync(long itemId, long mediaItemId, CancellationToken ct = default)
    {
        var exists = await db.LibraryPathItemCandidates
            .AnyAsync(c => c.LibraryPathItemId == itemId && c.MediaItemId == mediaItemId, ct);
        if (exists) return;
        var now = DateTime.UtcNow;
        db.LibraryPathItemCandidates.Add(new LibraryPathItemCandidate
        {
            LibraryPathItemId = itemId,
            MediaItemId = mediaItemId,
            CreatedAt = now,
            UpdatedAt = now,
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
        }
    }

    public Task ClearCandidatesAsync(long itemId, CancellationToken ct = default) =>
        db.LibraryPathItemCandidates
            .Where(c => c.LibraryPathItemId == itemId)
            .ExecuteDeleteAsync(ct);

    public Task<List<long>> GetCandidatesAsync(long itemId, CancellationToken ct = default) =>
        db.LibraryPathItemCandidates
            .Where(c => c.LibraryPathItemId == itemId)
            .OrderBy(c => c.Id)
            .Select(c => c.MediaItemId)
            .ToListAsync(ct);

    public async Task UpsertSubtitleSourcesAsync(
        long itemId,
        List<SubtitleSourceCandidate> sources,
        long fileMtimeMs,
        long fileSize,
        CancellationToken ct = default)
    {
        var row = await db.LibraryPathItemSubtitleSources.FirstOrDefaultAsync(s => s.LibraryPathItemId == itemId, ct);
        if (row == null)
        {
            row = new LibraryPathItemSubtitleSource
            {
                LibraryPathItemId = itemId,
            };
            db.LibraryPathItemSubtitleSources.Add(row);
        }
        row.Sources = sources;
        row.FileMtimeMs = fileMtimeMs;
        row.FileSize = fileSize;
        row.ScannedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public Task<LibraryPathItemSubtitleSource?> GetSubtitleSourcesAsync(long itemId, CancellationToken ct = default) =>
        db.LibraryPathItemSubtitleSources.AsNoTracking()
            .FirstOrDefaultAsync(s => s.LibraryPathItemId == itemId, ct);

    public async Task<Dictionary<long, LibraryPathItemSubtitleSource>> GetSubtitleSourcesByItemIdsAsync(
        List<long> itemIds, CancellationToken ct = default)
    {
        if (itemIds.Count == 0) return [];
        var rows = await db.LibraryPathItemSubtitleSources.AsNoTracking()
            .Where(s => itemIds.Contains(s.LibraryPathItemId))
            .ToListAsync(ct);
        return rows.ToDictionary(s => s.LibraryPathItemId);
    }

    public Task SetMediaItemAsync(long id, long? mediaItemId, CancellationToken ct = default) =>
        db.LibraryPathItems.Where(i => i.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(i => i.MediaItemId, mediaItemId)
            .SetProperty(i => i.UpdatedAt, DateTime.UtcNow), ct);

    public async Task DeleteSubtitleSourcesAsync(long itemId, CancellationToken ct = default) =>
        await db.LibraryPathItemSubtitleSources
            .Where(s => s.LibraryPathItemId == itemId)
            .ExecuteDeleteAsync(ct);

    public async Task AddAsync(LibraryPathItem item, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        item.CreatedAt = now;
        item.UpdatedAt = now;
        db.LibraryPathItems.Add(item);
        await db.SaveChangesAsync(ct);
    }

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);

    public sealed record OffsetMediaRow(
        long LpiId, long MediaItemId, string VideoPath, int? Season, int? Episode,
        string? Title, string? Type, int? Year);

    public Task<List<OffsetMediaRow>> GetLibraryMediaItemsForOffsetAsync(long libraryPathId, CancellationToken ct = default) =>
        (from lpi in db.LibraryPathItems.AsNoTracking()
         join mi in db.MediaItems.AsNoTracking() on lpi.MediaItemId equals mi.Id into media
         from mi in media.DefaultIfEmpty()
         where lpi.LibraryPathId == libraryPathId && lpi.MediaItemId != null
         orderby mi!.Title, lpi.Id
         select new OffsetMediaRow(
             lpi.Id, lpi.MediaItemId!.Value, lpi.Path, lpi.Season, lpi.Episode,
             mi!.Title, mi.Type.ToString(), mi.Year))
            .ToListAsync(ct);

    public sealed record CandidateViewRow(
        long LibraryPathItemId, long MediaItemId, string? Title, int? Year, string? PhotoPath, MediaKind? Type);

    public Task<List<CandidateViewRow>> GetCandidatesByItemIdsAsync(List<long> itemIds, CancellationToken ct = default) =>
        itemIds.Count == 0
            ? Task.FromResult(new List<CandidateViewRow>())
            : db.LibraryPathItemCandidates.AsNoTracking()
                .Where(c => itemIds.Contains(c.LibraryPathItemId))
                .OrderBy(c => c.Id)
                .Select(c => new CandidateViewRow(
                    c.LibraryPathItemId, c.MediaItemId,
                    c.MediaItem.Title, c.MediaItem.Year, c.MediaItem.PhotoPath, c.MediaItem.Type))
                .ToListAsync(ct);

    public Task<List<LibraryPathItemBlacklist>> GetBlacklistByItemIdsAsync(List<long> itemIds, CancellationToken ct = default) =>
        itemIds.Count == 0
            ? Task.FromResult(new List<LibraryPathItemBlacklist>())
            : db.LibraryPathItemBlacklist.AsNoTracking()
                .Where(b => itemIds.Contains(b.LibraryPathItemId))
                .ToListAsync(ct);

    public sealed record BlacklistViewRow(
        long Id, long LibraryPathItemId, string? Reason, DateTime CreatedAt,
        long LibraryPathId, string? LibraryPathName, string ItemPath, string ExtractFileName,
        int? Season, int? Episode, string? BlacklistedByUsername, string? MediaTitle, int? MediaYear);

    public Task<List<BlacklistViewRow>> GetAllBlacklistedAsync(CancellationToken ct = default) =>
        db.LibraryPathItemBlacklist.AsNoTracking()
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new BlacklistViewRow(
                b.Id, b.LibraryPathItemId, b.Reason, b.CreatedAt,
                b.LibraryPathItem.LibraryPathId, b.LibraryPathItem.LibraryPath.Name,
                b.LibraryPathItem.Path, b.LibraryPathItem.ExtractFileName,
                b.LibraryPathItem.Season, b.LibraryPathItem.Episode,
                b.BlacklistedByUser!.UserName,
                b.LibraryPathItem.MediaItem != null ? b.LibraryPathItem.MediaItem.Title : null,
                b.LibraryPathItem.MediaItem != null ? b.LibraryPathItem.MediaItem.Year : null))
            .ToListAsync(ct);
}