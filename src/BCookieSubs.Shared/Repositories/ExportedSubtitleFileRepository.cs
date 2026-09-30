using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class ExportedSubtitleFileRepository(BCookieSubsDbContext db)
{
    public Task<ExportedSubtitleFile?> GetByPathAsync(long libraryPathId, string path, CancellationToken ct = default) =>
        db.ExportedSubtitleFiles.AsNoTracking()
            .FirstOrDefaultAsync(f => f.LibraryPathId == libraryPathId && f.Path == path, ct);

    public Task<List<ExportedSubtitleFile>> GetByLibraryPathAsync(long libraryPathId, CancellationToken ct = default) =>
        db.ExportedSubtitleFiles.AsNoTracking()
            .Where(f => f.LibraryPathId == libraryPathId)
            .ToListAsync(ct);

    public async Task UpsertAsync(ExportedSubtitleFile file, CancellationToken ct = default)
    {
        var existing = await db.ExportedSubtitleFiles
            .FirstOrDefaultAsync(f => f.LibraryPathId == file.LibraryPathId && f.Path == file.Path, ct);
        var now = DateTime.UtcNow;
        if (existing == null)
        {
            file.CreatedAt = now;
            file.UpdatedAt = now;
            db.ExportedSubtitleFiles.Add(file);
        }
        else
        {
            existing.SubtitleId = file.SubtitleId;
            existing.IsWhisper = file.IsWhisper;
            existing.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteAsync(ExportedSubtitleFile file, CancellationToken ct = default)
    {
        db.ExportedSubtitleFiles.Remove(file);
        await db.SaveChangesAsync(ct);
    }
}