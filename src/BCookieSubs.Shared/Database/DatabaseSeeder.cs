using System.Security.Claims;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Database.Seeding;
using BCookieSubs.Shared.Security;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Shared.Database;

public static class DatabaseSeeder
{
    public static async Task SeedAsync(BCookieSubsDbContext db, ILogger? logger = null, CancellationToken ct = default)
    {
        SeedPermissions(db);
        await SeedRolesAsync(db, ct);
        SeedLanguages(db);
        var defaultTheme = await SeedThemesAsync(db, ct);
        SeedRecommendedModels(db);
        await SeedPromptsAsync(db, ct);
        await SeedApplicationConfigAsync(db, defaultTheme, ct);

        await db.SaveChangesAsync(ct);
        logger?.LogDebug("Reference data seeding completed");
    }

    private static void SeedPermissions(BCookieSubsDbContext db)
    {
        var existing = db.Permissions.ToDictionary(p => p.Key);
        foreach (var definition in PermissionCatalog.Definitions)
        {
            if (existing.TryGetValue(definition.Key, out var permission))
            {
                permission.Label = definition.Label;
                permission.Description = definition.Description;
                permission.Category = definition.Category;
                permission.UpdatedAt = DateTime.UtcNow;
            }
            else
            {
                db.Permissions.Add(new Permission
                {
                    Key = definition.Key,
                    Label = definition.Label,
                    Description = definition.Description,
                    Category = definition.Category,
                    CreatedAt = DateTime.UtcNow,
                    UpdatedAt = DateTime.UtcNow,
                });
            }
        }
    }

    private static async Task SeedRolesAsync(BCookieSubsDbContext db, CancellationToken ct)
    {
        var existingRoles = await db.Roles.ToDictionaryAsync(r => r.NormalizedName!, ct);
        var claimsByRoleId = (await db.RoleClaims
                .Where(c => c.ClaimType == Permissions.ClaimType)
                .Select(c => new { c.RoleId, c.ClaimValue })
                .ToListAsync(ct))
            .GroupBy(c => c.RoleId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.ClaimValue!).ToHashSet());

        var pendingClaims = new List<(ApplicationRole Role, HashSet<string> Existing, IReadOnlyList<string> Permissions)>();
        foreach (var definition in RoleCatalog.Definitions)
        {
            var normalizedName = definition.Name.ToUpperInvariant();
            HashSet<string> existingClaims;
            if (!existingRoles.TryGetValue(normalizedName, out var role))
            {
                role = new ApplicationRole
                {
                    Name = definition.Name,
                    NormalizedName = normalizedName,
                    ConcurrencyStamp = Guid.NewGuid().ToString(),
                    Level = definition.Level,
                    Description = definition.Description,
                    CreatedAt = DateTime.UtcNow,
                };
                db.Roles.Add(role);
                existingClaims = [];
            }
            else
            {
                role.Level = definition.Level;
                role.Description = definition.Description;
                existingClaims = claimsByRoleId.TryGetValue(role.Id, out var set) ? set : [];
            }

            pendingClaims.Add((role, existingClaims, definition.Permissions));
        }

        await db.SaveChangesAsync(ct);

        foreach (var (role, existingClaims, permissions) in pendingClaims)
        {
            foreach (var permission in permissions)
            {
                if (existingClaims.Add(permission))
                {
                    db.RoleClaims.Add(new IdentityRoleClaim<long>
                    {
                        RoleId = role.Id,
                        ClaimType = Permissions.ClaimType,
                        ClaimValue = permission,
                    });
                }
            }
        }
    }

    private static void SeedLanguages(BCookieSubsDbContext db)
    {
        var existing = db.Languages
            .Select(l => new { l.Iso639, l.Locale })
            .ToHashSet();
        var now = DateTime.UtcNow;
        foreach (var row in LanguageSeedData.Rows)
        {
            if (existing.Add(new { row.Iso639, row.Locale }))
            {
                db.Languages.Add(new Language
                {
                    Name = row.Name,
                    Iso639 = row.Iso639,
                    Iso6392B = row.Iso6392B,
                    Locale = row.Locale,
                    Flag = row.Flag,
                    CreatedAt = now,
                    UpdatedAt = now,
                });
            }
        }
    }

    private static async Task<Theme?> SeedThemesAsync(BCookieSubsDbContext db, CancellationToken ct)
    {
        var existingNames = await db.Themes.Select(t => t.Name).ToListAsync(ct);
        Theme? defaultTheme = null;
        var now = DateTime.UtcNow;
        foreach (var row in ThemeSeedData.Rows)
        {
            if (existingNames.Contains(row.Name))
            {
                continue;
            }

            var theme = new Theme
            {
                Name = row.Name,
                Bg = row.Bg,
                Surface = row.Surface,
                Surface2 = row.Surface2,
                Surface3 = row.Surface3,
                BorderColor = row.BorderColor,
                TextColor = row.TextColor,
                TextDim = row.TextDim,
                TextHint = row.TextHint,
                Accent = row.Accent,
                AccentDim = row.AccentDim,
                Success = row.Success,
                SuccessDim = row.SuccessDim,
                Warning = row.Warning,
                WarningDim = row.WarningDim,
                Error = row.Error,
                ErrorDim = row.ErrorDim,
                InfoDim = row.InfoDim,
                IsPublic = true,
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.Themes.Add(theme);
            if (row.Name == ThemeSeedData.DefaultThemeName)
            {
                defaultTheme = theme;
            }
        }

        defaultTheme ??= await db.Themes
            .FirstOrDefaultAsync(t => t.Name == ThemeSeedData.DefaultThemeName, ct);

        return defaultTheme;
    }

    private static void SeedRecommendedModels(BCookieSubsDbContext db)
    {
        var existing = db.RecommendedModels.Select(m => m.Name).ToHashSet();
        var now = DateTime.UtcNow;
        foreach (var row in RecommendedModelSeedData.Rows)
        {
            if (!existing.Add(row.Name))
            {
                continue;
            }

            db.RecommendedModels.Add(new RecommendedModel
            {
                Name = row.Name,
                Provider = row.Provider,
                BaseUrl = row.BaseUrl,
                Roles = [.. row.Roles],
                RequireOllamaSubscription = row.RequireOllamaSubscription,
                Score = row.Score,
                CreatedAt = now,
                UpdatedAt = now,
            });
        }
    }

    private static async Task SeedPromptsAsync(BCookieSubsDbContext db, CancellationToken ct)
    {
        var existing = await db.Prompts.Select(p => p.Name).ToListAsync(ct);
        var now = DateTime.UtcNow;
        foreach (var row in PromptSeedData.Rows)
        {
            if (existing.Contains(row.Name))
            {
                continue;
            }

            var prompt = new Prompt
            {
                Name = row.Name,
                Kind = row.Kind,
                Active = true,
                CreatedAt = now,
                UpdatedAt = now,
            };
            db.Prompts.Add(prompt);
            db.PromptVersions.Add(new PromptVersion
            {
                Prompt = prompt,
                Version = 1,
                PromptText = row.PromptText,
                Active = true,
                CreatedAt = now,
            });
        }
    }

    private static async Task SeedApplicationConfigAsync(BCookieSubsDbContext db, Theme? defaultTheme, CancellationToken ct)
    {
        if (await db.ApplicationConfig.AnyAsync(c => c.Id == ApplicationConfig.SingletonId, ct))
        {
            return;
        }

        var tmdbKey = Environment.GetEnvironmentVariable("THEMOVIEDB_API_KEY")?.Trim();
        var rootLibraryPath = Environment.GetEnvironmentVariable("TRANSLATION_ROOT_DIR")?.Trim();

        var envLanguage = Environment.GetEnvironmentVariable("APP_DEFAULT_LANGUAGE")?.Trim();
        var defaultLanguage = "en";
        if (!string.IsNullOrEmpty(envLanguage))
        {
            var supported = LanguageSeedData.Rows.Any(l => l.Iso639 == envLanguage || l.Locale == envLanguage);
            if (supported)
            {
                defaultLanguage = envLanguage;
            }
        }

        var now = DateTime.UtcNow;
        db.ApplicationConfig.Add(new ApplicationConfig
        {
            Id = ApplicationConfig.SingletonId,
            TheMovieDbActive = tmdbKey is not null,
            ShowPosters = tmdbKey is not null,
            RootLibraryPath = string.IsNullOrEmpty(rootLibraryPath) ? null : rootLibraryPath,
            ScanLibraryPaths = rootLibraryPath is not null,
            DefaultLanguage = defaultLanguage,
            ThaiAssFont = Environment.GetEnvironmentVariable("THAI_ASS_FONT")?.Trim() is { Length: > 0 } font
                ? font
                : "Garuda",
            SelectedTheme = defaultTheme,
            CreatedAt = now,
            UpdatedAt = now,
        });
    }
}