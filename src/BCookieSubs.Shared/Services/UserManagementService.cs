using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public record UserListItem(
    long Id, string UserName, string? Email, bool Enabled, DateTime CreatedAt,
    List<(long Id, string Name, int Level)> Roles, string HighestRole, int HighestLevel, bool LockoutActive);

public class UserManagementService(
    UserManager<ApplicationUser> userManager,
    RoleManager<ApplicationRole> roleManager,
    UserRepository users,
    ApplicationConfigRepository configs,
    LanguageRepository languages,
    AuditService audit)
{
    public const string OwnerRoleName = "Owner";

    public async Task<bool> CanManageTargetUserAsync(long actorId, long targetUserId, CancellationToken ct = default)
    {
        if (actorId == targetUserId)
        {
            return true;
        }

        var rolesByUser = await users.GetRolesByUserAsync([actorId, targetUserId], ct);
        return rolesByUser.GetValueOrDefault(actorId, []).Max(r => r.Level) >
               rolesByUser.GetValueOrDefault(targetUserId, []).Max(r => r.Level);
    }

    public async Task<int> GetLevelAsync(long userId, CancellationToken ct = default)
    {
        var roles = await users.GetRolesByUserAsync([userId], ct);
        return roles.GetValueOrDefault(userId, []).Max(r => r.Level);
    }

    public static bool CanAssignRole(int actorLevel, int roleLevel) => actorLevel >= roleLevel;

    public async Task<List<UserListItem>> GetListAsync(CancellationToken ct = default)
    {
        var all = await users.GetAllAsync(ct);
        var rolesByUser = await users.GetRolesByUserAsync(all.Select(u => u.Id), ct);
        return all.Select(u =>
        {
            var roles = rolesByUser.GetValueOrDefault(u.Id, []);
            return new UserListItem(
                u.Id, u.UserName ?? "", u.Email, u.LockoutEnd is null || u.LockoutEnd < DateTimeOffset.UtcNow,
                u.CreatedAt, roles, roles.FirstOrDefault().Name ?? "—", roles.FirstOrDefault().Level,
                u.LockoutEnd is not null && u.LockoutEnd > DateTimeOffset.UtcNow);
        }).ToList();
    }

    public record UserDetails(
        ApplicationUser User, List<(long Id, string Name, int Level)> Roles,
        int AccessFailedCount, DateTimeOffset? LockoutEnd, bool LockoutEnabled);

    public async Task<UserDetails?> GetAsync(long id, CancellationToken ct = default)
    {
        var user = await users.GetAsync(id, ct);
        if (user is null)
        {
            return null;
        }

        var roles = await users.GetRolesByUserAsync([id], ct);
        return new UserDetails(user, roles.GetValueOrDefault(id, []), user.AccessFailedCount,
            user.LockoutEnd, user.LockoutEnabled);
    }

    /// <summary>
    /// Creates a user. New users inherit the app theme and a copy of the global target
    /// languages.
    /// </summary>
    public async Task<(bool Ok, string? Error, ApplicationUser? User)> CreateAsync(
        long actorId, int actorLevel, string userName, string? email, string password,
        long roleId, string? language, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userName) || string.IsNullOrWhiteSpace(password))
        {
            return (false, "Username and password are required", null);
        }

        var role = await roleManager.FindByIdAsync(roleId.ToString());
        if (role is null)
        {
            return (false, "Role not found", null);
        }

        if (!CanAssignRole(actorLevel, role.Level))
        {
            return (false, "Cannot assign a role above your own level", null);
        }

        if (!await IsSupportedLanguageAsync(language, ct))
        {
            return (false, "Unsupported language", null);
        }

        var user = new ApplicationUser
        {
            UserName = userName.Trim(),
            Email = string.IsNullOrWhiteSpace(email) ? null : email.Trim(),
            CreatedAt = DateTime.UtcNow,
            ShowPosters = true,
            HasSeenTutorial = false,
            SelectedThemeId = (await configs.GetAsync(ct))?.SelectedThemeId,
            Language = string.IsNullOrWhiteSpace(language) || language == "system" ? null : language.Trim()
        };

        var result = await userManager.CreateAsync(user, password);
        if (!result.Succeeded)
        {
            return (false, string.Join("; ", result.Errors.Select(e => e.Description)), null);
        }

        await userManager.AddToRoleAsync(user, role.Name!);
        await languages.SyncUserLanguagesFromGlobalAsync(user.Id, ct);

        await audit.AdminActionAsync("userCreated", "user", user.Id,
            $"Created user {user.UserName} with role {role.Name}", new { role = role.Name });
        return (true, null, user);
    }

    private async Task<bool> IsSupportedLanguageAsync(string? language, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(language) || language == "system")
        {
            return true;
        }

        var known = await languages.GetAllAsync(ct);
        return known.Any(l =>
            string.Equals(l.Locale, language, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(l.Iso639, language, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Replaces the target's roles. Enforces the last-owner guard.</summary>
    public async Task<(bool Ok, string? Error)> UpdateRolesAsync(
        long actorId, int actorLevel, long targetUserId, IReadOnlyList<long> roleIds,
        CancellationToken ct = default)
    {
        var target = await userManager.FindByIdAsync(targetUserId.ToString());
        if (target is null)
        {
            return (false, "User not found");
        }

        var targetRoles = await userManager.GetRolesAsync(target);
        if (actorId != targetUserId && actorLevel <= await MaxLevelOfRoles(targetRoles, ct))
        {
            return (false, "Cannot manage a user with equal or higher role level");
        }

        var chosen = new List<(ApplicationRole Role, string Name)>();
        foreach (var roleId in roleIds)
        {
            var role = await roleManager.FindByIdAsync(roleId.ToString());
            if (role is null)
            {
                return (false, $"Role {roleId} not found");
            }

            if (!CanAssignRole(actorLevel, role.Level))
            {
                return (false, "Cannot assign a role above your own level");
            }

            chosen.Add((role, role.Name!));
        }

        if (targetRoles.Contains(OwnerRoleName) && chosen.All(c => c.Name != OwnerRoleName) &&
            await users.CountOwnersAsync(ct) <= 1)
        {
            return (false, "Cannot remove the last Owner role");
        }

        foreach (var name in targetRoles.Where(n => chosen.All(c => c.Name != n)))
        {
            await userManager.RemoveFromRoleAsync(target, name);
        }

        foreach (var (_, name) in chosen.Where(c => !targetRoles.Contains(c.Name)))
        {
            await userManager.AddToRoleAsync(target, name);
        }

        await userManager.UpdateSecurityStampAsync(target);
        await audit.AdminActionAsync("userRolesChanged", "user", target.Id,
            $"Updated roles for {target.UserName}: {string.Join(", ", chosen.Select(c => c.Name))}");
        return (true, null);
    }

    /// <summary>
    /// Soft-deletes a user (rows keep FK references to subtitles/jobs)
    /// and invalidates their sessions via a security-stamp refresh.
    /// </summary>
    public async Task<(bool Ok, string? Error)> DeleteAsync(
        long actorId, long targetUserId, CancellationToken ct = default)
    {
        if (actorId == targetUserId)
        {
            return (false, "Users cannot delete themselves");
        }

        if (!await CanManageTargetUserAsync(actorId, targetUserId, ct))
        {
            return (false, "Cannot delete a user with equal or higher role level");
        }

        var target = await userManager.FindByIdAsync(targetUserId.ToString());
        if (target is null)
        {
            return (false, "User to delete not found");
        }

        target.DeletedAt = DateTime.UtcNow;
        await userManager.UpdateSecurityStampAsync(target);
        await userManager.UpdateAsync(target);
        await audit.AdminActionAsync("userDeleted", "user", target.Id,
            $"Deleted user: {target.UserName}", new { deletedBy = actorId });
        return (true, null);
    }

    private async Task<int> MaxLevelOfRoles(IList<string> roleNames, CancellationToken ct)
    {
        var levels = await roleManager.Roles
            .Where(r => roleNames.Contains(r.Name!))
            .Select(r => (int?)r.Level)
            .ToListAsync(ct);
        return levels.Count == 0 ? 0 : levels.Max()!.Value;
    }

    /// <summary>Enable/disable via Identity lockout; the user row itself is kept.</summary>
    public async Task<(bool Ok, string? Error)> SetEnabledAsync(
        long actorId, int actorLevel, long targetUserId, bool enabled, CancellationToken ct = default)
    {
        if (actorId == targetUserId)
        {
            return (false, "You cannot disable your own account");
        }

        var target = await userManager.FindByIdAsync(targetUserId.ToString());
        if (target is null)
        {
            return (false, "User not found");
        }

        var targetRoles = await userManager.GetRolesAsync(target);
        if (actorLevel <= await MaxLevelOfRoles(targetRoles, ct))
        {
            return (false, "Cannot manage a user with equal or higher role level");
        }

        if (enabled)
        {
            await userManager.SetLockoutEndDateAsync(target, null);
        }
        else
        {
            await userManager.SetLockoutEnabledAsync(target, true);
            await userManager.SetLockoutEndDateAsync(target, DateTimeOffset.UtcNow.AddYears(100));
        }

        await audit.AdminActionAsync(enabled ? "userEnabled" : "userDisabled", "user", target.Id,
            $"{(enabled ? "Enabled" : "Disabled")} account {target.UserName}");
        return (true, null);
    }

    /// <summary>Admin password reset; the target's existing sessions are invalidated.</summary>
    public async Task<(bool Ok, string? Error)> ChangePasswordAsync(
        long actorId, int actorLevel, long targetUserId, string newPassword, CancellationToken ct = default)
    {
        var target = await userManager.FindByIdAsync(targetUserId.ToString());
        if (target is null)
        {
            return (false, "User not found");
        }

        var targetRoles = await userManager.GetRolesAsync(target);
        if (actorId != targetUserId && actorLevel <= await MaxLevelOfRoles(targetRoles, ct))
        {
            return (false, "Cannot change the password of a user with equal or higher role level");
        }

        var result = await userManager.RemovePasswordAsync(target);
        if (!result.Succeeded)
        {
            return (false, string.Join("; ", result.Errors.Select(e => e.Description)));
        }

        result = await userManager.AddPasswordAsync(target, newPassword);
        if (!result.Succeeded)
        {
            return (false, string.Join("; ", result.Errors.Select(e => e.Description)));
        }

        await userManager.UpdateSecurityStampAsync(target);
        await audit.AdminActionAsync("passwordChanged", "user", target.Id,
            $"Password changed for {target.UserName}");
        return (true, null);
    }
}