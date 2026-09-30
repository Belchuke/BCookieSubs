using System.Text;
using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.DependencyInjection;
using BCookieSubs.Shared.Services;
using BCookieSubs.Worker.Maintenance;
using BCookieSubs.Worker.Services;
using BCookieSubs.Worker.Workers;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Options;

if (args.Length > 0 && args[0] == "db-maintenance")
{
    return await DatabaseMaintenanceProgram.RunAsync(args[1..]);
}

var builder = WebApplication.CreateBuilder(args);
builder.Configuration.AddEnvironmentVariables();

var listenPort = builder.Configuration.GetValue("Orchestration:ListenPort", 5100);
builder.WebHost.ConfigureKestrel(options =>
    options.ListenAnyIP(listenPort, listen => listen.Protocols = HttpProtocols.Http2));

builder.Services
    .AddBCookieSubsDatabase(builder.Configuration)
    .AddBCookieSubsRepositories()
    .AddBCookieSubsServices(builder.Configuration);

builder.Services.AddGrpc(options => options.EnableDetailedErrors = false);
builder.Services.AddHealthChecks()
    .AddDbContextCheck<BCookieSubsDbContext>("database");

builder.Services.AddSingleton<WorkerConnectionRegistry>();
builder.Services.AddSingleton<OrchestrationEventBus>();
builder.Services.AddSingleton<IDashboardEventPublisher, WorkerDashboardEventPublisher>();
builder.Services.AddSingleton<WorkerGatewayOrchestrator>();
builder.Services.AddSingleton<LibraryScanCoordinator>();
builder.Services.AddSingleton<TranslationRunnerService>();
builder.Services.AddSingleton<ComputeRunnerState>();
builder.Services.AddHostedService<WorkerHeartbeatMonitor>();
builder.Services.AddHostedService<LibraryScanHostedService>();
builder.Services.AddHostedService<TranslationRunnerHostedService>();
builder.Services.AddHostedService<ComputeJobDispatcher>();

var app = builder.Build();

var jwt = app.Services.GetRequiredService<IOptions<WorkerJwtOptions>>().Value;
var orchestrationOptions = app.Services.GetRequiredService<IOptions<OrchestrationOptions>>().Value;
if (string.IsNullOrWhiteSpace(jwt.SigningKey) || Encoding.UTF8.GetByteCount(jwt.SigningKey) < 32)
{
    throw new InvalidOperationException("Worker:SigningKey is missing or too short (at least 32 bytes required).");
}
if (string.IsNullOrWhiteSpace(orchestrationOptions.ApiKey))
{
    throw new InvalidOperationException("Orchestration:ApiKey is required for the internal Web/Worker channel.");
}

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
    await DatabaseInitializer.ApplyMigrationsAsync(
        db, scope.ServiceProvider.GetRequiredService<ILogger<Program>>());
}

app.MapGrpcService<WorkerGatewayService>();
app.MapGrpcService<OrchestrationService>();
app.MapHealthChecks("/healthz", new HealthCheckOptions
{
    Predicate = _ => true,
    ResultStatusCodes = { [HealthStatus.Healthy] = StatusCodes.Status200OK }
});
app.MapHealthChecks("/health/database", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("database")
});

await app.RunAsync();
return 0;