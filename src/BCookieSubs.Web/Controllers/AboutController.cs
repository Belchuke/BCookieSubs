using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize]
[Route("[controller]")]
public class AboutController(
    SystemInfoService systemInfo,
    ReleaseCheckService releases,
    SelfUpdateService selfUpdate,
    CurrentUserContext currentUser) : Controller
{
    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        ViewBag.Checklist = await systemInfo.GetSetupChecklistAsync();
        ViewBag.CanViewSettings = currentUser.HasPermission(Permissions.CanViewSettingsPage);
        ViewBag.CanManageSettings = currentUser.HasPermission(Permissions.CanManageSettings);
        ViewBag.Release = await releases.GetStatusAsync();
        ViewBag.UpdateRunning = selfUpdate.Status().Running;
        ViewBag.SelfUpdateSupported = selfUpdate.RepoRoot != null;
        return View(await systemInfo.GetInfoAsync());
    }

    // Only the release GitHub currently reports as latest may be installed.
    [HttpPost("update")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanManageSettings)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Update([FromBody] UpdateInput input, CancellationToken ct)
    {
        var status = await releases.GetStatusAsync(ct);
        if (status.Latest == null)
            return Json(new { success = false, msg = status.Error ?? "No release published on GitHub yet" });
        if (!string.Equals(input?.Tag, status.Latest.Tag, StringComparison.Ordinal))
            return Json(new { success = false, msg = "Only the newest published release can be installed" });
        if (!status.Upgradeable)
            return Json(new { success = false, msg = "Already running the newest release" });

        var (started, error) = selfUpdate.Start(status.Latest.Tag);
        return Json(new { success = started, msg = error ?? "Update started — watch the output below" });
    }

    [HttpGet("update-status")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanManageSettings)]
    public IActionResult UpdateStatus() => Json(selfUpdate.Status());

    public class UpdateInput
    {
        public string? Tag { get; set; }
    }
}
