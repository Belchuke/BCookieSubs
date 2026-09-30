using BCookieSubs.Shared.Database.Configurations;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Database;

public class BCookieSubsDbContext(DbContextOptions<BCookieSubsDbContext> options)
    : IdentityDbContext<ApplicationUser, ApplicationRole, long>(options)
{
    public DbSet<WorkerNode> WorkerNodes => Set<WorkerNode>();
    public DbSet<WorkerEnrollment> WorkerEnrollments => Set<WorkerEnrollment>();
    public DbSet<WorkerCredential> WorkerCredentials => Set<WorkerCredential>();
    public DbSet<Theme> Themes => Set<Theme>();
    public DbSet<Language> Languages => Set<Language>();
    public DbSet<ConfigTranslationLanguage> ConfigTranslationLanguages => Set<ConfigTranslationLanguage>();
    public DbSet<UserConfigTranslationLanguage> UserConfigTranslationLanguages => Set<UserConfigTranslationLanguage>();
    public DbSet<Model> Models => Set<Model>();
    public DbSet<RecommendedModel> RecommendedModels => Set<RecommendedModel>();
    public DbSet<ModelRole> ModelRoles => Set<ModelRole>();
    public DbSet<Prompt> Prompts => Set<Prompt>();
    public DbSet<PromptVersion> PromptVersions => Set<PromptVersion>();
    public DbSet<PromptStat> PromptStats => Set<PromptStat>();
    public DbSet<JudgeEvaluation> JudgeEvaluations => Set<JudgeEvaluation>();
    public DbSet<ApplicationConfig> ApplicationConfig => Set<ApplicationConfig>();
    public DbSet<ApplicationSecret> ApplicationSecrets => Set<ApplicationSecret>();
    public DbSet<Schedule> Schedules => Set<Schedule>();
    public DbSet<Permission> Permissions => Set<Permission>();
    public DbSet<MediaItem> MediaItems => Set<MediaItem>();
    public DbSet<LibraryPath> LibraryPaths => Set<LibraryPath>();
    public DbSet<LibraryPathItem> LibraryPathItems => Set<LibraryPathItem>();
    public DbSet<LibraryPathItemBlacklist> LibraryPathItemBlacklist => Set<LibraryPathItemBlacklist>();
    public DbSet<LibraryPathItemCandidate> LibraryPathItemCandidates => Set<LibraryPathItemCandidate>();
    public DbSet<LibraryPathItemSubtitleSource> LibraryPathItemSubtitleSources => Set<LibraryPathItemSubtitleSource>();
    public DbSet<Subtitle> Subtitles => Set<Subtitle>();
    public DbSet<SubtitleJob> SubtitleJobs => Set<SubtitleJob>();
    public DbSet<SubtitleChunk> SubtitleChunks => Set<SubtitleChunk>();
    public DbSet<SubtitleChunkCandidate> SubtitleChunkCandidates => Set<SubtitleChunkCandidate>();
    public DbSet<WorkerJob> WorkerJobs => Set<WorkerJob>();
    public DbSet<ExportedSubtitleFile> ExportedSubtitleFiles => Set<ExportedSubtitleFile>();
    public DbSet<TranslatedLibraryItem> TranslatedLibraryItems => Set<TranslatedLibraryItem>();
    public DbSet<ApplicationLog> ApplicationLogs => Set<ApplicationLog>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.ApplyConfigurationsFromAssembly(typeof(BCookieSubsDbContext).Assembly);
    }
}