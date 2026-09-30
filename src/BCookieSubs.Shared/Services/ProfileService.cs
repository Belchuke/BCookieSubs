using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;
using Microsoft.AspNetCore.Identity;

namespace BCookieSubs.Shared.Services;

public class ProfileService(
    UserManager<ApplicationUser> userManager,
    UserRepository users,
    LanguageRepository languages,
    ThemeRepository themes,
    AuditService audit)
{
    public async Task<ApplicationUser?> GetAsync(long userId, CancellationToken ct = default) =>
        await users.GetAsync(userId, ct);

    public async Task<(bool Ok, string? Error)> ChangePasswordAsync(
        long userId, string currentPassword, string newPassword, CancellationToken ct = default)
    {
        var user = await userManager.FindByIdAsync(userId.ToString());
        if (user is null)
        {
            return (false, "User not found");
        }

        var result = await userManager.ChangePasswordAsync(user, currentPassword, newPassword);
        if (!result.Succeeded)
        {
            return (false, string.Join("; ", result.Errors.Select(e => e.Description)));
        }

        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> UpdatePreferencesAsync(
        long userId, long? themeId, bool? showPosters, CancellationToken ct = default)
    {
        var user = await users.GetAsync(userId, ct);
        if (user is null)
        {
            return (false, "User not found");
        }

        if (themeId.HasValue)
        {
            var theme = await themes.GetAsync(themeId.Value, ct);
            if (theme is null)
            {
                return (false, "Theme not found");
            }

            user.SelectedThemeId = themeId.Value;
        }

        if (showPosters.HasValue)
        {
            user.ShowPosters = showPosters.Value;
        }

        await users.SetPreferencesAsync(user, ct);
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> SetLanguageAsync(
        long userId, string? language, CancellationToken ct = default)
    {
        var user = await users.GetAsync(userId, ct);
        if (user is null)
        {
            return (false, "User not found");
        }

        var value = string.IsNullOrWhiteSpace(language) || language == "system" ? null : language.Trim();
        if (value is not null)
        {
            var known = await languages.GetAllAsync(ct);
            if (!known.Any(l =>
                    string.Equals(l.Locale, value, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(l.Iso639, value, StringComparison.OrdinalIgnoreCase)))
            {
                return (false, "Unsupported language");
            }
        }

        user.Language = value;
        await users.SetPreferencesAsync(user, ct);
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> SetUsernameAsync(
        long userId, string userName, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(userName))
        {
            return (false, "Username is required");
        }

        var user = await userManager.FindByIdAsync(userId.ToString());
        if (user is null)
        {
            return (false, "User not found");
        }

        var result = await userManager.SetUserNameAsync(user, userName.Trim());
        if (!result.Succeeded)
        {
            return (false, string.Join("; ", result.Errors.Select(e => e.Description)));
        }

        await audit.AdminActionAsync("usernameChanged", "user", userId, $"Username changed to {userName.Trim()}");
        return (true, null);
    }
}