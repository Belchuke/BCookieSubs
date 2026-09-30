namespace BCookieSubs.Shared.Services;

public interface IDashboardEventPublisher
{
    void TranslationChanged(long subtitleId);
    void TranslationRemoved(long subtitleId);
    void WhisperQueueChanged(long subtitleId);
    void OcrQueueChanged(long? jobId = null);
    void LogAdded(long logId);
    void LogUpdated(long logId);
    void DashboardCountsChanged();
    void LibraryRequestsChanged();
}

public class NoopDashboardEventPublisher : IDashboardEventPublisher
{
    public void TranslationChanged(long subtitleId) { }
    public void TranslationRemoved(long subtitleId) { }
    public void WhisperQueueChanged(long subtitleId) { }
    public void OcrQueueChanged(long? jobId = null) { }
    public void LogAdded(long logId) { }
    public void LogUpdated(long logId) { }
    public void DashboardCountsChanged() { }
    public void LibraryRequestsChanged() { }
}