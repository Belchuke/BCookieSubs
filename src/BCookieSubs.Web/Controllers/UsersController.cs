using System.ComponentModel.DataAnnotations;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Web.Controllers;

public class CreateUserInput
{
    [Required] public string UserName { get; set; } = "";
    public string? Email { get; set; }
    [Required] public string Password { get; set; } = "";
    public string? Password2 { get; set; }
    public long RoleId { get; set; }
    public string? Language { get; set; }
}

public class UserRolesInput
{
    public List<long> RoleIds { get; set; } = [];
}

public class OtherPasswordInput
{
    public string? Password { get; set; }
    public string? Password2 { get; set; }
}

public class RoleFormInput
{
    public string? Name { get; set; }
    public int Level { get; set; }
    public string? Description { get; set; }
    public List<string> PermissionKeys { get; set; } = [];
}

// One page: the user table and the roles section share this controller,
// with the /users/* and /users/roles/* route shapes the page's own JS posts to.
[Authorize(Policy = "Perm:" + Permissions.CanViewUsers)]
[Route("[controller]")]
public class UsersController(
    UserManagementService userManagement,
    RoleManagementService roleManagement,
    LanguageRepository languages,
    CurrentUserContext currentUser) : Controller
{
    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        ViewBag.CurrentUserId = currentUser.Id;
        ViewBag.Users = await userManagement.GetListAsync();
        ViewBag.Roles = await roleManagement.GetListAsync();
        ViewBag.Permissions = PermissionCatalog.Definitions;
        ViewBag.Languages = await languages.GetAllAsync();
        ViewBag.CanAddUser = currentUser.HasPermission(Permissions.CanAddUser);
        ViewBag.CanManageRoles = currentUser.HasPermission(Permissions.CanManageRoles);
        ViewBag.CanChangeOtherUsersPassword = currentUser.HasPermission(Permissions.CanChangeOtherUsersPassword);
        ViewBag.ToastError = Request.Query["toast"] == "error" ? Request.Query["msg"].FirstOrDefault() : null;
        return View();
    }

    [HttpPost("create")]
    [Authorize(Policy = "Perm:" + Permissions.CanAddUser)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(CreateUserInput input)
    {
        if (string.IsNullOrWhiteSpace(input.UserName) || string.IsNullOrWhiteSpace(input.Password))
        {
            return ToastError("Username and password are required");
        }

        if (input.Password != input.Password2)
        {
            return ToastError("Passwords do not match");
        }

        if (input.Password.Length < 8)
        {
            return ToastError("Password must be at least 8 characters");
        }

        if (input.RoleId <= 0)
        {
            return ToastError("A role must be selected");
        }

        await currentUser.EnsureLoadedAsync();
        var (ok, error, user) = await userManagement.CreateAsync(
            currentUser.Id, currentUser.MaxRoleLevel, input.UserName, input.Email, input.Password,
            input.RoleId, input.Language);
        if (!ok)
        {
            return ToastError(error ?? "Failed to create user");
        }

        return ToastSuccess($"User \"{input.UserName.Trim()}\" created");
    }

    [HttpPost("update-roles/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageRoles)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> UpdateRoles(long id, UserRolesInput input)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await userManagement.UpdateRolesAsync(
            currentUser.Id, currentUser.MaxRoleLevel, id, input.RoleIds);
        if (!ok)
        {
            return ToastError(error ?? "Update failed");
        }

        return ToastSuccess("Roles updated");
    }

    [HttpPost("change-password/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanChangeOtherUsersPassword)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ChangePassword(long id, OtherPasswordInput input)
    {
        if (string.IsNullOrEmpty(input.Password))
        {
            return ToastError("Password is required");
        }

        if (input.Password != input.Password2)
        {
            return ToastError("Passwords do not match");
        }

        if (input.Password.Length < 8)
        {
            return ToastError("Password must be at least 8 characters");
        }

        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await userManagement.ChangePasswordAsync(
            currentUser.Id, currentUser.MaxRoleLevel, id, input.Password);
        if (!ok)
        {
            return ToastError(error ?? "Failed to update password");
        }

        return ToastSuccess("Password updated");
    }

    [HttpPost("delete/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanAddUser)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(long id)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await userManagement.DeleteAsync(currentUser.Id, id);
        if (!ok)
        {
            return ToastError(error ?? "Delete failed");
        }

        return ToastSuccess("User deleted");
    }

    [HttpPost("roles/create")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageRoles)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CreateRole(RoleFormInput input) =>
        await WithRoleFormAsync(input, null,
            ok => ToastSuccess($"Role \"{input.Name}\" created"));

    [HttpPost("roles/update/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageRoles)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> UpdateRole(long id, RoleFormInput input) =>
        await WithRoleFormAsync(input, id,
            ok => ToastSuccess($"Role \"{input.Name}\" updated"));

    [HttpPost("roles/delete/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageRoles)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> DeleteRole(long id)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await roleManagement.DeleteAsync(id, currentUser.MaxRoleLevel);
        if (!ok)
        {
            return ToastError(error ?? "Failed to delete role");
        }

        return ToastSuccess("Role deleted");
    }

    private async Task<IActionResult> WithRoleFormAsync(
        RoleFormInput input, long? roleId, Func<bool, IActionResult> onSuccess)
    {
        if (string.IsNullOrWhiteSpace(input.Name))
        {
            return ToastError("Role name is required");
        }

        if (input.Level < 1)
        {
            return ToastError("Level must be a number ≥ 1");
        }

        await currentUser.EnsureLoadedAsync();
        var (ok, error) = roleId is long id
            ? await roleManagement.UpdateAsync(
                id, currentUser.MaxRoleLevel, input.Name, input.Level, input.Description, input.PermissionKeys)
            : await roleManagement.CreateAsync(
                currentUser.MaxRoleLevel, input.Name, input.Level, input.Description, input.PermissionKeys);
        if (!ok)
        {
            return ToastError(error ?? (roleId is null ? "Failed to create role" : "Failed to update role"));
        }

        return onSuccess(ok);
    }

    private IActionResult ToastError(string message) =>
        Redirect($"/users?toast=error&msg={Uri.EscapeDataString(message)}");

    private IActionResult ToastSuccess(string message) =>
        Redirect($"/users?toast=success&msg={Uri.EscapeDataString(message)}");
}