using System.Reflection;
using System.Runtime.InteropServices;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;

namespace BCookieSubs.Shared.Services;

public record SystemInfo(
    string AppVersion, string DatabaseProvider, string EnvironmentName, string Runtime, string Os,
    string OllamaBaseUrl, bool OllamaBaseUrlFromEnv, int TotalWorkers, int EnabledWorkers);

public record SetupChecklistItem(string Key, string Label, string Hint, bool Complete);

public class SystemInfoService(
    ApplicationConfigRepository configs,
    UserRepository users,
    WorkerNodeRepository workers,
    ModelRepository models,
    PromptRepository prompts,
    LanguageRepository languages,
    LibraryPathRepository libraryPaths,
    SecretsService secrets)
{
    public SystemInfo GetInfo()
    {
        var assembly = typeof(SystemInfoService).Assembly;
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
                      ?? assembly.GetName().Version?.ToString()
                      ?? "unknown";
        var ollamaBaseUrl = OllamaService.GetBaseUrl();

        return new SystemInfo(
            version,
            configs.GetDatabaseProvider() ?? "unknown",
            Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Production",
            $".NET {Environment.Version}",
            RuntimeInformation.OSDescription,
            ollamaBaseUrl,
            !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(OllamaService.BaseUrlEnvVar)),
            TotalWorkers: 0,
            EnabledWorkers: 0);
    }

    public async Task<SystemInfo> GetInfoAsync(CancellationToken ct = default)
    {
        var info = GetInfo();
        var allWorkers = await workers.GetAllAsync(ct);
        return info with
        {
            TotalWorkers = allWorkers.Count,
            EnabledWorkers = allWorkers.Count(w => w.Enabled)
        };
    }

    public async Task<List<SetupChecklistItem>> GetSetupChecklistAsync(CancellationToken ct = default)
    {
        var usersCount = (await users.GetAllAsync(ct)).Count;
        var workersCount = (await workers.GetAllAsync(ct)).Count(w => w.Enabled);
        var modelsCount = (await models.GetAllAsync(ct)).Count;
        var promptsCount = (await prompts.GetActiveByKindAsync(Database.Enums.PromptKind.Translation, ct)).Count;
        var languagesCount = (await languages.GetDefaultTranslationLanguagesAsync(ct)).Count;
        var libraryPathsCount = (await libraryPaths.GetAllAsync(ct)).Count;

        var secretsConfigured = 0;
        try
        {
            secretsConfigured = (await secrets.GetAllAsync(ct)).Count(s => s.Ciphertext.Length > 0);
        }
        catch (InvalidOperationException)
        {
        }

        return
        [
            new("users", "Owner account created", "The first user becomes the Owner.", usersCount > 0),
            new("workers", "Worker enrolled", "At least one enabled worker node is enrolled.", workersCount > 0),
            new("models", "Model added", "At least one translation model is configured.", modelsCount > 0),
            new("prompts", "Translation prompt active", "At least one active translation prompt exists.", promptsCount > 0),
            new("languages", "Target languages configured", "At least one global target language is selected.", languagesCount > 0),
            new("secrets", "API keys configured", "At least one API key is stored (TMDB, Ollama, ...).", secretsConfigured > 0),
            new("library", "Library path added", "A library path enables library workflows later.", libraryPathsCount > 0)
        ];
    }
}