using BCookieSubs.Shared.Grpc;
using Grpc.Core;

namespace BCookieSubs.Web.Services;

public class OrchestrationWatcherService(
    OrchestrationClient client,
    WorkersStatusBroadcaster broadcaster,
    LibraryStatusBroadcaster libraryBroadcaster,
    DashboardStatusBroadcaster dashboardBroadcaster,
    ILogger<OrchestrationWatcherService> logger) : BackgroundService
{
    private static readonly TimeSpan RetryDelay = TimeSpan.FromSeconds(3);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await client.ProbeAsync(stoppingToken))
                {
                    await Task.Delay(RetryDelay, stoppingToken);
                    continue;
                }

                using var call = client.WatchEvents(new WatchEventsRequest(), stoppingToken);
                await foreach (var evt in call.ResponseStream.ReadAllAsync(stoppingToken))
                {
                    if (evt.Type == OrchestrationEventType.LibraryScan)
                    {
                        await libraryBroadcaster.BroadcastScanEventAsync(evt.Detail, stoppingToken);
                    }
                    else if (evt.Type >= OrchestrationEventType.TranslationChanged)
                    {
                        await dashboardBroadcaster.BroadcastWorkerDashboardEventAsync(evt.Type, evt.Detail, stoppingToken);
                    }
                    else
                    {
                        await broadcaster.BroadcastWorkerEventAsync(evt.WorkerId, evt.Type.ToString(), evt.Detail, stoppingToken);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (RpcException ex) when (ex.StatusCode == StatusCode.Unavailable)
            {
                logger.LogDebug("Orchestration stream unavailable; retrying");
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Orchestration watch failed; retrying");
            }

            try
            {
                await Task.Delay(RetryDelay, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}