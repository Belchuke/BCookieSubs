using BCookieSubs.Shared.Services;

namespace BCookieSubs.Worker.Workers;

public class TranslationRunnerHostedService(TranslationRunnerService runner) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        runner.RunAsync(stoppingToken);
}
