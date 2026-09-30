using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public record ThemeColors(
    string Bg, string Surface, string Surface2, string Surface3, string BorderColor,
    string TextColor, string TextDim, string TextHint, string Accent, string AccentDim,
    string Success, string SuccessDim, string Warning, string WarningDim,
    string Error, string ErrorDim, string InfoDim);

public class ThemeService(
    ThemeRepository themes,
    ApplicationConfigRepository configs,
    AuditService audit)
{
    public const string DefaultThemeName = Database.Seeding.ThemeSeedData.DefaultThemeName;

    private static readonly Regex HexColor = new("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);

    public Task<List<Theme>> GetListAsync(CancellationToken ct = default) => themes.GetAllAsync(ct);

    public async Task<Theme> ResolveAsync(long? userSelectedThemeId, CancellationToken ct = default)
    {
        if (userSelectedThemeId.HasValue)
        {
            var personal = await themes.GetAsync(userSelectedThemeId.Value, ct);
            if (personal is not null)
            {
                return personal;
            }
        }

        var config = await configs.GetAsync(ct);
        if (config?.SelectedThemeId.HasValue == true)
        {
            var appDefault = await themes.GetAsync(config.SelectedThemeId.Value, ct);
            if (appDefault is not null)
            {
                return appDefault;
            }
        }

        return await themes.GetByNameAsync(DefaultThemeName, ct) ?? new Theme();
    }

    public async Task<(bool Ok, string? Error, Theme? Theme)> CreateAsync(
        long actorId, string name, ThemeColors colors, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return (false, "Theme name is required", null);
        }

        var cleanName = name.Trim();
        if (await themes.NameExistsAsync(cleanName, ct))
        {
            return (false, "A theme with this name already exists", null);
        }

        var colorError = ValidateColors(colors);
        if (colorError is not null)
        {
            return (false, colorError, null);
        }

        var theme = new Theme
        {
            Name = cleanName,
            Bg = colors.Bg,
            Surface = colors.Surface,
            Surface2 = colors.Surface2,
            Surface3 = colors.Surface3,
            BorderColor = colors.BorderColor,
            TextColor = colors.TextColor,
            TextDim = colors.TextDim,
            TextHint = colors.TextHint,
            Accent = colors.Accent,
            AccentDim = colors.AccentDim,
            Success = colors.Success,
            SuccessDim = colors.SuccessDim,
            Warning = colors.Warning,
            WarningDim = colors.WarningDim,
            Error = colors.Error,
            ErrorDim = colors.ErrorDim,
            InfoDim = colors.InfoDim,
            IsPublic = false,
            CreatedByUserId = actorId
        };
        await themes.AddAsync(theme, ct);

        await audit.AdminActionAsync("themeCreated", "theme", theme.Id, $"Created theme {theme.Name}");
        return (true, null, theme);
    }

    public async Task<(bool Ok, string? Error)> UpdateAsync(
        long themeId, string? name, ThemeColors colors, CancellationToken ct = default)
    {
        var theme = await themes.GetAsync(themeId, ct);
        if (theme is null)
        {
            return (false, "Theme not found");
        }

        if (theme.IsPublic)
        {
            return (false, "Cannot edit built-in themes");
        }

        var colorError = ValidateColors(colors);
        if (colorError is not null)
        {
            return (false, colorError);
        }

        if (!string.IsNullOrWhiteSpace(name))
        {
            var cleanName = name.Trim();
            if (!string.Equals(theme.Name, cleanName, StringComparison.Ordinal))
            {
                var clash = await themes.GetByNameAsync(cleanName, ct);
                if (clash is not null && clash.Id != theme.Id)
                {
                    return (false, "A theme with this name already exists");
                }

                theme.Name = cleanName;
            }
        }

        theme.Bg = colors.Bg;
        theme.Surface = colors.Surface;
        theme.Surface2 = colors.Surface2;
        theme.Surface3 = colors.Surface3;
        theme.BorderColor = colors.BorderColor;
        theme.TextColor = colors.TextColor;
        theme.TextDim = colors.TextDim;
        theme.TextHint = colors.TextHint;
        theme.Accent = colors.Accent;
        theme.AccentDim = colors.AccentDim;
        theme.Success = colors.Success;
        theme.SuccessDim = colors.SuccessDim;
        theme.Warning = colors.Warning;
        theme.WarningDim = colors.WarningDim;
        theme.Error = colors.Error;
        theme.ErrorDim = colors.ErrorDim;
        theme.InfoDim = colors.InfoDim;

        await themes.UpdateAsync(theme, ct);
        await audit.AdminActionAsync("themeUpdated", "theme", theme.Id, $"Updated theme {theme.Name}");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> DeleteAsync(long themeId, CancellationToken ct = default)
    {
        var theme = await themes.GetAsync(themeId, ct);
        if (theme is null)
        {
            return (false, "Theme not found");
        }

        if (theme.IsPublic)
        {
            return (false, "Cannot delete built-in themes");
        }

        await themes.DeleteAsync(theme, ct);

        var config = await configs.GetAsync(ct);
        if (config is not null && (config.SelectedThemeId is null || config.SelectedThemeId == themeId))
        {
            var fallback = await themes.GetByNameAsync(DefaultThemeName, ct);
            if (fallback is not null)
            {
                config.SelectedThemeId = fallback.Id;
                await configs.SaveAsync(ct);
            }
        }

        await audit.AdminActionAsync("themeDeleted", "theme", themeId, $"Deleted theme {theme.Name}");
        return (true, null);
    }

    private static string? ValidateColors(ThemeColors colors)
    {
        var fields = new (string Label, string Value)[]
        {
            ("background", colors.Bg), ("surface", colors.Surface), ("surface 2", colors.Surface2),
            ("surface 3", colors.Surface3), ("border", colors.BorderColor), ("text", colors.TextColor),
            ("dim text", colors.TextDim), ("hint text", colors.TextHint), ("accent", colors.Accent),
            ("dim accent", colors.AccentDim), ("success", colors.Success), ("dim success", colors.SuccessDim),
            ("warning", colors.Warning), ("dim warning", colors.WarningDim), ("error", colors.Error),
            ("dim error", colors.ErrorDim), ("dim info", colors.InfoDim)
        };

        var bad = fields.FirstOrDefault(f => !HexColor.IsMatch(f.Value ?? ""));
        return bad.Value is null ? null : $"Invalid hex color for {bad.Label} (expected #RRGGBB)";
    }
}