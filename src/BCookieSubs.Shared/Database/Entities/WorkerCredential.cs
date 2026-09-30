namespace BCookieSubs.Shared.Database.Entities;

public class WorkerCredential
{
    public long Id { get; set; }
    public long WorkerId { get; set; }
    public WorkerNode Worker { get; set; } = null!;
    public string SecretHash { get; set; } = "";
    public DateTime CreatedAt { get; set; }
    public DateTime? RevokedAt { get; set; }
}