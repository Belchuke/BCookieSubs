using System.Security.Claims;
using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using BCookieSubs.Web.ViewModels;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize(Policy = Policies.WorkersView)]
public class WorkersController(
    WorkerNodeService nodes,
    WorkerEnrollmentService enrollments,
    OrchestrationClient orchestration,
    WorkersStatusBroadcaster broadcaster,
    CurrentUserContext currentUser) : Controller
{
    [HttpGet("/workers")]
    public async Task<IActionResult> Index()
    {
        var model = await BuildIndexViewModelAsync();
        return View(model);
    }

    [HttpGet("/workers/list-partial")]
    public async Task<IActionResult> ListPartial()
    {
        var model = await BuildIndexViewModelAsync();
        return PartialView("_WorkerList", model);
    }

    [HttpGet("/workers/{id:long}")]
    public async Task<IActionResult> Details(long id)
    {
        var node = await nodes.GetAsync(id);
        if (node is null)
        {
            return NotFound();
        }

        var live = (await orchestration.GetSnapshotAsync())?.Workers
            .FirstOrDefault(w => w.WorkerId == id);
        var vm = new WorkerDetailsViewModel
        {
            Summary = ToListItem(node, live),
            Hardware = node.Hardware,
            CreatedAt = node.CreatedAt,
            UpdatedAt = node.UpdatedAt,
            MachineIdentifier = node.MachineIdentifier,
            CanManage = currentUser.HasPermission(Permissions.WorkersManage)
        };
        return View(vm);
    }

    [HttpPost("/workers/{id:long}/set-enabled")]
    [Authorize(Policy = Policies.WorkersManage)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetEnabled(long id, bool enabled)
    {
        await nodes.SetEnabledAsync(id, enabled);
        await NotifyAndBroadcastAsync(id, enabled ? "enabled" : "disabled");
        return BackToReferrerOrDefault(id);
    }

    [HttpPost("/workers/{id:long}/set-draining")]
    [Authorize(Policy = Policies.WorkersManage)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetDraining(long id, bool draining)
    {
        await nodes.SetDrainingAsync(id, draining);
        await NotifyAndBroadcastAsync(id, draining ? "draining" : "resumed");
        return BackToReferrerOrDefault(id);
    }

    [HttpPost("/workers/{id:long}/remove")]
    [Authorize(Policy = Policies.WorkersManage)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Remove(long id)
    {
        var removed = await nodes.RemoveAsync(id);
        await NotifyAndBroadcastAsync(id, removed ? "removed" : "remove-failed");
        return RedirectToAction("Index");
    }

    [HttpPost("/workers/{id:long}/allowed-capabilities")]
    [Authorize(Policy = Policies.WorkersManage)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetAllowedCapabilities(long id, string[] capabilities)
    {
        await nodes.UpdateAllowedCapabilitiesAsync(id, capabilities);
        await NotifyAndBroadcastAsync(id, "config-changed");
        return RedirectToAction("Details", new { id });
    }

    [HttpPost("/workers/enrollments")]
    [Authorize(Policy = Policies.WorkersManage)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CreateEnrollment(string? label)
    {
        var (enrollment, token) = await enrollments.CreateAsync(GetUserId(), label);
        var model = await BuildIndexViewModelAsync();
        model.NewEnrollmentToken = token;
        return View("Index", model);
    }

    [HttpPost("/workers/enrollments/{id:long}/revoke")]
    [Authorize(Policy = Policies.WorkersManage)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RevokeEnrollment(long id)
    {
        await enrollments.RevokeAsync(id);
        return RedirectToAction("Index");
    }

    [NonAction]
    private async Task NotifyAndBroadcastAsync(long id, string detail)
    {
        await orchestration.NotifyWorkerChangedAsync(id);
        await broadcaster.BroadcastWorkerEventAsync(id, "StateChanged", detail);
    }

    [NonAction]
    private async Task<WorkersIndexViewModel> BuildIndexViewModelAsync()
    {
        var (workerList, liveById) = await LoadWorkersWithLiveStateAsync();

        var enrollmentList = await enrollments.GetRecentAsync();
        return new WorkersIndexViewModel
        {
            Workers = workerList,
            Enrollments = enrollmentList.Select(ToEnrollmentItem).ToList(),
            NewEnrollmentToken = null,
            CanManage = currentUser.HasPermission(Permissions.WorkersManage)
        };
    }

    [NonAction]
    private async Task<(List<WorkerListItemViewModel>, Dictionary<long, OrchestrationWorker>)> LoadWorkersWithLiveStateAsync()
    {
        var durable = await nodes.GetAllAsync();
        var snapshot = await orchestration.GetSnapshotAsync();
        var liveById = snapshot?.Workers.ToDictionary(w => w.WorkerId) ?? [];

        var list = durable.Select(node =>
            ToListItem(node, liveById.GetValueOrDefault(node.Id))).ToList();
        return (list, liveById);
    }

    private static WorkerListItemViewModel ToListItem(WorkerNode node, OrchestrationWorker? live)
    {
        var liveState = MapLiveState(live);
        var hw = node.Hardware;
        return new WorkerListItemViewModel
        {
            Id = node.Id,
            Name = node.Name,
            EffectiveState = WorkerStateCalculator.Calculate(node, liveState),
            Enabled = node.Enabled,
            Draining = node.Draining,
            Connected = live is { Connected: true },
            LastSeenAt = node.LastSeenAt,
            ConnectedSince = liveState?.ConnectedAt?.ToUniversalTime(),
            WorkerVersion = node.WorkerVersion,
            OperatingSystem = hw?.OperatingSystem,
            Cpu = hw is null ? null : JoinNonEmpty(hw.CpuCores > 0 ? $"{hw.CpuCores}×" : null, hw.CpuModel),
            Ram = Format.Bytes(hw?.RamBytes),
            Gpu = hw?.GpuModel is { Length: > 0 } gpu ? JoinNonEmpty(hw.GpuVendor, gpu) : null,
            Vram = Format.Bytes(hw?.GpuVramBytes),
            ReportedCapabilities = node.ReportedCapabilities,
            AllowedCapabilities = node.AllowedCapabilities,
            MaxConcurrency = node.MaxConcurrency,
            ActiveJobs = live?.ActiveJobs ?? 0
        };
    }

    private static WorkerLiveState? MapLiveState(OrchestrationWorker? live)
    {
        if (live is null)
        {
            return null;
        }

        return new WorkerLiveState(
            live.WorkerId,
            live.Connected,
            live.ConnectedAtUnix == 0 ? null : DateTimeOffset.FromUnixTimeSeconds(live.ConnectedAtUnix).UtcDateTime,
            live.LastHeartbeatAtUnix == 0 ? null : DateTimeOffset.FromUnixTimeSeconds(live.LastHeartbeatAtUnix).UtcDateTime,
            live.Ready,
            live.ActiveJobs);
    }

    private static EnrollmentItemViewModel ToEnrollmentItem(WorkerEnrollment e) => new()
    {
        Id = e.Id,
        CodePrefix = e.CodePrefix,
        Label = e.Label,
        CreatedAt = e.CreatedAt,
        ExpiresAt = e.ExpiresAt,
        Status =
            e.RevokedAt is not null ? "revoked" :
            e.ConsumedAt is not null ? "used" :
            e.ExpiresAt <= DateTime.UtcNow ? "expired" : "active"
    };

    private static string? JoinNonEmpty(string? left, string? right)
    {
        var parts = new[] { left, right }.Where(s => !string.IsNullOrWhiteSpace(s));
        var joined = string.Join(" ", parts);
        return joined.Length == 0 ? null : joined;
    }

    private long GetUserId()
    {
        var idValue = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return long.TryParse(idValue, out var id) ? id : 0;
    }

    private IActionResult BackToReferrerOrDefault(long id)
    {
        var referer = Request.Headers.Referer.ToString();
        if (Uri.IsWellFormedUriString(referer, UriKind.Absolute) && new Uri(referer).Authority == Request.Host.Value)
        {
            return Redirect(referer);
        }

        return RedirectToAction("Details", new { id });
    }
}