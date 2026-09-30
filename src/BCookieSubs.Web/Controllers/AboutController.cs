using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize]
[Route("[controller]")]
public class AboutController(SystemInfoService systemInfo, CurrentUserContext currentUser) : Controller
{
    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        ViewBag.Checklist = await systemInfo.GetSetupChecklistAsync();
        ViewBag.CanViewSettings = currentUser.HasPermission(Permissions.CanViewSettingsPage);
        return View(await systemInfo.GetInfoAsync());
    }
}