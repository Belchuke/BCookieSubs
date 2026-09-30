using System.Security.Claims;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Security;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public interface ISetupService
{
    Task<bool> HasAnyUsersAsync(CancellationToken ct = default);
    Task<ApplicationUser> CreateOwnerAsync(string userName, string email, string password, CancellationToken ct = default);
}

public class SetupService(
    UserManager<ApplicationUser> users,
    RoleManager<ApplicationRole> roles,
    BCookieSubsDbContext db) : ISetupService
{
    public Task<bool> HasAnyUsersAsync(CancellationToken ct = default) =>
        db.Users.AnyAsync(ct);

    public async Task<ApplicationUser> CreateOwnerAsync(string userName, string email, string password, CancellationToken ct = default)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(745321)", ct);

        if (await db.Users.AnyAsync(ct))
        {
            throw new InvalidOperationException("Setup is already complete.");
        }

        var ownerRole = await roles.FindByNameAsync(RoleCatalog.OwnerRole);
        if (ownerRole is null)
        {
            var definition = RoleCatalog.Definitions.Single(d => d.Name == RoleCatalog.OwnerRole);
            ownerRole = new ApplicationRole
            {
                Name = RoleCatalog.OwnerRole,
                Level = definition.Level,
                Description = definition.Description,
                CreatedAt = DateTime.UtcNow
            };
            await roles.CreateAsync(ownerRole);
        }

        foreach (var permission in Permissions.All)
        {
            if ((await roles.GetClaimsAsync(ownerRole)).All(c => c.Type != Permissions.ClaimType || c.Value != permission))
            {
                await roles.AddClaimAsync(ownerRole, new Claim(Permissions.ClaimType, permission));
            }
        }

        var user = new ApplicationUser
        {
            UserName = userName.Trim(),
            Email = string.IsNullOrWhiteSpace(email) ? null : email.Trim(),
            CreatedAt = DateTime.UtcNow
        };

        var result = await users.CreateAsync(user, password);
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join("; ", result.Errors.Select(e => e.Description)));
        }

        await users.AddToRoleAsync(user, RoleCatalog.OwnerRole);
        await transaction.CommitAsync(ct);
        return user;
    }
}