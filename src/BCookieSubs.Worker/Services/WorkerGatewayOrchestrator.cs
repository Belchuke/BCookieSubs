using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Repositories;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Worker.Services;

public class WorkerGatewayOrchestrator(
    IServiceScopeFactory scopeFactory,
    WorkerConnectionRegistry registry,
    OrchestrationEventBus events,
    ILogger<WorkerGatewayOrchestrator> logger)
{
    public const int HeartbeatIntervalSeconds = 10;
    public static readonly TimeSpan HeartbeatTimeout = TimeSpan.FromSeconds(45);

    public async Task OnSessionRegisteredAsync(WorkerSession session, BCookieSubs.Shared.Database.Entities.WorkerNode node, ClientMessage first)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var nodes = scope.ServiceProvider.GetRequiredService<WorkerNodeRepository>();

        var isAuth = first.PayloadCase == BCookieSubs.Shared.Grpc.ClientMessage.PayloadOneofCase.Auth;
        var reported = isAuth ? first.Auth.Capabilities : first.Enroll.Capabilities;
        var hardware = isAuth ? first.Auth.Hardware : first.Enroll.Hardware;
        var reportedConcurrency = isAuth ? first.Auth.MaxConcurrency : first.Enroll.MaxConcurrency;

        node.WorkerVersion = session.WorkerVersion is { Length: > 0 } ? session.WorkerVersion : node.WorkerVersion;
        node.MachineIdentifier = session.MachineIdentifier is { Length: > 0 } ? session.MachineIdentifier : node.MachineIdentifier;
        node.ReportedCapabilities = CapabilityNames.Normalize(reported).ToList();
        node.Hardware = hardware is not null ? hardware.ToHardware() : node.Hardware;
        if (reportedConcurrency > 0)
        {
            node.MaxConcurrency = Math.Clamp(reportedConcurrency, 1, 64);
        }
        await nodes.UpdateRegistrationAsync(node);
        session.MaxConcurrency = node.MaxConcurrency;

        await nodes.SetLastConnectedAsync(session.WorkerId, DateTime.UtcNow);

        registry.ReplaceForWorker(session.WorkerId);
        registry.Add(session);

        events.Publish(OrchestrationEventType.Connected, session.WorkerId, "gateway stream connected");

        await session.SendAsync(new ServerMessage
        {
            ConfigUpdate = new ConfigUpdate
            {
                AllowedCapabilities = { node.AllowedCapabilities },
                HeartbeatIntervalSeconds = HeartbeatIntervalSeconds,
                Draining = node.Draining
            }
        });

        if (node.Draining)
        {
            await session.SendAsync(new ServerMessage
            {
                Drain = new DrainCommand { Reason = "worker is draining" }
            });
        }
    }

    public async Task OnSessionClosedAsync(WorkerSession session)
    {
        registry.Remove(session.ConnectionId);
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var nodes = scope.ServiceProvider.GetRequiredService<WorkerNodeRepository>();
            await nodes.SetLastDisconnectedAsync(session.WorkerId, DateTime.UtcNow);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not persist disconnect state for worker {WorkerId}", session.WorkerId);
        }

        events.Publish(OrchestrationEventType.Disconnected, session.WorkerId, "gateway stream closed");
    }

    public async Task ApplyDurableChangeAsync(long workerId, string changeDetail)
    {
        var session = registry.GetForWorker(workerId);
        if (session is null)
        {
            return;
        }

        await using var scope = scopeFactory.CreateAsyncScope();
        var nodes = scope.ServiceProvider.GetRequiredService<WorkerNodeRepository>();
        var node = await nodes.GetAsync(workerId);
        if (node is null || !node.Enabled)
        {
            session.Terminate(node is null ? "worker removed by administrator" : "worker disabled by administrator");
            events.Publish(OrchestrationEventType.StateChanged, workerId, changeDetail);
            return;
        }

        try
        {
            await session.SendAsync(new ServerMessage
            {
                ConfigUpdate = new ConfigUpdate
                {
                    AllowedCapabilities = { node.AllowedCapabilities },
                    HeartbeatIntervalSeconds = HeartbeatIntervalSeconds,
                    Draining = node.Draining
                }
            });
            await session.SendAsync(node.Draining
                ? new ServerMessage { Drain = new DrainCommand { Reason = "worker is draining" } }
                : new ServerMessage { Resume = new ResumeCommand() });
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not push config update to worker {WorkerId}", workerId);
        }

        events.Publish(OrchestrationEventType.ConfigChanged, workerId, changeDetail);
    }

    public async Task PersistHeartbeatsAsync()
    {
        var now = DateTime.UtcNow;
        var sessions = registry.Snapshot().Where(s => s.LastPersistedSeenAt is null || now - s.LastPersistedSeenAt >= TimeSpan.FromSeconds(30)).ToList();
        foreach (var session in sessions)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var nodes = scope.ServiceProvider.GetRequiredService<WorkerNodeRepository>();
                await nodes.UpdateLastSeenAsync(session.WorkerId, session.LastHeartbeatAt);
                session.LastPersistedSeenAt = now;
                events.Publish(OrchestrationEventType.Heartbeat, session.WorkerId, "heartbeat persisted");
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Could not persist heartbeat for worker {WorkerId}", session.WorkerId);
            }
        }
    }

    public void EnforceHeartbeatTimeout()
    {
        var now = DateTime.UtcNow;
        foreach (var session in registry.Snapshot())
        {
            if (now - session.LastHeartbeatAt > HeartbeatTimeout)
            {
                logger.LogWarning("Worker {WorkerId} heartbeat timed out; closing connection", session.WorkerId);
                session.Terminate("heartbeat timeout");
            }
        }
    }
}