using System.Security.Claims;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace BCookieSubs.Web.Security;

public class PermissionRequirement(string permission) : IAuthorizationRequirement
{
    public string Permission { get; } = permission;
}

public class AnyPermissionRequirement(string[] permissions) : IAuthorizationRequirement
{
    public string[] Permissions { get; } = permissions;
}

public class PermissionAuthorizationHandler(PermissionService permissions) : AuthorizationHandler<PermissionRequirement>
{
    protected override async Task HandleRequirementAsync(
        AuthorizationHandlerContext context, PermissionRequirement requirement)
    {
        var raw = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (!long.TryParse(raw, out var userId))
        {
            return;
        }

        var effective = await permissions.GetEffectivePermissionsAsync(userId);
        if (effective.Contains(requirement.Permission))
        {
            context.Succeed(requirement);
        }
    }
}

public class AnyPermissionAuthorizationHandler(PermissionService permissions)
    : AuthorizationHandler<AnyPermissionRequirement>
{
    protected override async Task HandleRequirementAsync(
        AuthorizationHandlerContext context, AnyPermissionRequirement requirement)
    {
        var raw = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (!long.TryParse(raw, out var userId))
        {
            return;
        }

        var effective = await permissions.GetEffectivePermissionsAsync(userId);
        if (requirement.Permissions.Any(effective.Contains))
        {
            context.Succeed(requirement);
        }
    }
}

public class PermissionPolicyProvider(IOptions<AuthorizationOptions> options)
    : DefaultAuthorizationPolicyProvider(options)
{
    public override async Task<AuthorizationPolicy?> GetPolicyAsync(string policyName)
    {
        if (policyName.StartsWith(Policies.Prefix, StringComparison.Ordinal))
        {
            return new AuthorizationPolicyBuilder()
                .RequireAuthenticatedUser()
                .AddRequirements(new PermissionRequirement(policyName[Policies.Prefix.Length..]))
                .Build();
        }

        return await base.GetPolicyAsync(policyName);
    }
}