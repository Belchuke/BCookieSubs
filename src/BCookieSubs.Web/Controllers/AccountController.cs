using System.ComponentModel.DataAnnotations;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

public class LoginInput
{
    [Required]
    public string UserName { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    public string Password { get; set; } = "";
}

public class ProfileUsernameInput
{
    [Required]
    public string UserName { get; set; } = "";
}

public class ProfilePasswordInput
{
    [Required]
    [DataType(DataType.Password)]
    public string CurrentPassword { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    public string NewPassword { get; set; } = "";

    [Required]
    [DataType(DataType.Password)]
    public string NewPassword2 { get; set; } = "";
}

public class AccountController(
    SignInManager<ApplicationUser> signIn,
    UserManager<ApplicationUser> users,
    RoleManager<ApplicationRole> roleManager,
    ProfileService profile,
    TranslationLanguageService translationLanguages,
    LanguageRepository languages,
    ThemeRepository themes,
    AuditService audit) : Controller
{
    [HttpGet("/login")]
    [AllowAnonymous]
    public IActionResult Login(string? next = null, string? error = null)
    {
        if (User.Identity?.IsAuthenticated == true)
        {
            return Redirect("/dashboard");
        }

        ViewBag.Next = next;
        ViewBag.Error = error;
        return View();
    }

    [HttpPost("/login")]
    [AllowAnonymous]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Login(LoginInput input, string? next = null)
    {
        if (!ModelState.IsValid)
        {
            ViewBag.Next = next;
            return View(input);
        }

        var result = await signIn.PasswordSignInAsync(input.UserName, input.Password, isPersistent: true, lockoutOnFailure: true);
        if (result.Succeeded)
        {
            var signedIn = await users.FindByNameAsync(input.UserName);
            if (signedIn is { DeletedAt: not null })
            {
                await signIn.SignOutAsync();
                await audit.AdminActionAsync("loginFailed", "user", null,
                    $"Failed login attempt for {input.UserName}");
                return Redirect($"/login?error={Uri.EscapeDataString("Invalid username or password")}");
            }

            if (!string.IsNullOrEmpty(next) && Url.IsLocalUrl(next))
            {
                return Redirect(next);
            }
            return Redirect("/dashboard");
        }

        await audit.AdminActionAsync("loginFailed", "user", null,
            $"Failed login attempt for {input.UserName}");
        var message = result.IsLockedOut ? "Account is temporarily locked." : "Invalid username or password";
        return Redirect($"/login?error={Uri.EscapeDataString(message)}");
    }

    [HttpPost("/logout")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Logout()
    {
        await signIn.SignOutAsync();
        return Redirect("/login");
    }

    [HttpGet("/account")]
    [Authorize]
    public async Task<IActionResult> Index()
    {
        var user = await profile.GetAsync(CurrentUserId());
        if (user is null)
        {
            return Redirect("/login");
        }

        var appUser = await users.FindByIdAsync(user.Id.ToString());
        var roleNames = appUser is null ? [] : await users.GetRolesAsync(appUser);
        var roles = roleManager.Roles.ToList();
        var myRoles = roleNames
            .Select(name => roles.FirstOrDefault(r => r.Name == name))
            .Where(r => r is not null)
            .OrderByDescending(r => r!.Level)
            .Select(r => (Name: r!.Name ?? "", Level: r.Level))
            .ToList();

        ViewBag.Themes = await themes.GetAllAsync();
        ViewBag.Languages = await languages.GetAllAsync();
        ViewBag.UserLanguages = await translationLanguages.GetUserAsync(user.Id);
        ViewBag.Username = user.UserName;
        ViewBag.Language = user.Language;
        ViewBag.ShowPosters = user.ShowPosters;
        ViewBag.SelectedThemeId = user.SelectedThemeId;
        ViewBag.MyRoles = myRoles;
        return View("Profile");
    }

    [HttpPost("/account/username")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ChangeUsername(ProfileUsernameInput input)
    {
        if (!ModelState.IsValid || string.IsNullOrWhiteSpace(input.UserName))
        {
            TempData["Error"] = "Username is required";
            return RedirectToAction("Index");
        }

        var (ok, error) = await profile.SetUsernameAsync(CurrentUserId(), input.UserName.Trim());
        TempData[ok ? "Success" : "Error"] = ok ? "Username updated" : error;
        return RedirectToAction("Index");
    }

    [HttpPost("/account/password")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ChangePassword(ProfilePasswordInput input)
    {
        var userId = CurrentUserId();
        if (string.IsNullOrEmpty(input.CurrentPassword) || string.IsNullOrEmpty(input.NewPassword))
        {
            TempData["Error"] = "All fields are required";
            return RedirectToAction("Index");
        }

        if (input.NewPassword.Length < 8)
        {
            TempData["Error"] = "Password must be at least 8 characters";
            return RedirectToAction("Index");
        }

        if (input.NewPassword != input.NewPassword2)
        {
            TempData["Error"] = "Passwords do not match";
            return RedirectToAction("Index");
        }

        var (ok, error) = await profile.ChangePasswordAsync(userId, input.CurrentPassword, input.NewPassword);
        if (!ok)
        {
            TempData["Error"] = error;
            return RedirectToAction("Index");
        }

        await audit.AdminActionAsync("passwordChanged", "user", userId, "Changed own password");
        await signIn.SignOutAsync();
        return Redirect($"/login?error={Uri.EscapeDataString("Password changed — please sign in again")}");
    }

    [HttpPost("/account/showPosters")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetShowPosters(string? showPosters)
    {
        var enabled = showPosters == "1";
        var (ok, error) = await profile.UpdatePreferencesAsync(CurrentUserId(), null, enabled);
        TempData[ok ? "Success" : "Error"] = ok ? "Preference saved" : error;
        return RedirectToAction("Index");
    }

    [HttpPost("/account/theme")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetTheme(long? themeId)
    {
        var (ok, error) = await profile.UpdatePreferencesAsync(CurrentUserId(), themeId, null);
        TempData[ok ? "Success" : "Error"] = ok ? "Theme updated" : error;
        return RedirectToAction("Index");
    }

    [HttpPost("/account/language")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetLanguage(string? language)
    {
        var lang = string.IsNullOrEmpty(language) || language == "system" ? null : language;
        var (ok, error) = await profile.SetLanguageAsync(CurrentUserId(), lang);
        TempData[ok ? "Success" : "Error"] = ok ? "Language preference saved" : error;
        return RedirectToAction("Index");
    }

    [HttpPost("/account/translationlangs/add")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AddUserLanguage(long languageId)
    {
        var (ok, error) = await translationLanguages.AddUserLanguageAsync(CurrentUserId(), languageId);
        TempData[ok ? "Success" : "Error"] = ok ? "Language added" : error;
        return RedirectToAction("Index");
    }

    [HttpPost("/account/translationlangs/remove/{langId:long}")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RemoveUserLanguage(long langId)
    {
        var (ok, error) = await translationLanguages.RemoveUserLanguageAsync(CurrentUserId(), langId);
        TempData[ok ? "Success" : "Error"] = ok ? "Language removed" : error;
        return RedirectToAction("Index");
    }

    [HttpPost("/account/translationlangs/move/{langId:long}")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> MoveUserLanguage(long langId, string? direction)
    {
        if (direction != "up" && direction != "down")
        {
            TempData["Error"] = "Invalid direction";
            return RedirectToAction("Index");
        }

        var (ok, error) = await translationLanguages.MoveUserLanguageAsync(
            CurrentUserId(), langId, direction == "up" ? -1 : 1);
        if (!ok)
        {
            TempData["Error"] = error;
        }
        return RedirectToAction("Index");
    }

    private long CurrentUserId() =>
        long.TryParse(User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value, out var id) ? id : 0;
}