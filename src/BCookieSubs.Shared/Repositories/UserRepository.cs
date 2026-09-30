using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class UserRepository(BCookieSubsDbContext db)
{
    public record UserWithRoles(
        ApplicationUser User,
        List<(string Name, int Level)> Roles,
        string HighestRole,
        int HighestLevel);

    public async Task<List<ApplicationUser>> GetAllAsync(CancellationToken ct = default) =>
        await db.Users.AsNoTracking().Where(u => u.DeletedAt == null)
            .OrderBy(u => u.CreatedAt).ThenBy(u => u.Id).ToListAsync(ct);

    public Task<ApplicationUser?> GetAsync(long id, CancellationToken ct = default) =>
        db.Users.FirstOrDefaultAsync(u => u.Id == id && u.DeletedAt == null, ct);

    public Task<ApplicationUser?> GetHighestRoleUserAsync(CancellationToken ct = default) =>
        db.UserRoles
            .Join(db.Roles, ur => ur.RoleId, r => r.Id, (ur, r) => new { ur.UserId, r.Level })
            .Join(db.Users, x => x.UserId, u => u.Id, (x, u) => new { u, x.Level })
            .Where(x => x.u.DeletedAt == null)
            .OrderByDescending(x => x.Level)
            .Select(x => x.u)
            .FirstOrDefaultAsync(ct);

    public async Task<Dictionary<long, List<(long Id, string Name, int Level)>>> GetRolesByUserAsync(
        IEnumerable<long> userIds, CancellationToken ct = default)
    {
        var ids = userIds.ToList();
        var rows = await db.UserRoles
            .Where(ur => userIds.Contains(ur.UserId))
            .Join(db.Roles, ur => ur.RoleId, r => r.Id, (ur, r) => new { ur.UserId, RoleId = r.Id, r.Name, r.Level })
            .ToListAsync(ct);
        return rows.GroupBy(r => r.UserId).ToDictionary(
            g => g.Key,
            g => g.Select(r => (r.RoleId, r.Name!, r.Level)).OrderByDescending(r => r.Level).ToList());
    }

    public Task<int> CountOwnersAsync(CancellationToken ct = default) =>
        db.UserRoles
            .Join(db.Roles, ur => ur.RoleId, r => r.Id, (ur, r) => new { ur.UserId, r.Name })
            .Where(x => x.Name == "Owner")
            .Select(x => x.UserId)
            .Distinct()
            .CountAsync(ct);

    public Task<bool> UsernameTakenAsync(string userName, long? excludeId = null, CancellationToken ct = default) =>
        db.Users.AnyAsync(u =>
            u.NormalizedUserName == userName.ToUpperInvariant() && (excludeId == null || u.Id != excludeId), ct);

    public async Task SetPreferencesAsync(ApplicationUser user, CancellationToken ct = default)
    {
        await db.SaveChangesAsync(ct);
    }

    public async Task SetSelectedThemeAsync(long userId, long themeId, CancellationToken ct = default)
    {
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null)
        {
            return;
        }

        user.SelectedThemeId = themeId;
        await db.SaveChangesAsync(ct);
    }

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);
}