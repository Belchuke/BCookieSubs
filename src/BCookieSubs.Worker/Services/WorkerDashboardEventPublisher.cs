using System.Text.Json;
using System.Text.Json.Serialization;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Services;

namespace BCookieSubs.Worker.Services;

public class WorkerDashboardEventPublisher(OrchestrationEventBus bus) : IDashboardEventPublisher
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public void TranslationChanged(long subtitleId) => Publish(OrchestrationEventType.TranslationChanged, subtitleId);
    public void TranslationRemoved(long subtitleId) => Publish(OrchestrationEventType.TranslationRemoved, subtitleId);
    public void WhisperQueueChanged(long subtitleId) => Publish(OrchestrationEventType.WhisperQueueChanged, subtitleId);
    public void OcrQueueChanged(long? jobId = null) => Publish(OrchestrationEventType.OcrQueueChanged, jobId);
    public void LogAdded(long logId) => Publish(OrchestrationEventType.LogAdded, logId);
    public void LogUpdated(long logId) => Publish(OrchestrationEventType.LogUpdated, logId);
    public void DashboardCountsChanged() => Publish(OrchestrationEventType.DashboardCountsChanged, null);
    public void LibraryRequestsChanged() => Publish(OrchestrationEventType.LibraryRequestsChanged, null);

    private void Publish(OrchestrationEventType type, long? id)
    {
        var detail = id is null ? "{}" : JsonSerializer.Serialize(new { id }, JsonOptions);
        bus.Publish(type, 0, detail);
    }
}