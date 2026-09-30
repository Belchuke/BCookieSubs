using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize]
[Route("translated")]
public class TranslatedController(
    SubtitleRepository subtitles,
    SubtitleTaskService tasks,
    ApplicationConfigRepository configs,
    CurrentUserContext currentUser) : Controller
{
    private const int PageSize = 30;

    [HttpGet]
    [Authorize(Policy = Policies.Prefix + Permissions.CanViewFinishedTranslatedPage)]
    public async Task<IActionResult> Index(int page, CancellationToken ct)
    {
        var result = await subtitles.GetFinishedJobsPageAsync(Math.Max(0, page), PageSize, ct);
        ViewBag.Config = await configs.GetAsync(ct);
        ViewBag.Pagination = (page: result.Page, limit: PageSize, total: result.Total,
            totalPages: result.TotalPages, hasPrev: result.Page > 0,
            hasNext: result.Page < result.TotalPages - 1);
        return View(result.Items);
    }

    [HttpPost("delete/{jobId:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanDeleteTranslation)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(long jobId, int page, CancellationToken ct)
    {
        var result = await tasks.SoftDeleteSubtitleJobAsync(currentUser.Id, jobId, ct);
        return RedirectToAction(nameof(Index), new
        {
            page,
            toast = result.Success ? "success" : "error",
            msg = result.Success ? "Translation removed" : result.Msg ?? "Failed to remove",
        });
    }
}