using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services;

namespace BCookieSubs.Worker.Services;

public class LibraryScanCoordinator(
    IServiceScopeFactory scopeFactory,
    OrchestrationEventBus eventBus,
    IDashboardEventPublisher dashboardEvents,
    ILogger<LibraryScanCoordinator> logger)
{
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan StuckScanThreshold = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan RescanPollInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ProgressPublishInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(60);

    public async Task RunAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        logger.LogInformation("Library scanner started");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunScannerOnceAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Library scanner loop crashed");
            }

            try
            {
                await Task.Delay(TickInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        logger.LogInformation("Library scanner stopped");
    }

    private async Task RunScannerOnceAsync(CancellationToken stoppingToken)
    {
        await using (var scope = scopeFactory.CreateAsyncScope())
        {
            var configs = scope.ServiceProvider.GetRequiredService<ApplicationConfigRepository>();
            var config = await configs.GetAsync(stoppingToken);
            if (config is not { ScanLibraryPaths: true }) return;

            var libraryPaths = scope.ServiceProvider.GetRequiredService<LibraryPathRepository>();
            var stuck = await libraryPaths.GetStuckScanningAsync(
                DateTime.UtcNow - StuckScanThreshold, stoppingToken);
            foreach (var lp in stuck)
            {
                try
                {
                    await libraryPaths.SetStateAsync(lp.Id, LibraryPathState.Error, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Failed to recover stuck scan for path {Id}", lp.Id);
                    continue;
                }

                await LogSafeAsync(scope.ServiceProvider.GetRequiredService<ApplicationLogRepository>(), new ApplicationLog
                {
                    Level = LogLevelKind.Error,
                    Type = "scanFailed",
                    EntityType = "libraryScanner",
                    EntityId = lp.Id,
                    Message = $"Library path \"{lp.Name}\" scan stopped responding (no heartbeat for over {StuckScanThreshold.TotalMinutes} minutes) — marked as error",
                    Metadata = System.Text.Json.JsonSerializer.Serialize(new { name = lp.Name, lastRunAt = lp.LastRunAt }),
                    CreatedAt = DateTime.UtcNow,
                }, stoppingToken);
                PublishScanEvent(lp, "failed", 0, 0);
                logger.LogWarning("Path \"{Name}\" stuck in scanning > {Minutes}min — marked error",
                    lp.Name, StuckScanThreshold.TotalMinutes);
            }
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var dueIds = await GetDuePathIdsAsync(stoppingToken);
            if (dueIds.Count == 0) break;

            foreach (var pathId in dueIds)
            {
                if (stoppingToken.IsCancellationRequested) break;
                try
                {
                    await ScanPathWithRestartAsync(pathId, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Unhandled scan coordinator error for path {Id}", pathId);
                }
            }
        }
    }

    private async Task<List<long>> GetDuePathIdsAsync(CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var libraryPaths = scope.ServiceProvider.GetRequiredService<LibraryPathRepository>();
        var candidates = await libraryPaths.GetEnabledNotScanningAsync(ct);
        var now = DateTime.UtcNow;
        return candidates
            .Where(lp => LibraryScanSchedule.IsDue(lp, now))
            .Select(lp => lp.Id)
            .ToList();
    }

    private async Task ScanPathWithRestartAsync(long pathId, CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            LibraryPath? fresh;
            await using (var scope = scopeFactory.CreateAsyncScope())
            {
                var libraryPaths = scope.ServiceProvider.GetRequiredService<LibraryPathRepository>();
                fresh = await libraryPaths.GetAsync(pathId, stoppingToken);
            }
            if (fresh == null || !fresh.Enabled) return;

            var wasInitial = !fresh.InitialScanCompleted;

            await using var scanScope = scopeFactory.CreateAsyncScope();
            var scanPaths = scanScope.ServiceProvider.GetRequiredService<LibraryPathRepository>();
            var logs = scanScope.ServiceProvider.GetRequiredService<ApplicationLogRepository>();
            if (!await scanPaths.TryClaimScanAsync(pathId, stoppingToken)) return;

            using var scanCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            var watcher = WatchForRescanAsync(pathId, scanCts);
            var startedAt = DateTime.UtcNow;
            PublishScanEvent(fresh, "started", 0, 0);
            var lastProgressUtc = DateTime.MinValue;
            Action<LibraryScannerService.LibraryScanProgress> onProgress = p =>
            {
                if (p.Phase != "done" && DateTime.UtcNow - lastProgressUtc < ProgressPublishInterval) return;
                lastProgressUtc = DateTime.UtcNow;
                PublishScanEvent(p.LibraryPathId, p.Name, p.Phase, p.Processed, p.Total);
            };
            var finalized = false;
            try
            {
                try
                {
                    var scanner = scanScope.ServiceProvider.GetRequiredService<LibraryScannerService>();
                    await scanner.ScanAsync(fresh, scanCts.Token, onProgress);
                }
                catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
                {
                    await scanPaths.SetStateAsync(pathId, LibraryPathState.Idle, CancellationToken.None);
                    finalized = true;
                    await LogSafeAsync(logs, new ApplicationLog
                    {
                        Level = LogLevelKind.Info,
                        Type = "scanAborted",
                        EntityType = "libraryScanner",
                        EntityId = pathId,
                        Message = $"Scan of library path \"{fresh.Name}\" aborted by rescan — restarting from the beginning",
                        Metadata = System.Text.Json.JsonSerializer.Serialize(new { name = fresh.Name, path = fresh.Path }),
                        CreatedAt = DateTime.UtcNow,
                    }, stoppingToken);
                    PublishScanEvent(fresh, "aborted", 0, 0);
                    await watcher;
                    continue;
                }
                catch (OperationCanceledException)
                {
                    await watcher;
                    return;
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Scan error for \"{Name}\"", fresh.Name);
                    await scanPaths.SetStateAsync(pathId, LibraryPathState.Error, CancellationToken.None);
                    finalized = true;
                    await LogSafeAsync(logs, new ApplicationLog
                    {
                        Level = LogLevelKind.Error,
                        Type = "scanFailed",
                        EntityType = "libraryScanner",
                        EntityId = pathId,
                        Message = $"Scan failed for library path \"{fresh.Name}\": {Truncate(ex.ToString(), 2000)}",
                        Metadata = System.Text.Json.JsonSerializer.Serialize(new { name = fresh.Name, path = fresh.Path }),
                        CreatedAt = DateTime.UtcNow,
                    }, stoppingToken);
                    PublishScanEvent(fresh, "failed", 0, 0);
                    await watcher;
                    return;
                }

                await scanCts.CancelAsync();
                await watcher;
                await scanPaths.SetStateAsync(pathId, LibraryPathState.Idle, CancellationToken.None);
                finalized = true;
                PublishScanEvent(fresh, "completed", 0, 0);
                try
                {
                    await scanPaths.RecordScanDurationAsync(
                        pathId, (long)(DateTime.UtcNow - startedAt).TotalMilliseconds, wasInitial,
                        CancellationToken.None);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Failed to record scan duration for path {Id}", pathId);
                }
                return;
            }
            finally
            {
                if (!finalized)
                {
                    await scanCts.CancelAsync();
                    try
                    {
                        await watcher;
                    }
                    catch
                    {
                    }
                    try
                    {
                        await scanPaths.ResetForRescanAsync(pathId, CancellationToken.None);
                    }
                    catch (Exception ex)
                    {
                        logger.LogError(ex,
                            "Failed to release scan claim for path {Id} — leaving it for stale-scan recovery", pathId);
                    }
                }
            }
        }
    }

    private void PublishScanEvent(long pathId, string name, string phase, int processed, int total)
    {
        eventBus.Publish(OrchestrationEventType.LibraryScan, 0, System.Text.Json.JsonSerializer.Serialize(new
        {
            libraryPathId = pathId,
            name,
            phase,
            processed,
            total,
        }));

        if (phase is "completed" or "failed" or "aborted")
            dashboardEvents.LibraryRequestsChanged();
    }

    private void PublishScanEvent(LibraryPath path, string phase, int processed, int total) =>
        PublishScanEvent(path.Id, path.Name, phase, processed, total);

    private async Task WatchForRescanAsync(long pathId, CancellationTokenSource scanCts)
    {
        try
        {
            using var timer = new PeriodicTimer(RescanPollInterval);
            var lastHeartbeatUtc = DateTime.UtcNow;
            while (!scanCts.IsCancellationRequested && await timer.WaitForNextTickAsync(scanCts.Token))
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var libraryPaths = scope.ServiceProvider.GetRequiredService<LibraryPathRepository>();
                if (DateTime.UtcNow - lastHeartbeatUtc >= HeartbeatInterval)
                {
                    lastHeartbeatUtc = DateTime.UtcNow;
                    try
                    {
                        await libraryPaths.TouchScanHeartbeatAsync(pathId, scanCts.Token);
                    }
                    catch (OperationCanceledException)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        logger.LogWarning(ex, "Scan heartbeat write failed for path {Id}", pathId);
                    }
                }
                var lp = await libraryPaths.GetAsync(pathId, scanCts.Token);
                if (lp == null || lp.State != LibraryPathState.Scanning)
                {
                    await scanCts.CancelAsync();
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task LogSafeAsync(ApplicationLogRepository logs, ApplicationLog log, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(log, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to write scan log {Type} for entity {EntityId}", log.Type, log.EntityId);
        }
    }

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}