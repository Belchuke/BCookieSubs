using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Security;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public readonly record struct RoleSummary(string Name, int Level);

public class PermissionService(BCookieSubsDbContext db)
{
    public async Task<HashSet<string>> GetEffectivePermissionsAsync(long userId, CancellationToken ct = default)
    {
        var values = await db.UserRoles
            .Where(ur => ur.UserId == userId)
            .Join(db.RoleClaims,
                ur => ur.RoleId,
                rc => rc.RoleId,
                (ur, rc) => new { rc.ClaimType, rc.ClaimValue })
            .Where(x => x.ClaimType == Permissions.ClaimType && x.ClaimValue != null)
            .Select(x => x.ClaimValue!)
            .ToListAsync(ct);
        return [.. values];
    }

    public async Task<List<RoleSummary>> GetRolesAsync(long userId, CancellationToken ct = default)
    {
        var rows = await db.UserRoles
            .Where(ur => ur.UserId == userId)
            .Join(db.Roles,
                ur => ur.RoleId,
                r => r.Id,
                (ur, r) => new { r.Name, r.Level })
            .OrderBy(x => x.Level)
            .ToListAsync(ct);
        return rows.Select(r => new RoleSummary(r.Name!, r.Level)).ToList();
    }

    public async Task<int> GetMaxRoleLevelAsync(long userId, CancellationToken ct = default)
    {
        var max = await db.UserRoles
            .Where(ur => ur.UserId == userId)
            .Join(db.Roles, ur => ur.RoleId, r => r.Id, (ur, r) => (int?)r.Level)
            .MaxAsync(ct);
        return max ?? 0;
    }
}