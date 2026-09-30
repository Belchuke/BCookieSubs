using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BCookieSubs.Web.Services;

public class DashboardStatusBroadcaster(
    IHubContext<DashboardHub> hubContext,
    DashboardConnectionTracker connections,
    IServiceScopeFactory scopeFactory,
    ILogger<DashboardStatusBroadcaster> logger) : IDashboardEventPublisher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public void TranslationChanged(long subtitleId) => _ = SafeSend(() => SendRowAsync("translationChanged", subtitleId));
    public void TranslationRemoved(long subtitleId) => Fire("translationRemoved", subtitleId);
    public void WhisperQueueChanged(long subtitleId) => _ = SafeSend(() => SendRowAsync("whisperQueueChanged", subtitleId));
    public void OcrQueueChanged(long? jobId = null) => _ = SafeSend(() => SendOcrAsync(jobId));
    public void LogAdded(long logId) => _ = SafeSend(() => SendLogAsync("logAdded", logId));
    public void LogUpdated(long logId) => _ = SafeSend(() => SendLogAsync("logUpdated", logId));
    public void DashboardCountsChanged() => _ = SafeSend(() => SendQueueCountsAsync());
    public void LibraryRequestsChanged() => _ = SafeSend(() => SendRequestCountsAsync());

    private async Task SafeSend(Func<Task> send)
    {
        try
        {
            await send();
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Dashboard broadcast failed");
        }
    }

    private void Fire(string evt, long? id)
    {
        _ = hubContext.Clients.Group(DashboardHub.DashboardGroup).SendAsync(evt, id);
    }

    private async Task SendRowAsync(string evt, long id, CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var row = await scope.ServiceProvider.GetRequiredService<SubtitleRepository>()
            .GetDashboardSubtitleAsync(id, ct);
        await hubContext.Clients.Group(DashboardHub.DashboardGroup).SendAsync(evt, id, row, ct);
    }

    private async Task SendOcrAsync(long? jobId, CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        if (jobId != null)
        {
            var row = await scope.ServiceProvider.GetRequiredService<WorkerJobRepository>()
                .GetOcrDashboardRowAsync(jobId.Value, ct);
            if (row != null && row.Status is not (WorkerJobStatus.Queued or WorkerJobStatus.Running or WorkerJobStatus.Failed))
                row = null;
            await hubContext.Clients.Group(DashboardHub.DashboardGroup)
                .SendAsync("ocrQueueChanged", jobId, row == null ? null : DashboardPayloads.OcrJob(row), ct);
            return;
        }

        var rows = await scope.ServiceProvider.GetRequiredService<ComputeJobService>()
            .GetOcrJobsForDashboardAsync(ct);
        await hubContext.Clients.Group(DashboardHub.DashboardGroup)
            .SendAsync("ocrQueueChanged", (long?)null, rows.Select(DashboardPayloads.OcrJob).ToList(), ct);
    }

    private async Task SendLogAsync(string evt, long logId, CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var log = await scope.ServiceProvider.GetRequiredService<ApplicationLogRepository>()
            .GetAsync(logId, ct);
        if (log == null) return;
        await hubContext.Clients.Group(DashboardHub.LogsGroup).SendAsync(evt, DashboardPayloads.Log(log), ct);
    }

    private async Task SendQueueCountsAsync(CancellationToken ct = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var counts = await scope.ServiceProvider.GetRequiredService<SubtitleRepository>()
            .GetDashboardQueueCountsAsync(ct);
        await hubContext.Clients.Group(DashboardHub.DashboardGroup)
            .SendAsync("dashboardCountsChanged", DashboardPayloads.QueueCounts(counts), ct);
    }

    private async Task SendRequestCountsAsync(CancellationToken ct = default)
    {
        var userIds = connections.GetDistinctUserIds();
        if (userIds.Count == 0) return;
        await using var scope = scopeFactory.CreateAsyncScope();
        var requests = scope.ServiceProvider.GetRequiredService<LibraryRequestsService>();
        foreach (var userId in userIds)
        {
            LibraryRequestCounts counts;
            try
            {
                counts = await requests.GetCountsAsync(userId, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Request counts failed for user {UserId}", userId);
                continue;
            }
            await hubContext.Clients.User(userId.ToString(CultureInfo.InvariantCulture))
                .SendAsync("libraryRequestsChanged", DashboardPayloads.RequestCounts(counts), ct);
        }
    }

    public async Task BroadcastWorkerDashboardEventAsync(Shared.Grpc.OrchestrationEventType type, string detail,
        CancellationToken ct = default)
    {
        long? id = null;
        try
        {
            if (!string.IsNullOrEmpty(detail))
            {
                var payload = JsonSerializer.Deserialize<IdPayload>(detail, JsonOptions);
                id = payload?.Id;
            }
        }
        catch (JsonException)
        {
        }

        switch (type)
        {
            case Shared.Grpc.OrchestrationEventType.TranslationChanged:
                if (id != null) await SendRowAsync("translationChanged", id.Value, ct);
                break;
            case Shared.Grpc.OrchestrationEventType.TranslationRemoved:
                await hubContext.Clients.Group(DashboardHub.DashboardGroup).SendAsync("translationRemoved", id, ct);
                break;
            case Shared.Grpc.OrchestrationEventType.WhisperQueueChanged:
                if (id != null) await SendRowAsync("whisperQueueChanged", id.Value, ct);
                break;
            case Shared.Grpc.OrchestrationEventType.OcrQueueChanged:
                await SendOcrAsync(id, ct);
                break;
            case Shared.Grpc.OrchestrationEventType.LogAdded:
                if (id != null) await SendLogAsync("logAdded", id.Value, ct);
                break;
            case Shared.Grpc.OrchestrationEventType.LogUpdated:
                if (id != null) await SendLogAsync("logUpdated", id.Value, ct);
                break;
            case Shared.Grpc.OrchestrationEventType.DashboardCountsChanged:
                await SendQueueCountsAsync(ct);
                break;
            case Shared.Grpc.OrchestrationEventType.LibraryRequestsChanged:
                await SendRequestCountsAsync(ct);
                break;
        }
    }

    private sealed record IdPayload(long? Id);
}