using System.Security.Claims;
using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.DependencyInjection;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Hubs;
using BCookieSubs.Web.Middleware;
using BCookieSubs.Web.Security;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables();

var workerSigningKey = builder.Configuration["Worker:SigningKey"];
if (string.IsNullOrWhiteSpace(workerSigningKey) || System.Text.Encoding.UTF8.GetByteCount(workerSigningKey) < 32)
{
    throw new InvalidOperationException(
        "WORKER_JWT_SIGNING_KEY must be set to at least 32 bytes (see .env.example).");
}

builder.Services
    .AddBCookieSubsDatabase(builder.Configuration)
    .AddBCookieSubsRepositories()
    .AddBCookieSubsServices(builder.Configuration)
    .AddBCookieSubsUserManagement();

builder.Services.AddControllersWithViews();
builder.Services.AddSignalR();
builder.Services.AddMemoryCache();
builder.Services.AddHttpContextAccessor();
builder.Services.AddHttpClient();
builder.Services.AddHealthChecks()
    .AddDbContextCheck<BCookieSubsDbContext>("database");

builder.Services.AddSingleton<OrchestrationClient>();
builder.Services.AddSingleton<WorkersStatusBroadcaster>();
builder.Services.AddSingleton<LibraryStatusBroadcaster>();
builder.Services.AddSingleton<DashboardConnectionTracker>();
builder.Services.AddSingleton<DashboardStatusBroadcaster>();
builder.Services.AddSingleton<IDashboardEventPublisher>(sp => sp.GetRequiredService<DashboardStatusBroadcaster>());
builder.Services.AddHostedService<OrchestrationWatcherService>();

builder.Services
    .AddIdentity<ApplicationUser, ApplicationRole>(options =>
    {
        options.Password.RequiredLength = 8;
        options.Password.RequireDigit = true;
        options.Password.RequireUppercase = true;
        options.Password.RequireLowercase = true;
        options.Password.RequireNonAlphanumeric = false;
        options.Lockout.MaxFailedAccessAttempts = 10;
        options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
    })
    .AddEntityFrameworkStores<BCookieSubsDbContext>()
    .AddErrorDescriber<CustomIdentityErrorDescriber>()
    .AddDefaultTokenProviders();

builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.Name = "bcsub_auth";
    options.LoginPath = "/login";
    options.AccessDeniedPath = "/about";
    options.ExpireTimeSpan = TimeSpan.FromDays(14);
    options.SlidingExpiration = true;
    options.EventsType = typeof(DeletedUserCookieEvents);
});
builder.Services.AddScoped<DeletedUserCookieEvents>();

builder.Services.AddAuthorization(options =>
{
    options.AddPolicy(Policies.WorkersView, policy =>
        policy.RequireAuthenticatedUser().AddRequirements(new PermissionRequirement(Permissions.WorkersView)));
    options.AddPolicy(Policies.WorkersManage, policy =>
        policy.RequireAuthenticatedUser().AddRequirements(new PermissionRequirement(Permissions.WorkersManage)));
    options.AddPolicy(Policies.LibraryPages, policy =>
        policy.RequireAuthenticatedUser().AddRequirements(new AnyPermissionRequirement(Policies.LibraryPagePermissions)));
    options.AddPolicy(Policies.PathBrowse, policy =>
        policy.RequireAuthenticatedUser().AddRequirements(new AnyPermissionRequirement(
            ["canAddPathForLibraryPaths", "canEditLibraryPath"])));
});
builder.Services.AddSingleton<IAuthorizationPolicyProvider, PermissionPolicyProvider>();
builder.Services.AddScoped<IAuthorizationHandler, PermissionAuthorizationHandler>();
builder.Services.AddScoped<IAuthorizationHandler, AnyPermissionAuthorizationHandler>();
builder.Services.AddScoped<CurrentUserContext>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
    var logger = scope.ServiceProvider.GetRequiredService<ILogger<Program>>();
    await DatabaseInitializer.ApplyMigrationsAsync(db, logger);

    var secrets = scope.ServiceProvider.GetRequiredService<SecretsService>();
    await secrets.SyncFromEnvironmentAsync();

    var configs = scope.ServiceProvider.GetRequiredService<ApplicationConfigRepository>();
    var configRow = await configs.GetAsync();
    if (configRow is not null)
    {
        scope.ServiceProvider.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>()
            .Get(IdentityConstants.ApplicationScheme)
            .ExpireTimeSpan = TimeSpan.FromMinutes(configRow.SessionTimeoutMinutes);
        logger.LogInformation("Session timeout: {Minutes} minutes (from application config)",
            configRow.SessionTimeoutMinutes);
    }
}

app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseMiddleware<FirstRunMiddleware>();
app.UseAuthorization();

app.MapControllers();
app.MapHub<WorkersHub>("/hubs/workers");
app.MapHub<LibraryHub>("/hubs/library");
app.MapHub<DashboardHub>("/hubs/dashboard");
app.MapHealthChecks("/healthz");
app.MapHealthChecks("/health/database", new Microsoft.AspNetCore.Diagnostics.HealthChecks.HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("database")
});

await app.RunAsync();