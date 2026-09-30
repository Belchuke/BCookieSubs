using BCookieSubs.Worker.Services;

namespace BCookieSubs.Worker.Workers;

public class WorkerHeartbeatMonitor(WorkerGatewayOrchestrator orchestrator) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await orchestrator.PersistHeartbeatsAsync();
                orchestrator.EnforceHeartbeatTimeout();
            }
            catch (Exception)
            {
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}