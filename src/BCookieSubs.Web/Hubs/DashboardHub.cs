using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace BCookieSubs.Web.Hubs;

[Authorize]
public class DashboardHub(PermissionService permissions, DashboardConnectionTracker connections) : Hub
{
    public const string DashboardGroup = "dashboard";

    public const string LogsGroup = "dashboard-logs";

    public override async Task OnConnectedAsync()
    {
        var userId = DashboardConnectionTracker.ParseUserId(Context.User);
        connections.Add(Context.ConnectionId, userId);
        await Groups.AddToGroupAsync(Context.ConnectionId, DashboardGroup);
        if ((await permissions.GetEffectivePermissionsAsync(userId)).Contains(Permissions.CanViewLogsDashboard))
            await Groups.AddToGroupAsync(Context.ConnectionId, LogsGroup);
        await base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        connections.Remove(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }
}