using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class MediaItemRepository(BCookieSubsDbContext db)
{
    public Task<MediaItem?> GetAsync(long id, CancellationToken ct = default) =>
        db.MediaItems.FirstOrDefaultAsync(m => m.Id == id, ct);

    public Task<List<MediaItem>> GetByIdsAsync(List<long> ids, CancellationToken ct = default) =>
        ids.Count == 0
            ? Task.FromResult(new List<MediaItem>())
            : db.MediaItems.AsNoTracking().Where(m => ids.Contains(m.Id)).ToListAsync(ct);

    public Task<string?> GetPhotoPathAsync(long id, CancellationToken ct = default) =>
        db.MediaItems.AsNoTracking().Where(m => m.Id == id).Select(m => m.PhotoPath).FirstOrDefaultAsync(ct);

    public Task SetPhotoPathAsync(long id, string photoPath, CancellationToken ct = default) =>
        db.MediaItems.Where(m => m.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(m => m.PhotoPath, photoPath)
            .SetProperty(m => m.UpdatedAt, DateTime.UtcNow), ct);

    public Task<List<MediaItem>> SearchByTitleAsync(string title, int limit = 20, CancellationToken ct = default) =>
        db.MediaItems.AsNoTracking()
            .Where(m => EF.Functions.ILike(m.Title, $"{title}%"))
            .OrderBy(m => m.Title)
            .Take(limit)
            .ToListAsync(ct);

    public Task<MediaItem?> GetByTheMovieDbIdAsync(string theMovieDbId, CancellationToken ct = default) =>
        db.MediaItems.FirstOrDefaultAsync(m => m.TheMovieDbId == theMovieDbId, ct);

    public async Task<MediaItem?> GetByKeysAsync(
        string? theMovieDbId, string title, MediaKind type, int? year, CancellationToken ct = default)
    {
        if (!string.IsNullOrEmpty(theMovieDbId))
        {
            var byTmdbId = await db.MediaItems
                .FirstOrDefaultAsync(m => m.TheMovieDbId == theMovieDbId, ct);
            if (byTmdbId != null) return byTmdbId;
        }
        return await db.MediaItems
            .Where(m => m.Title == title && m.Type == type && m.Year == year)
            .OrderByDescending(m => m.CreatedAt)
            .FirstOrDefaultAsync(ct);
    }

    public Task<MediaItem?> FindSeriesReusableAsync(string title, CancellationToken ct = default) =>
        db.MediaItems
            .Where(m => m.Title == title && m.Type == Database.Enums.MediaKind.Series &&
                        m.TheMovieDbId != null && m.TheMovieDbId != "")
            .OrderByDescending(m => m.CreatedAt)
            .FirstOrDefaultAsync(ct);

    public async Task AddAsync(MediaItem item, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        item.CreatedAt = now;
        item.UpdatedAt = now;
        db.MediaItems.Add(item);
        await db.SaveChangesAsync(ct);
    }

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);
}