using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

public class GeneralConfigInput
{
    public string? DefaultChunkSize { get; set; }
    public string? MaxRetriesPerChunk { get; set; }
    public string? SessionTimeoutMinutes { get; set; }
    public string? ClearLogsOlderThanDays { get; set; }
    public string? FinishSingleSubtitleFirst { get; set; }
    public string? NameDetectionActive { get; set; }
    public string? ShowPosters { get; set; }
    public string? TheMovieDbActive { get; set; }
    public string? ScheduleConfigured { get; set; }
    public string? ScanLibraryPaths { get; set; }
    public string? DeleteNotCancel { get; set; }
    public string? ClearLogs { get; set; }
    public string? RootLibraryPath { get; set; }
}

public class WhisperFormInput
{
    public string? WhisperModel { get; set; }
    public string? WhisperTimestampsLength { get; set; }
    public string? WhisperUseCuda { get; set; }
    public string? WhisperEnabled { get; set; }
    public string? WhisperRunAsSeparateTask { get; set; }
    public string? WhisperModelRootPath { get; set; }
}

public class DefaultLanguageInput
{
    public string? DefaultLanguage { get; set; }
}

public class SubtitleFontInput
{
    public string? ThaiAssFont { get; set; }
}

public class ThemeSelectInput
{
    public long ThemeId { get; set; }
}

public class ThemeCreateInput
{
    public string? Name { get; set; }
    public string? Bg { get; set; }
    public string? Surface { get; set; }
    public string? Surface2 { get; set; }
    public string? Surface3 { get; set; }
    public string? BorderColor { get; set; }
    public string? TextColor { get; set; }
    public string? TextDim { get; set; }
    public string? TextHint { get; set; }
    public string? Accent { get; set; }
    public string? AccentDim { get; set; }
    public string? Success { get; set; }
    public string? SuccessDim { get; set; }
    public string? Warning { get; set; }
    public string? WarningDim { get; set; }
    public string? Error { get; set; }
    public string? ErrorDim { get; set; }
    public string? InfoDim { get; set; }
}

public class SecretSetInput
{
    public string? SecretName { get; set; }
    public string? SecretValue { get; set; }
}

public record SecretRow(string Key, string DisplayName, string Description, bool HasSecret, bool SetByEnv);

[Authorize(Policy = "Perm:" + Permissions.CanViewSettingsPage)]
[Route("[controller]")]
public class SettingsController(
    ConfigService config,
    TranslationLanguageService translationLanguages,
    BCookieSubs.Shared.Repositories.LanguageRepository languages,
    BCookieSubs.Shared.Repositories.ThemeRepository themeRepository,
    ThemeService themes,
    SecretsService secrets,
    CurrentUserContext currentUser) : Controller
{
    private static readonly (string Key, string DisplayName, string Description)[] SecretDefinitions =
    [
        (SecretKeys.TmdbApiKey, "The Movie DB API Key",
            "API key for The Movie DB integration (used for automatic media item name detection and more)"),
        (SecretKeys.OllamaApiKey, "Ollama API Key",
            "API key for Ollama for using cloud-hosted models (if not using local Ollama)"),
        (SecretKeys.OpenAiApiKey, "OpenAI API Key",
            "API key for OpenAI (ChatGPT) models"),
        (SecretKeys.AnthropicApiKey, "Anthropic API Key",
            "API key for Anthropic (Claude) models"),
    ];

    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        var cfg = await config.GetAsync();
        var allThemes = (await themeRepository.GetAllAsync())
            .OrderByDescending(t => t.IsPublic).ThenBy(t => t.Name)
            .ToList();
        ViewBag.Config = cfg;
        ViewBag.Themes = allThemes;
        ViewBag.ConfigTheme = allThemes.FirstOrDefault(t => t.Id == cfg?.SelectedThemeId)
                              ?? allThemes.FirstOrDefault();
        ViewBag.Languages = await languages.GetAllAsync();
        ViewBag.GlobalLanguages = await translationLanguages.GetGlobalAsync();
        ViewBag.CanManage = currentUser.HasPermission(Permissions.CanManageSettings);
        ViewBag.CanSeeSecrets = currentUser.HasPermission(Permissions.CanManageSecrets);

        var rows = await secrets.GetAllAsync();
        var byKey = rows.ToDictionary(s => s.Key, s => s);
        ViewBag.Secrets = SecretDefinitions
            .Select(d => byKey.TryGetValue(d.Key, out var s)
                ? new SecretRow(d.Key, d.DisplayName, d.Description, s.Ciphertext.Length > 0, s.SetByEnv)
                : new SecretRow(d.Key, d.DisplayName, d.Description, false, false))
            .ToList();

        ViewBag.ToastError = Request.Query["toast"] == "error" ? Request.Query["msg"].FirstOrDefault() : null;
        return View();
    }

    [HttpPost("")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> General(GeneralConfigInput input)
    {
        var error = await config.UpdateGeneralFormAsync(
            ParseIntOr(input.DefaultChunkSize, 12), ParseIntOr(input.MaxRetriesPerChunk, 5),
            ParseIntOr(input.SessionTimeoutMinutes, 120),
            input.FinishSingleSubtitleFirst == "1", input.NameDetectionActive == "1",
            input.ShowPosters == "1", input.TheMovieDbActive == "1", input.ScheduleConfigured == "1",
            input.ScanLibraryPaths == "1", input.DeleteNotCancel == "1",
            input.ClearLogs == "1", ParseIntOr(input.ClearLogsOlderThanDays, 30),
            input.RootLibraryPath, updateRootLibraryPath: input.RootLibraryPath != null);
        if (error is not null)
        {
            return ToastError(error);
        }

        return ToastSuccess("Configuration saved");
    }

    [HttpPost("whisper")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Whisper(WhisperFormInput input)
    {
        var parsed = int.TryParse(input.WhisperTimestampsLength, out var value) ? value : -1;
        var timestamps = parsed is < 1 or > 500 ? 80 : parsed;
        var requestedCuda = ConfigService.IsWhisperGpuAvailable() && input.WhisperUseCuda == "1";
        var error = await config.UpdateWhisperAsync(input.WhisperModel ?? "large-v3-turbo", timestamps,
            requestedCuda, input.WhisperEnabled == "1", input.WhisperRunAsSeparateTask == "1",
            input.WhisperModelRootPath);
        if (error is not null)
        {
            return ToastError(error);
        }

        return ToastSuccess("Whisper settings saved");
    }

    [HttpPost("theme/select")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ThemeSelect(ThemeSelectInput input)
    {
        await currentUser.EnsureLoadedAsync();
        var error = await config.UpdateThemeAsync(input.ThemeId, currentUser.Id);
        if (error is not null)
        {
            return ToastError(error);
        }

        return ToastSuccess("Theme updated");
    }

    [HttpPost("theme/create")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ThemeCreate(ThemeCreateInput input)
    {
        await currentUser.EnsureLoadedAsync();
        var colors = new ThemeColors(input.Bg ?? "", input.Surface ?? "", input.Surface2 ?? "",
            input.Surface3 ?? "", input.BorderColor ?? "", input.TextColor ?? "", input.TextDim ?? "",
            input.TextHint ?? "", input.Accent ?? "", input.AccentDim ?? "", input.Success ?? "",
            input.SuccessDim ?? "", input.Warning ?? "", input.WarningDim ?? "", input.Error ?? "",
            input.ErrorDim ?? "", input.InfoDim ?? "");
        var (ok, error, theme) = await themes.CreateAsync(currentUser.Id, input.Name ?? "", colors);
        if (!ok || theme is null)
        {
            return ToastError(error ?? "Failed to create theme");
        }

        await config.UpdateThemeAsync(theme.Id, currentUser.Id);
        return ToastSuccess("Theme created and applied");
    }

    [HttpPost("theme/delete/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ThemeDelete(long id)
    {
        var (ok, error) = await themes.DeleteAsync(id);
        if (!ok)
        {
            return ToastError(error ?? "Failed to delete theme");
        }

        return ToastSuccess("Theme deleted");
    }

    [HttpPost("language")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Language(DefaultLanguageInput input)
    {
        var cfg = await config.GetAsync();
        var error = await config.UpdateGeneralAsync(cfg?.SessionTimeoutMinutes ?? 120,
            string.IsNullOrWhiteSpace(input.DefaultLanguage) ? "en" : input.DefaultLanguage.Trim());
        if (error is not null)
        {
            return ToastError(error);
        }

        return ToastSuccess("Default language updated");
    }

    [HttpPost("subtitlefont")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SubtitleFont(SubtitleFontInput input)
    {
        var cfg = await config.GetAsync();
        if (cfg is null)
        {
            return ToastError("Application configuration not found");
        }

        var error = await config.UpdateTranslationAsync(cfg.DefaultChunkSize, cfg.MaxRetriesPerChunk,
            cfg.FinishSingleSubtitleFirst, cfg.DeleteNotCancel,
            string.IsNullOrWhiteSpace(input.ThaiAssFont) ? "Garuda" : input.ThaiAssFont.Trim());
        if (error is not null)
        {
            return ToastError(error);
        }

        return ToastSuccess("Subtitle font saved");
    }

    [HttpPost("translationlangs/add")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AddTranslationLang(long languageId)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await translationLanguages.AddGlobalAsync(currentUser.Id, languageId);
        if (!ok)
        {
            return ToastError(error ?? "Failed to add");
        }

        return ToastSuccess("Language added to defaults");
    }

    [HttpPost("translationlangs/remove/{langId:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RemoveTranslationLang(long langId)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await translationLanguages.RemoveGlobalAsync(currentUser.Id, langId);
        if (!ok)
        {
            return ToastError(error ?? "Failed to remove");
        }

        return ToastSuccess("Language removed from defaults");
    }

    [HttpPost("translationlangs/move/{langId:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> MoveTranslationLang(long langId, string? direction)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await translationLanguages.MoveGlobalAsync(
            currentUser.Id, langId, direction == "up" ? -1 : 1);
        if (!ok)
        {
            return ToastError(error ?? "Failed to reorder");
        }

        return Redirect("/settings");
    }

    // Secrets are write-only from the UI: values are never rendered back, and
    // environment-managed keys stay under environment control.
    [HttpPost("secrets/set")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSecrets)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SecretSet(SecretSetInput input)
    {
        var key = input.SecretName ?? "";
        if (!SecretKeys.EnvironmentVariables.Values.Contains(key))
        {
            return ToastError("Unknown secret key");
        }

        if (string.IsNullOrWhiteSpace(input.SecretValue))
        {
            return ToastError("Value is required");
        }

        if (await IsEnvManagedAsync(key))
        {
            return ToastError("This secret is provided by the environment and cannot be changed here; remove the environment variable instead.");
        }

        await secrets.SetAsync(key, input.SecretValue.Trim(), setByEnv: false);
        return ToastSuccess("Secret set successfully");
    }

    [HttpPost("secrets/delete/{secretName}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageSecrets)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SecretDelete(string secretName)
    {
        if (!SecretKeys.EnvironmentVariables.Values.Contains(secretName))
        {
            return ToastError("Unknown secret key");
        }

        var rows = await secrets.GetAllAsync();
        var secret = rows.FirstOrDefault(s => s.Key == secretName);
        if (secret is null)
        {
            return ToastError("Secret is not configured");
        }

        if (await IsEnvManagedAsync(secretName))
        {
            return ToastError("This secret is provided by the environment and cannot be removed here; remove the environment variable instead.");
        }

        await secrets.DeleteAsync(secretName);
        return ToastSuccess("Secret deleted successfully");
    }

    private async Task<bool> IsEnvManagedAsync(string key)
    {
        var rows = await secrets.GetAllAsync();
        var secret = rows.FirstOrDefault(s => s.Key == key);
        return secret is { SetByEnv: true } && SecretKeys.EnvironmentVariables.Any(kv =>
            kv.Value == key && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(kv.Key)));
    }

    // parseInt(x) || fallback semantics: NaN and 0 fall back, other values stay.
    private static int ParseIntOr(string? raw, int fallback) =>
        int.TryParse(raw, out var value) && value != 0 ? value : fallback;

    private IActionResult ToastError(string message) =>
        Redirect($"/settings?toast=error&msg={Uri.EscapeDataString(message)}");

    private IActionResult ToastSuccess(string message) =>
        Redirect($"/settings?toast=success&msg={Uri.EscapeDataString(message)}");
}