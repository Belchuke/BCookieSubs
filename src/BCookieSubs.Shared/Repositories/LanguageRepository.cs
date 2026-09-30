using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class LanguageRepository(BCookieSubsDbContext db)
{
    public Task<List<Language>> GetAllAsync(CancellationToken ct = default) =>
        db.Languages.AsNoTracking().OrderBy(l => l.Name).ToListAsync(ct);

    public Task<Language?> GetAsync(long id, CancellationToken ct = default) =>
        db.Languages.FirstOrDefaultAsync(l => l.Id == id, ct);

    public Task<Language?> GetByIso639Async(string iso639, CancellationToken ct = default) =>
        db.Languages.FirstOrDefaultAsync(l => l.Iso639 == iso639, ct);

    public Task<List<ConfigTranslationLanguage>> GetDefaultTranslationLanguagesAsync(CancellationToken ct = default) =>
        db.ConfigTranslationLanguages.AsNoTracking()
            .Include(c => c.Language)
            .OrderBy(c => c.Position).ThenBy(c => c.Id)
            .ToListAsync(ct);

    public Task<List<UserConfigTranslationLanguage>> GetUserTranslationLanguagesAsync(
        long userId, CancellationToken ct = default) =>
        db.UserConfigTranslationLanguages.AsNoTracking()
            .Include(c => c.Language)
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.Position).ThenBy(c => c.Id)
            .ToListAsync(ct);

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);


    public async Task<bool> AddConfigLanguageAsync(long languageId, CancellationToken ct = default)
    {
        if (await db.ConfigTranslationLanguages.AnyAsync(c => c.LanguageId == languageId, ct))
        {
            return false;
        }

        var max = await db.ConfigTranslationLanguages.MaxAsync(c => (int?)c.Position, ct) ?? 0;
        var now = DateTime.UtcNow;
        db.ConfigTranslationLanguages.Add(new ConfigTranslationLanguage
        {
            LanguageId = languageId,
            Position = max + 1,
            CreatedAt = now,
            UpdatedAt = now
        });
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task ReplaceConfigLanguagesAsync(List<long> languageIds, CancellationToken ct = default)
    {
        var existing = await db.ConfigTranslationLanguages.ToListAsync(ct);
        db.ConfigTranslationLanguages.RemoveRange(existing);

        var now = DateTime.UtcNow;
        for (var i = 0; i < languageIds.Count; i++)
        {
            db.ConfigTranslationLanguages.Add(new ConfigTranslationLanguage
            {
                LanguageId = languageIds[i],
                Position = i + 1,
                CreatedAt = now,
                UpdatedAt = now
            });
        }
        await db.SaveChangesAsync(ct);
    }

    public async Task<bool> RemoveConfigLanguageAsync(long languageId, CancellationToken ct = default)
    {
        var row = await db.ConfigTranslationLanguages.FirstOrDefaultAsync(c => c.LanguageId == languageId, ct);
        if (row is null)
        {
            return false;
        }

        db.ConfigTranslationLanguages.Remove(row);
        await db.SaveChangesAsync(ct);

        var remaining = await db.ConfigTranslationLanguages.OrderBy(c => c.Position).ToListAsync(ct);
        for (var i = 0; i < remaining.Count; i++)
        {
            remaining[i].Position = i + 1;
        }
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> MoveConfigLanguageAsync(long languageId, int direction, CancellationToken ct = default)
    {
        var ordered = await db.ConfigTranslationLanguages.OrderBy(c => c.Position).ToListAsync(ct);
        var index = ordered.FindIndex(c => c.LanguageId == languageId);
        if (index < 0)
        {
            return false;
        }

        var target = index + direction;
        if (target < 0 || target >= ordered.Count)
        {
            return false;
        }

        (ordered[index].Position, ordered[target].Position) = (ordered[target].Position, ordered[index].Position);
        ordered[index].UpdatedAt = DateTime.UtcNow;
        ordered[target].UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return true;
    }


    public async Task<bool> AddUserLanguageAsync(long userId, long languageId, CancellationToken ct = default)
    {
        if (await db.UserConfigTranslationLanguages.AnyAsync(u => u.UserId == userId && u.LanguageId == languageId, ct))
        {
            return false;
        }

        var max = await db.UserConfigTranslationLanguages
            .Where(u => u.UserId == userId)
            .MaxAsync(u => (int?)u.Position, ct) ?? 0;
        var now = DateTime.UtcNow;
        db.UserConfigTranslationLanguages.Add(new UserConfigTranslationLanguage
        {
            UserId = userId,
            LanguageId = languageId,
            Position = max + 1,
            CreatedAt = now,
            UpdatedAt = now
        });
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> RemoveUserLanguageAsync(long userId, long languageId, CancellationToken ct = default)
    {
        var row = await db.UserConfigTranslationLanguages
            .FirstOrDefaultAsync(u => u.UserId == userId && u.LanguageId == languageId, ct);
        if (row is null)
        {
            return false;
        }

        db.UserConfigTranslationLanguages.Remove(row);
        await db.SaveChangesAsync(ct);

        var remaining = await db.UserConfigTranslationLanguages
            .Where(u => u.UserId == userId)
            .OrderBy(u => u.Position)
            .ToListAsync(ct);
        for (var i = 0; i < remaining.Count; i++)
        {
            remaining[i].Position = i + 1;
        }
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> MoveUserLanguageAsync(long userId, long languageId, int direction, CancellationToken ct = default)
    {
        var ordered = await db.UserConfigTranslationLanguages
            .Where(u => u.UserId == userId)
            .OrderBy(u => u.Position)
            .ToListAsync(ct);
        var index = ordered.FindIndex(c => c.LanguageId == languageId);
        if (index < 0)
        {
            return false;
        }

        var target = index + direction;
        if (target < 0 || target >= ordered.Count)
        {
            return false;
        }

        (ordered[index].Position, ordered[target].Position) = (ordered[target].Position, ordered[index].Position);
        ordered[index].UpdatedAt = DateTime.UtcNow;
        ordered[target].UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task SyncUserLanguagesFromGlobalAsync(long userId, CancellationToken ct = default)
    {
        var globals = await db.ConfigTranslationLanguages.OrderBy(c => c.Position).ToListAsync(ct);
        var existing = await db.UserConfigTranslationLanguages.Where(u => u.UserId == userId).ToListAsync(ct);
        db.UserConfigTranslationLanguages.RemoveRange(existing);

        var now = DateTime.UtcNow;
        foreach (var g in globals)
        {
            db.UserConfigTranslationLanguages.Add(new UserConfigTranslationLanguage
            {
                UserId = userId,
                LanguageId = g.LanguageId,
                Position = g.Position,
                CreatedAt = now,
                UpdatedAt = now
            });
        }
        await db.SaveChangesAsync(ct);
    }
}