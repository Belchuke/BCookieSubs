using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class ThemeRepository(BCookieSubsDbContext db)
{
    public Task<List<Theme>> GetAllAsync(CancellationToken ct = default) =>
        db.Themes.AsNoTracking().OrderBy(t => t.Name).ToListAsync(ct);

    public Task<Theme?> GetAsync(long id, CancellationToken ct = default) =>
        db.Themes.FirstOrDefaultAsync(t => t.Id == id, ct);

    public Task<bool> NameExistsAsync(string name, CancellationToken ct = default) =>
        db.Themes.AnyAsync(t => t.Name == name, ct);

    public Task<Theme?> GetByNameAsync(string name, CancellationToken ct = default) =>
        db.Themes.FirstOrDefaultAsync(t => t.Name == name, ct);

    public Task<int> CountUsersUsingAsync(long themeId, CancellationToken ct = default) =>
        db.Users.Where(u => u.SelectedThemeId == themeId).CountAsync(ct);

    public async Task AddAsync(Theme theme, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        theme.CreatedAt = now;
        theme.UpdatedAt = now;
        db.Themes.Add(theme);
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateAsync(Theme theme, CancellationToken ct = default)
    {
        theme.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteAsync(Theme theme, CancellationToken ct = default)
    {
        db.Themes.Remove(theme);
        await db.SaveChangesAsync(ct);
    }
}