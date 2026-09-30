using BCookieSubs.Shared.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace BCookieSubs.Web.Hubs;

[Authorize(Policy = Policies.WorkersView)]
public class WorkersHub : Hub
{
    public const string WorkersGroup = "workers";

    public override Task OnConnectedAsync()
    {
        Groups.AddToGroupAsync(Context.ConnectionId, WorkersGroup);
        return base.OnConnectedAsync();
    }
}