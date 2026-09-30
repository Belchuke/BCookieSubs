using BCookieSubs.Web.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BCookieSubs.Web.Services;

public class WorkersStatusBroadcaster(IHubContext<WorkersHub> hubContext)
{
    public Task BroadcastWorkerEventAsync(long workerId, string eventType, string detail, CancellationToken ct = default) =>
        hubContext.Clients.Group(WorkersHub.WorkersGroup).SendAsync(
            "workerEvent",
            new { workerId, eventType, detail },
            ct);
}