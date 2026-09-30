using System.Security.Claims;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using Microsoft.AspNetCore.Identity;

namespace BCookieSubs.Web.Services;

public class CurrentUserContext(
    IHttpContextAccessor accessor,
    UserManager<ApplicationUser> userManager,
    PermissionService permissions)
{
    private long? _userId;
    private HashSet<string>? _permissions;
    private List<RoleSummary>? _roles;
    private ApplicationUser? _user;

    public bool IsAuthenticated => accessor.HttpContext?.User.Identity?.IsAuthenticated == true;

    public long Id
    {
        get
        {
            if (_userId.HasValue)
            {
                return _userId.Value;
            }

            var raw = accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
            _userId = long.TryParse(raw, out var id) ? id : 0;
            return _userId.Value;
        }
    }

    public async Task EnsureLoadedAsync(CancellationToken ct = default)
    {
        if (!IsAuthenticated)
        {
            return;
        }

        _permissions ??= await permissions.GetEffectivePermissionsAsync(Id, ct);
        _roles ??= await permissions.GetRolesAsync(Id, ct);
    }

    public HashSet<string> EffectivePermissions
    {
        get
        {
            if (_permissions is null && IsAuthenticated)
            {
                _permissions = permissions.GetEffectivePermissionsAsync(Id).GetAwaiter().GetResult();
            }
            return _permissions ?? [];
        }
    }

    public List<RoleSummary> Roles
    {
        get
        {
            if (_roles is null && IsAuthenticated)
            {
                _roles = permissions.GetRolesAsync(Id).GetAwaiter().GetResult();
            }
            return _roles ?? [];
        }
    }

    public int MaxRoleLevel => Roles.Count == 0 ? 0 : Roles.Max(r => r.Level);

    public bool HasPermission(string permission) => EffectivePermissions.Contains(permission);

    public ApplicationUser? User
    {
        get
        {
            if (_user is null && IsAuthenticated)
            {
                _user = userManager.FindByIdAsync(Id.ToString()).GetAwaiter().GetResult();
            }
            return _user;
        }
    }
}