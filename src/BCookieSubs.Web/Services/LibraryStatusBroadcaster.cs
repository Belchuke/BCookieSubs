using System.Text.Json;
using BCookieSubs.Web.Hubs;
using Microsoft.AspNetCore.SignalR;

namespace BCookieSubs.Web.Services;

public class LibraryStatusBroadcaster(IHubContext<LibraryHub> hubContext)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task BroadcastScanEventAsync(string detail, CancellationToken ct = default)
    {
        try
        {
            var payload = JsonSerializer.Deserialize<ScanEventPayload>(detail, JsonOptions);
            if (payload is null) return;
            await hubContext.Clients.Group(LibraryHub.LibraryGroup).SendAsync("scanEvent", payload, ct);
        }
        catch (JsonException)
        {
        }
    }

    private sealed record ScanEventPayload(
        long LibraryPathId, string Name, string Phase, int Processed, int Total);
}