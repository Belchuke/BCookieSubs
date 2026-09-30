using BCookieSubs.Worker.Services;

namespace BCookieSubs.Worker.Workers;

public class LibraryScanHostedService(LibraryScanCoordinator coordinator) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        coordinator.RunAsync(stoppingToken);
}