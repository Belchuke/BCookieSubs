using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Storage;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace BCookieSubs.Shared.DependencyInjection;

public static class BCookieSubsServiceCollectionExtensions
{
    public static IServiceCollection AddBCookieSubsDatabase(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<BCookieSubsDbContext>(options =>
            options.UseNpgsql(
                configuration.GetConnectionString("Default"),
                sql => sql.MigrationsAssembly(typeof(BCookieSubsDbContext).Assembly.FullName)));
        return services;
    }

    public static IServiceCollection AddBCookieSubsRepositories(this IServiceCollection services)
    {
        services.TryAddScoped<WorkerNodeRepository>();
        services.TryAddScoped<WorkerEnrollmentRepository>();
        services.TryAddScoped<WorkerCredentialRepository>();
        services.TryAddScoped<ApplicationConfigRepository>();
        services.TryAddScoped<ThemeRepository>();
        services.TryAddScoped<LanguageRepository>();
        services.TryAddScoped<ModelRepository>();
        services.TryAddScoped<PromptRepository>();
        services.TryAddScoped<ScheduleRepository>();
        services.TryAddScoped<MediaItemRepository>();
        services.TryAddScoped<LibraryPathRepository>();
        services.TryAddScoped<LibraryPathItemRepository>();
        services.TryAddScoped<SubtitleRepository>();
        services.TryAddScoped<SubtitleJobRepository>();
        services.TryAddScoped<SubtitleChunkRepository>();
        services.TryAddScoped<SubtitlePipelineRepository>();
        services.TryAddScoped<StatsRepository>();
        services.TryAddScoped<JudgeEvaluationRepository>();
        services.TryAddScoped<WorkerJobRepository>();
        services.TryAddScoped<ApplicationLogRepository>();
        services.TryAddScoped<UserRepository>();
        services.TryAddScoped<ExportedSubtitleFileRepository>();
        services.TryAddScoped<TranslatedLibraryItemRepository>();
        return services;
    }

    public static IServiceCollection AddBCookieSubsServices(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddHttpClient();

        services.Configure<OrchestrationOptions>(configuration.GetSection(OrchestrationOptions.SectionName));
        services.Configure<WorkerJwtOptions>(configuration.GetSection(WorkerJwtOptions.SectionName));
        services.Configure<SecretEncryptionOptions>(options =>
            options.MasterKey = configuration[SecretEncryptionOptions.EnvVarName]);
        services.TryAddScoped<SecretsService>();
        services.TryAddScoped<DatabaseMaintenanceService>();
        services.TryAddScoped<PermissionService>();
        services.TryAddScoped<AuditService>();
        services.TryAddScoped<ConfigService>();
        services.TryAddScoped<TranslationLanguageService>();
        services.TryAddScoped<ThemeService>();
        services.TryAddScoped<OllamaService>();
        services.TryAddScoped<ModelService>();
        services.TryAddScoped<PromptService>();
        services.TryAddScoped<SystemInfoService>();
        services.TryAddScoped<WorkerEnrollmentService>();
        services.TryAddScoped<WorkerNodeService>();
        services.TryAddScoped<WorkerAuthenticationService>();

        services.TryAddScoped<TheMovieDbService>();
        services.TryAddScoped<LlmChatService>();
        services.TryAddSingleton<MediaPhotosService>();
        services.TryAddScoped<MediaItemService>();
        services.TryAddScoped<LibraryMatchingService>();
        services.TryAddScoped<LibraryScannerService>();
        services.TryAddScoped<LibraryPathsService>();
        services.TryAddScoped<ILibraryFileSystemFactory, LibraryFileSystemFactory>();
        services.TryAddScoped<LibraryRequestsService>();
        services.TryAddScoped<SubtitleTaskService>();
        services.TryAddScoped<LibraryAutoTranslateService>();
        services.TryAddScoped<LibrarySubtitleExportService>();
        services.TryAddScoped<TranslationAssemblyService>();
        services.TryAddScoped<TranslationLlmClient>();
        services.TryAddScoped<ComputeJobService>();
        services.TryAddScoped<ScheduleService>();

        services.TryAddSingleton<ProcessRunnerService>();
        services.TryAddSingleton<FFprobeService>();
        services.TryAddSingleton<FFmpegService>();
        services.TryAddSingleton<MkvToolNixService>();
        services.TryAddSingleton<MediaProbeService>();

        services.TryAddSingleton<IDashboardEventPublisher, NoopDashboardEventPublisher>();
        return services;
    }

    public static IServiceCollection AddBCookieSubsUserManagement(this IServiceCollection services)
    {
        services.TryAddScoped<UserManagementService>();
        services.TryAddScoped<RoleManagementService>();
        services.TryAddScoped<ProfileService>();
        services.TryAddScoped<ISetupService, SetupService>();
        return services;
    }
}