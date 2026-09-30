using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class WorkerJob
{
    public long Id { get; set; }

    public string JobType { get; set; } = "";
    public WorkerJobStatus Status { get; set; } = WorkerJobStatus.Queued;

    /// <summary>Lower values are claimed first.</summary>
    public int Priority { get; set; }

    /// <summary>Capability a worker must report AND be allowed, e.g. "ocr".</summary>
    public string? RequiredCapability { get; set; }

    /// <summary>JSONB job input (e.g. source override for OCR jobs).</summary>
    public string? Payload { get; set; }

    /// <summary>JSONB job result.</summary>
    public string? Result { get; set; }

    /// <summary>Dominant entity this job belongs to, e.g. "libraryPathItem"; no FK (generic).</summary>
    public string? SubjectType { get; set; }
    public long? SubjectId { get; set; }

    public string? DisplayName { get; set; }

    public long? CreatedByUserId { get; set; }
    public ApplicationUser? CreatedByUser { get; set; }

    public long? ClaimedByWorkerId { get; set; }
    public WorkerNode? ClaimedByWorker { get; set; }
    public DateTime? ClaimedAt { get; set; }
    public DateTime? HeartbeatAt { get; set; }
    public DateTime? LeaseExpiresAt { get; set; }

    public int RetryCount { get; set; }

    /// <summary>0 means no automatic retry.</summary>
    public int MaxRetries { get; set; }
    public DateTime? NextRetryAt { get; set; }

    public string? ErrorCode { get; set; }
    public string? ErrorMessage { get; set; }

    public int Progress { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime? StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}