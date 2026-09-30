using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class LibraryPathRepository(BCookieSubsDbContext db)
{
    public Task<List<LibraryPath>> GetAllAsync(CancellationToken ct = default) =>
        db.LibraryPaths.AsNoTracking()
            .Include(lp => lp.SourceLanguage)
            .OrderBy(lp => lp.Name)
            .ToListAsync(ct);

    public Task<List<LibraryPath>> GetByTypeAsync(LibraryPathType type, CancellationToken ct = default) =>
        db.LibraryPaths.AsNoTracking()
            .Where(lp => lp.Type == type)
            .OrderBy(lp => lp.Name)
            .ToListAsync(ct);

    public Task<LibraryPath?> GetAsync(long id, CancellationToken ct = default) =>
        db.LibraryPaths.FirstOrDefaultAsync(lp => lp.Id == id, ct);

    public Task<List<LibraryPath>> GetWithFilesystemPathAsync(CancellationToken ct = default) =>
        db.LibraryPaths.AsNoTracking()
            .Where(lp => lp.Path != null)
            .ToListAsync(ct);

    public Task<bool> PathExistsAsync(string path, CancellationToken ct = default) =>
        db.LibraryPaths.AnyAsync(lp => lp.Path == path, ct);

    public Task<bool> NameExistsAsync(string name, long excludeId, CancellationToken ct = default) =>
        db.LibraryPaths.AnyAsync(lp => lp.Name == name && lp.Id != excludeId, ct);

    public Task UpdateEditableFieldsAsync(long id, LibraryPath lp, CancellationToken ct = default) =>
        db.LibraryPaths.Where(x => x.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.Name, lp.Name)
            .SetProperty(x => x.Path, lp.Path)
            .SetProperty(x => x.SourceLanguageId, lp.SourceLanguageId)
            .SetProperty(x => x.Type, lp.Type)
            .SetProperty(x => x.Enabled, lp.Enabled)
            .SetProperty(x => x.AutoTranslate, lp.AutoTranslate)
            .SetProperty(x => x.AutoExtract, lp.AutoExtract)
            .SetProperty(x => x.Storage, lp.Storage)
            .SetProperty(x => x.SftpHost, lp.SftpHost)
            .SetProperty(x => x.SftpPort, lp.SftpPort)
            .SetProperty(x => x.SftpUsername, lp.SftpUsername)
            .SetProperty(x => x.SftpAuthMode, lp.SftpAuthMode)
            .SetProperty(x => x.SftpHostKeyFingerprint, lp.SftpHostKeyFingerprint)
            .SetProperty(x => x.ScanMode, lp.ScanMode)
            .SetProperty(x => x.ScanRepeatInterval, lp.ScanRepeatInterval)
            .SetProperty(x => x.ScanRepeatUnit, lp.ScanRepeatUnit)
            .SetProperty(x => x.ScanDayOfWeek, lp.ScanDayOfWeek)
            .SetProperty(x => x.ScanStartTime, lp.ScanStartTime)
            .SetProperty(x => x.ScanDurationMinutes, lp.ScanDurationMinutes)
            .SetProperty(x => x.ScanFirstStartAt, lp.ScanFirstStartAt)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public Task SetEnabledAsync(long id, bool enabled, CancellationToken ct = default) =>
        db.LibraryPaths.Where(lp => lp.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(lp => lp.Enabled, enabled)
            .SetProperty(lp => lp.UpdatedAt, DateTime.UtcNow), ct);

    public async Task AddAsync(LibraryPath libraryPath, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        libraryPath.CreatedAt = now;
        libraryPath.UpdatedAt = now;
        db.LibraryPaths.Add(libraryPath);
        await db.SaveChangesAsync(ct);
    }

    public Task SetStateAsync(long id, LibraryPathState state, CancellationToken ct = default) =>
        db.LibraryPaths.Where(lp => lp.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(lp => lp.State, state)
            .SetProperty(lp => lp.UpdatedAt, DateTime.UtcNow), ct);

    public async Task<bool> TryClaimScanAsync(long id, CancellationToken ct = default)
    {
        var rows = await db.LibraryPaths
            .Where(lp => lp.Id == id && lp.State != LibraryPathState.Scanning)
            .ExecuteUpdateAsync(s => s
                .SetProperty(lp => lp.State, LibraryPathState.Scanning)
                .SetProperty(lp => lp.LastRunAt, DateTime.UtcNow)
                .SetProperty(lp => lp.UpdatedAt, DateTime.UtcNow), ct);
        return rows != 0;
    }

    public Task<List<LibraryPath>> GetEnabledNotScanningAsync(CancellationToken ct = default) =>
        db.LibraryPaths.AsNoTracking()
            .Include(lp => lp.SourceLanguage)
            .Where(lp => lp.Enabled && lp.State != LibraryPathState.Scanning)
            .OrderBy(lp => lp.Id)
            .ToListAsync(ct);

    public Task<List<LibraryPath>> GetStuckScanningAsync(DateTime cutoff, CancellationToken ct = default) =>
        db.LibraryPaths
            .Where(lp => lp.State == LibraryPathState.Scanning && lp.UpdatedAt < cutoff)
            .ToListAsync(ct);

    public Task TouchScanHeartbeatAsync(long id, CancellationToken ct = default) =>
        db.LibraryPaths.Where(lp => lp.Id == id).ExecuteUpdateAsync(
            s => s.SetProperty(lp => lp.UpdatedAt, DateTime.UtcNow), ct);

    public async Task RecordScanDurationAsync(long id, long durationMs, bool wasInitial, CancellationToken ct = default)
    {
        var lp = await db.LibraryPaths.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (lp == null) return;
        lp.LastScanDurationMs = durationMs;
        if (wasInitial)
        {
            lp.InitialScanDurationMs = durationMs;
        }
        else
        {
            lp.PostInitialScanCount++;
            lp.PostInitialScanTotalMs += durationMs;
        }
        lp.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public Task ResetForRescanAsync(long id, CancellationToken ct = default) =>
        db.LibraryPaths.Where(lp => lp.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(lp => lp.State, LibraryPathState.Idle)
            .SetProperty(lp => lp.LastRunAt, (DateTime?)null)
            .SetProperty(lp => lp.UpdatedAt, DateTime.UtcNow), ct);

    public Task SetInitialScanCompletedAsync(long id, CancellationToken ct = default) =>
        db.LibraryPaths.Where(lp => lp.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(lp => lp.InitialScanCompleted, true)
            .SetProperty(lp => lp.UpdatedAt, DateTime.UtcNow), ct);

    public async Task DeleteAsync(LibraryPath libraryPath, CancellationToken ct = default)
    {
        db.LibraryPaths.Remove(libraryPath);
        await db.SaveChangesAsync(ct);
    }
}