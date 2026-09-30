using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class ApplicationLog
{
    public long Id { get; set; }
    public LogLevelKind Level { get; set; } = LogLevelKind.Info;

    public string? Type { get; set; }
    public string? EntityType { get; set; }
    public long? EntityId { get; set; }
    public string Message { get; set; } = "";

    /// <summary>Structured metadata as a JSON string (JSONB column).</summary>
    public string? Metadata { get; set; }

    public DateTime CreatedAt { get; set; }
}