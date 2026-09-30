using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public record RoleListItem(
    long Id, string Name, int Level, string? Description, List<string> Permissions, int UserCount, bool IsBuiltIn);

public class RoleManagementService(
    RoleManager<ApplicationRole> roles,
    UserManager<ApplicationUser> users,
    BCookieSubsDbContext db,
    AuditService audit)
{
    public static readonly IReadOnlyList<string> BuiltInRoles =
        RoleCatalog.Definitions.Select(d => d.Name).ToList();

    public async Task<List<RoleListItem>> GetListAsync(CancellationToken ct = default)
    {
        var roleRows = await roles.Roles.AsNoTracking()
            .OrderByDescending(r => r.Level)
            .ToListAsync(ct);
        var claims = await db.RoleClaims
            .Where(rc => rc.ClaimType == Permissions.ClaimType)
            .ToListAsync(ct);
        var counts = await db.UserRoles
            .GroupBy(ur => ur.RoleId)
            .Select(g => new { RoleId = g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.RoleId, g => g.Count, ct);

        return roleRows.Select(r => new RoleListItem(
            r.Id,
            r.Name!,
            r.Level,
            r.Description,
            claims.Where(c => c.RoleId == r.Id).Select(c => c.ClaimValue!).OrderBy(k => k).ToList(),
            counts.GetValueOrDefault(r.Id, 0),
            BuiltInRoles.Contains(r.Name!))).ToList();
    }

    public record RoleEdit(
        long Id, string Name, int Level, string? Description, List<string> Permissions, bool IsBuiltIn);

    public async Task<RoleEdit?> GetForEditAsync(long roleId, CancellationToken ct = default)
    {
        var role = await roles.FindByIdAsync(roleId.ToString());
        if (role is null)
        {
            return null;
        }

        var claims = await db.RoleClaims
            .Where(rc => rc.RoleId == roleId && rc.ClaimType == Permissions.ClaimType)
            .Select(rc => rc.ClaimValue!)
            .ToListAsync(ct);
        return new RoleEdit(role.Id, role.Name!, role.Level, role.Description, claims, BuiltInRoles.Contains(role.Name!));
    }

    public async Task<(bool Ok, string? Error)> CreateAsync(
        int actorLevel, string name, int level, string? description, IReadOnlyList<string> permissionKeys,
        CancellationToken ct = default)
    {
        if (level > actorLevel)
        {
            return (false, "Cannot create a role above your own level");
        }

        if (level < 1)
        {
            return (false, "Level must be at least 1");
        }

        var conflict = await roles.Roles.AnyAsync(
            r => r.Name == name || r.Level == level, ct);
        if (conflict)
        {
            return (false, "A role with that name or level already exists");
        }

        var unknown = permissionKeys.Where(k => !Permissions.All.Contains(k)).ToList();
        if (unknown.Count > 0)
        {
            return (false, $"Unknown permissions: {string.Join(", ", unknown)}");
        }

        var role = new ApplicationRole
        {
            Name = name.Trim(),
            NormalizedName = name.Trim().ToUpperInvariant(),
            Level = level,
            Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim(),
            CreatedAt = DateTime.UtcNow,
            ConcurrencyStamp = Guid.NewGuid().ToString()
        };
        var result = await roles.CreateAsync(role);
        if (!result.Succeeded)
        {
            return (false, string.Join("; ", result.Errors.Select(e => e.Description)));
        }

        foreach (var key in permissionKeys.Distinct())
        {
            db.RoleClaims.Add(new IdentityRoleClaim<long>
            {
                RoleId = role.Id,
                ClaimType = Permissions.ClaimType,
                ClaimValue = key
            });
        }

        await db.SaveChangesAsync(ct);
        await audit.AdminActionAsync("roleCreated", "role", role.Id,
            $"Created role: {role.Name} (level {level})");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> UpdateAsync(
        long roleId, int actorLevel, string name, int level, string? description,
        IReadOnlyList<string> permissionKeys,
        CancellationToken ct = default)
    {
        var role = await roles.FindByIdAsync(roleId.ToString());
        if (role is null)
        {
            return (false, "Role not found");
        }

        if (role.Name == UserManagementService.OwnerRoleName)
        {
            return (false, "The Owner role cannot be edited");
        }

        if (role.Level > actorLevel)
        {
            return (false, "Cannot edit a role above your own level");
        }

        if (level > actorLevel)
        {
            return (false, "Cannot set a role level above your own");
        }

        if (level < 1)
        {
            return (false, "Level must be at least 1");
        }

        var conflict = await roles.Roles.AnyAsync(
            r => (r.Name == name || r.Level == level) && r.Id != roleId, ct);
        if (conflict)
        {
            return (false, "Another role with that name or level already exists");
        }

        var unknown = permissionKeys.Where(k => !Permissions.All.Contains(k)).ToList();
        if (unknown.Count > 0)
        {
            return (false, $"Unknown permissions: {string.Join(", ", unknown)}");
        }

        var existingClaims = await db.RoleClaims
            .Where(rc => rc.RoleId == roleId && rc.ClaimType == Permissions.ClaimType)
            .ToListAsync(ct);

        var wanted = permissionKeys.Distinct().ToHashSet();
        var removed = existingClaims.Where(c => !wanted.Contains(c.ClaimValue!)).ToList();
        var existingValues = existingClaims.Select(c => c.ClaimValue!).ToHashSet();
        var added = wanted.Except(existingValues).ToList();

        db.RoleClaims.RemoveRange(removed);
        foreach (var key in added)
        {
            db.RoleClaims.Add(new IdentityRoleClaim<long>
            {
                RoleId = roleId,
                ClaimType = Permissions.ClaimType,
                ClaimValue = key
            });
        }

        if (!string.Equals(role.Description, description, StringComparison.Ordinal))
        {
            role.Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim();
        }

        if (!string.Equals(role.Name, name, StringComparison.Ordinal))
        {
            role.Name = name.Trim();
            role.NormalizedName = roles.NormalizeKey(name);
        }

        role.Level = level;

        await db.SaveChangesAsync(ct);

        var holderIds = await db.UserRoles.Where(ur => ur.RoleId == roleId).Select(ur => ur.UserId).ToListAsync(ct);
        foreach (var holderId in holderIds)
        {
            var holder = await users.FindByIdAsync(holderId.ToString());
            if (holder is not null)
            {
                await users.UpdateSecurityStampAsync(holder);
            }
        }

        await audit.AdminActionAsync("roleUpdated", "role", roleId,
            $"Updated role: {role.Name} (level {level})");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> DeleteAsync(
        long roleId, int actorLevel, CancellationToken ct = default)
    {
        var role = await roles.FindByIdAsync(roleId.ToString());
        if (role is null)
        {
            return (false, "Role not found");
        }

        if (BuiltInRoles.Contains(role.Name!))
        {
            return (false, "Cannot delete a built-in role");
        }

        if (role.Level > actorLevel)
        {
            return (false, "Cannot delete a role above your own level");
        }

        var holderIds = await db.UserRoles.Where(ur => ur.RoleId == roleId).Select(ur => ur.UserId).ToListAsync(ct);
        foreach (var holderId in holderIds)
        {
            var holder = await users.FindByIdAsync(holderId.ToString());
            if (holder is not null)
            {
                await users.UpdateSecurityStampAsync(holder);
            }
        }

        var result = await roles.DeleteAsync(role);
        if (!result.Succeeded)
        {
            return (false, string.Join("; ", result.Errors.Select(e => e.Description)));
        }

        await audit.AdminActionAsync("roleDeleted", "role", roleId, $"Deleted role: {role.Name}");
        return (true, null);
    }
}