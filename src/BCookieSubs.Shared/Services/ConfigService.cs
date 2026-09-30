using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;

using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public class ConfigService(
    ApplicationConfigRepository configs,
    UserRepository users,
    LanguageRepository languages,
    ThemeRepository themes,
    AuditService audit)
{
    public static readonly IReadOnlyList<string> WhisperModels =
    [
        "tiny", "tiny.en", "base", "base.en", "small", "small.en",
        "medium", "medium.en", "large-v1", "large", "large-v3-turbo"
    ];

    public const string FallbackLanguage = "en";
    public const string FallbackAssFont = "Garuda";

    public static bool IsWhisperGpuAvailable() =>
        Environment.GetEnvironmentVariable("WHISPER_GPU_AVAILABLE") is "1" or "true";

    public Task<ApplicationConfig?> GetAsync(CancellationToken ct = default) => configs.GetAsync(ct);

    public async Task<string?> UpdateGeneralFormAsync(
        int chunkSize, int maxRetries, int sessionTimeoutMinutes, bool finishSingleFirst,
        bool nameDetectionActive, bool showPosters, bool tmdbActive, bool scheduleConfigured,
        bool scanLibraryPaths, bool deleteNotCancel, bool clearLogs, int clearLogsOlderThanDays,
        string? rootLibraryPath, bool updateRootLibraryPath, CancellationToken ct = default)
    {
        if (chunkSize is < 1 or > 200)
        {
            return "Chunk size must be between 1 and 200";
        }

        if (maxRetries is < 0 or > 20)
        {
            return "Max retries per chunk must be between 0 and 20";
        }

        if (sessionTimeoutMinutes is < 5 or > 525600)
        {
            return "Session timeout must be between 5 and 525600 minutes";
        }

        if (clearLogsOlderThanDays is < 1 or > 3650)
        {
            return "Log retention days must be between 1 and 3650";
        }

        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        if (!nameDetectionActive)
        {
            showPosters = false;
            tmdbActive = false;
        }

        if (config.DefaultChunkSize != chunkSize) config.DefaultChunkSize = chunkSize;
        if (config.MaxRetriesPerChunk != maxRetries) config.MaxRetriesPerChunk = maxRetries;
        if (config.SessionTimeoutMinutes != sessionTimeoutMinutes) config.SessionTimeoutMinutes = sessionTimeoutMinutes;
        if (config.FinishSingleSubtitleFirst != finishSingleFirst) config.FinishSingleSubtitleFirst = finishSingleFirst;
        if (config.NameDetectionActive != nameDetectionActive) config.NameDetectionActive = nameDetectionActive;
        if (config.ShowPosters != showPosters) config.ShowPosters = showPosters;
        if (config.TheMovieDbActive != tmdbActive) config.TheMovieDbActive = tmdbActive;
        if (config.ScheduleConfigured != scheduleConfigured) config.ScheduleConfigured = scheduleConfigured;
        if (config.ScanLibraryPaths != scanLibraryPaths) config.ScanLibraryPaths = scanLibraryPaths;
        if (config.DeleteNotCancel != deleteNotCancel) config.DeleteNotCancel = deleteNotCancel;
        if (config.ClearLogs != clearLogs) config.ClearLogs = clearLogs;
        if (config.ClearLogsOlderThanDays != clearLogsOlderThanDays) config.ClearLogsOlderThanDays = clearLogsOlderThanDays;
        if (updateRootLibraryPath)
        {
            var root = string.IsNullOrWhiteSpace(rootLibraryPath) ? null : rootLibraryPath.Trim();
            if (config.RootLibraryPath != root) config.RootLibraryPath = root;
        }

        return await SaveIfChangedAsync(config, "general settings", ct);
    }

    public async Task<string?> UpdateTranslationAsync(int chunkSize, int maxRetries, bool finishSingleFirst,
        bool deleteNotCancel, string assFont, CancellationToken ct = default)
    {
        if (chunkSize is < 1 or > 200)
        {
            return "Chunk size must be between 1 and 200";
        }

        if (maxRetries is < 0 or > 20)
        {
            return "Max retries per chunk must be between 0 and 20";
        }

        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        var font = string.IsNullOrWhiteSpace(assFont) ? FallbackAssFont : assFont.Trim();
        if (config.DefaultChunkSize != chunkSize) config.DefaultChunkSize = chunkSize;
        if (config.MaxRetriesPerChunk != maxRetries) config.MaxRetriesPerChunk = maxRetries;
        if (config.FinishSingleSubtitleFirst != finishSingleFirst) config.FinishSingleSubtitleFirst = finishSingleFirst;
        if (config.DeleteNotCancel != deleteNotCancel) config.DeleteNotCancel = deleteNotCancel;
        if (config.ThaiAssFont != font) config.ThaiAssFont = font;

        return await SaveIfChangedAsync(config, "translation settings", ct);
    }

    public async Task<string?> UpdateGeneralAsync(int sessionTimeoutMinutes, string defaultLanguage,
        CancellationToken ct = default)
    {
        if (sessionTimeoutMinutes is < 5 or > 525600)
        {
            return "Session timeout must be between 5 and 525600 minutes";
        }

        var language = string.IsNullOrWhiteSpace(defaultLanguage) ? FallbackLanguage : defaultLanguage.Trim();
        if (!await IsKnownLanguageAsync(language, ct))
        {
            return "Unsupported language";
        }

        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        if (config.SessionTimeoutMinutes != sessionTimeoutMinutes) config.SessionTimeoutMinutes = sessionTimeoutMinutes;
        if (config.DefaultLanguage != language) config.DefaultLanguage = language;

        return await SaveIfChangedAsync(config, "general settings", ct);
    }

    public async Task<string?> UpdateLibraryAsync(bool scanLibraryPaths, string? rootLibraryPath,
        CancellationToken ct = default)
    {
        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        var root = string.IsNullOrWhiteSpace(rootLibraryPath) ? null : rootLibraryPath.Trim();
        if (config.ScanLibraryPaths != scanLibraryPaths) config.ScanLibraryPaths = scanLibraryPaths;
        if (config.RootLibraryPath != root) config.RootLibraryPath = root;

        return await SaveIfChangedAsync(config, "library settings", ct);
    }

    public async Task<string?> UpdateMediaAsync(bool nameDetectionActive, bool showPosters, bool tmdbActive,
        CancellationToken ct = default)
    {
        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        if (!nameDetectionActive)
        {
            showPosters = false;
            tmdbActive = false;
        }

        if (config.NameDetectionActive != nameDetectionActive) config.NameDetectionActive = nameDetectionActive;
        if (config.ShowPosters != showPosters) config.ShowPosters = showPosters;
        if (config.TheMovieDbActive != tmdbActive) config.TheMovieDbActive = tmdbActive;

        return await SaveIfChangedAsync(config, "media settings", ct);
    }

    public async Task<string?> UpdateWhisperAsync(string whisperModel, int timestampsLength, bool useCuda,
        bool enabled, bool runAsSeparateTask, string? modelRootPath, CancellationToken ct = default)
    {
        var model = WhisperModels.Contains(whisperModel) ? whisperModel : "large-v3-turbo";
        if (timestampsLength is < 1 or > 500)
        {
            return "Whisper timestamps length must be between 1 and 500";
        }

        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        var root = string.IsNullOrWhiteSpace(modelRootPath) ? null : modelRootPath.Trim();
        if (config.WhisperModel != model) config.WhisperModel = model;
        if (config.WhisperTimestampsLength != timestampsLength) config.WhisperTimestampsLength = timestampsLength;
        if (config.WhisperUseCuda != useCuda) config.WhisperUseCuda = useCuda;
        if (config.WhisperEnabled != enabled) config.WhisperEnabled = enabled;
        if (config.WhisperRunAsSeparateTask != runAsSeparateTask) config.WhisperRunAsSeparateTask = runAsSeparateTask;
        if (config.WhisperModelRootPath != root) config.WhisperModelRootPath = root;

        return await SaveIfChangedAsync(config, "whisper settings", ct);
    }

    public async Task<string?> UpdateLogsAsync(bool retentionEnabled, int retentionDays,
        CancellationToken ct = default)
    {
        if (retentionDays is < 1 or > 3650)
        {
            return "Log retention days must be between 1 and 3650";
        }

        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        if (config.LogRetentionEnabled != retentionEnabled) config.LogRetentionEnabled = retentionEnabled;
        if (config.LogRetentionDays != retentionDays) config.LogRetentionDays = retentionDays;

        return await SaveIfChangedAsync(config, "log settings", ct);
    }

    public async Task<string?> UpdateThemeAsync(long themeId, long actingUserId, CancellationToken ct = default)
    {
        var theme = await themes.GetAsync(themeId, ct);
        if (theme is null)
        {
            return "Theme not found";
        }

        var config = await configs.GetAsync(ct);
        if (config is null)
        {
            return "Application configuration not found";
        }

        if (config.SelectedThemeId != themeId)
        {
            config.SelectedThemeId = themeId;
            await SaveIfChangedAsync(config, "default theme", ct);
        }

        await users.SetSelectedThemeAsync(actingUserId, themeId, ct);
        return null;
    }

    public async Task MarkSetupCompletedAsync(bool enableNameDetection, CancellationToken ct = default)
    {
        for (var attempt = 0; ; attempt++)
        {
            var config = await configs.GetAsync(ct);
            if (config is null)
            {
                return;
            }

            if (enableNameDetection && !config.NameDetectionActive) config.NameDetectionActive = true;
            config.SetupCompleted = true;
            config.UpdatedAt = DateTime.UtcNow;
            try
            {
                await configs.SaveAsync(ct);
                return;
            }
            catch (DbUpdateConcurrencyException) when (attempt < 2)
            {
            }
        }
    }

    private async Task<bool> IsKnownLanguageAsync(string value, CancellationToken ct)
    {
        var all = await languages.GetAllAsync(ct);
        return all.Any(l =>
            string.Equals(l.Iso639, value, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(l.Locale, value, StringComparison.OrdinalIgnoreCase));
    }

    private async Task<string?> SaveIfChangedAsync(ApplicationConfig config, string what, CancellationToken ct)
    {
        if (!configs.HasChanges())
        {
            return null;
        }

        config.UpdatedAt = DateTime.UtcNow;
        try
        {
            await configs.SaveAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return "Configuration was updated by someone else; reload the settings page and try again";
        }

        await audit.AdminActionAsync("configUpdated", "applicationConfig", config.Id, $"Updated {what}");
        return null;
    }
}