using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public class AuditService(ApplicationLogRepository logs)
{
    public Task AdminActionAsync(string action, string entityType, long? entityId, string message,
        object? metadata = null, CancellationToken ct = default)
    {
        var entry = new ApplicationLog
        {
            Level = LogLevelKind.Info,
            Type = "admin",
            EntityType = entityType,
            EntityId = entityId,
            Message = $"{action}: {message}",
            Metadata = metadata is null ? null : System.Text.Json.JsonSerializer.Serialize(metadata),
            CreatedAt = DateTime.UtcNow
        };
        return logs.AddAsync(entry, ct);
    }
}