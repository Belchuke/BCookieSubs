namespace BCookieSubs.Shared.Database.Entities;

public class WorkerEnrollment
{
    public long Id { get; set; }
    public string CodeHash { get; set; } = "";
    /// <summary>Short prefix so admins can recognize a code without seeing it.</summary>
    public string CodePrefix { get; set; } = "";
    public string? Label { get; set; }
    public long CreatedByUserId { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public DateTime? ConsumedAt { get; set; }
    public long? ConsumedByWorkerId { get; set; }
    public WorkerNode? ConsumedByWorker { get; set; }
    public DateTime? RevokedAt { get; set; }
}