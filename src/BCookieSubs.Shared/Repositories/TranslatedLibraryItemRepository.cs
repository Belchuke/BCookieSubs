using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class TranslatedLibraryItemRepository(BCookieSubsDbContext db)
{
    public Task<List<TranslatedLibraryItem>> GetByItemAsync(long itemId, CancellationToken ct = default) =>
        db.TranslatedLibraryItems.AsNoTracking()
            .Include(t => t.Language)
            .Where(t => t.LibraryPathItemId == itemId)
            .ToListAsync(ct);

    public Task<List<TranslatedLibraryItem>> GetByLibraryPathAsync(long libraryPathId, CancellationToken ct = default) =>
        db.TranslatedLibraryItems.AsNoTracking()
            .Where(t => t.LibraryPathItem!.LibraryPathId == libraryPathId)
            .ToListAsync(ct);

    public Task<List<TranslatedLibraryItem>> GetByItemIdsAsync(List<long> itemIds, CancellationToken ct = default) =>
        itemIds.Count == 0
            ? Task.FromResult(new List<TranslatedLibraryItem>())
            : db.TranslatedLibraryItems.AsNoTracking()
                .Where(t => itemIds.Contains(t.LibraryPathItemId))
                .ToListAsync(ct);

    public async Task ReplaceForItemAsync(long itemId, List<TranslatedLibraryItem> rows, CancellationToken ct = default)
    {
        var existing = await db.TranslatedLibraryItems
            .Where(t => t.LibraryPathItemId == itemId)
            .ToListAsync(ct);
        db.TranslatedLibraryItems.RemoveRange(existing);
        await db.SaveChangesAsync(ct);
        foreach (var row in rows)
        {
            row.LibraryPathItemId = itemId;
            if (row.CreatedAt == default) row.CreatedAt = DateTime.UtcNow;
            row.UpdatedAt = DateTime.UtcNow;
            db.TranslatedLibraryItems.Add(row);
        }
        await db.SaveChangesAsync(ct);
    }
}