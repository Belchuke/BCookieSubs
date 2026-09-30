using BCookieSubs.Shared.Security;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace BCookieSubs.Web.Hubs;

[Authorize(Policy = Policies.LibraryPages)]
public class LibraryHub(DashboardConnectionTracker connections) : Hub
{
    public const string LibraryGroup = "library";

    public override async Task OnConnectedAsync()
    {
        connections.Add(Context.ConnectionId, DashboardConnectionTracker.ParseUserId(Context.User));
        await Groups.AddToGroupAsync(Context.ConnectionId, LibraryGroup);
        await base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        connections.Remove(Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }
}