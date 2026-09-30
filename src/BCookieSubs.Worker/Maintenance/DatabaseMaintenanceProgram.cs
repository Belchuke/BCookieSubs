using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.DependencyInjection;
using BCookieSubs.Shared.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Worker.Maintenance;

public static class DatabaseMaintenanceProgram
{
    public static async Task<int> RunAsync(string[] args)
    {
        int candidateDays = 14, judgeDays = 30;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] is "--candidate-days" or "--judge-days")
            {
                if (++i >= args.Length || !int.TryParse(args[i], out var days) || days < 1)
                {
                    Console.WriteLine("Usage: db-maintenance [--candidate-days <1..>] [--judge-days <1..>]");
                    return 1;
                }
                if (args[i - 1] == "--candidate-days") candidateDays = days;
                else judgeDays = days;
            }
            else
            {
                Console.WriteLine($"Unknown argument '{args[i]}'.");
                return 1;
            }
        }

        var services = new ServiceCollection();
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true)
            .AddEnvironmentVariables()
            .Build();
        services.AddSingleton<IConfiguration>(configuration);
        services.AddLogging();
        services.AddBCookieSubsDatabase(configuration)
            .AddBCookieSubsRepositories()
            .AddBCookieSubsServices(configuration);

        await using var provider = services.BuildServiceProvider();
        var maintenance = provider.GetRequiredService<DatabaseMaintenanceService>();
        Console.WriteLine($"Running database maintenance (candidate-days={candidateDays}, judge-days={judgeDays})...");
        var report = await maintenance.RunAsync(candidateDays, judgeDays);
        Console.WriteLine($"Deleted {report.CandidatesDeleted:N0} non-selected candidates, " +
                          $"{report.JudgeEvaluationsDeleted:N0} judge evaluations " +
                          $"in {report.FinishedAt - report.StartedAt:hh\\:mm\\:ss}.");
        return 0;
    }
}