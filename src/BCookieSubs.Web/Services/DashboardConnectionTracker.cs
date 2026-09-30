using System.Security.Claims;

namespace BCookieSubs.Web.Services;

public class DashboardConnectionTracker
{
    private readonly object _gate = new();
    private readonly Dictionary<string, long> _connections = new();

    public void Add(string connectionId, long userId)
    {
        lock (_gate) _connections[connectionId] = userId;
    }

    public void Remove(string connectionId)
    {
        lock (_gate) _connections.Remove(connectionId);
    }

    public List<long> GetDistinctUserIds()
    {
        lock (_gate) return _connections.Values.Distinct().ToList();
    }

    public static long ParseUserId(ClaimsPrincipal? user) =>
        long.TryParse(user?.FindFirst(ClaimTypes.NameIdentifier)?.Value, out var id) ? id : 0;
}