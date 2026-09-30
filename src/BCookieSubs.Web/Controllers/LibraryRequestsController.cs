using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using BCookieSubs.Web.ViewModels;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize(Policy = Policies.Prefix + Permissions.CanAddSubtitleToTranslateFromLibrary)]
[Route("library-requests")]
public class LibraryRequestsController(
    LibraryRequestsService requests,
    LanguageRepository languages,
    ApplicationConfigRepository configs,
    CurrentUserContext currentUser,
    OrchestrationClient orchestration,
    ComputeJobService compute) : Controller
{
    [HttpGet("")]
    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        var config = await configs.GetAsync();
        var showPosters = config?.ShowPosters == true && (currentUser.User?.ShowPosters ?? true);
        var targetLangs = await languages.GetUserTranslationLanguagesAsync(currentUser.Id);
        var vm = new LibraryRequestsPageVm(
            await languages.GetAllAsync(),
            showPosters,
            Request.Query["toast"].FirstOrDefault(),
            Request.Query["msg"].FirstOrDefault(),
            targetLangs.Select(t => t.LanguageId).ToList());
        return View(vm);
    }

    [HttpGet("data")]
    public async Task<IActionResult> Data([FromQuery] string type = "movie")
    {
        await currentUser.EnsureLoadedAsync();
        var (groups, allGenres) = await requests.GetDataAsync(currentUser.Id, type);
        return Json(new { groups, allGenres });
    }

    [HttpGet("counts")]
    public async Task<IActionResult> Counts()
    {
        await currentUser.EnsureLoadedAsync();
        var counts = await requests.GetCountsAsync(currentUser.Id);
        return Json(new { counts.Movie, counts.Series, counts.Unmatched });
    }

    [HttpGet("item/{itemId:long}/subtitle-sources")]
    public async Task<IActionResult> SubtitleSources(long itemId)
    {
        var (success, msg, sources, cacheFresh) = await requests.GetSubtitleSourcesAsync(itemId);
        if (!success)
            return Json(new { success = false, msg, sources = Array.Empty<object>() });
        if (msg != null)
            return Json(new { success = true, sources = Array.Empty<object>(), message = msg });

        if (!cacheFresh)
        {
            var (rpcSuccess, _, recomputed) = await orchestration.ListSubtitleSourcesAsync(itemId);
            if (rpcSuccess) sources = recomputed;
        }
        return Json(new { success = true, sources });
    }

    // Add missing target language(s) to the item's active subtitle.
    [HttpPost("item/{itemId:long}/add-missing-lang")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AddMissingLang(long itemId, [FromForm] string? targetLangIds)
    {
        var ids = (targetLangIds ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => long.TryParse(s, out var id) && id > 0 ? id : 0)
            .Where(id => id > 0)
            .Distinct()
            .ToList();
        if (ids.Count == 0)
            return Json(new { success = false, msg = "No target languages provided" });

        var result = await requests.AddMissingLanguagesAsync(await CurrentUserIdAsync(), itemId, ids);
        return Json(new { success = result.Success, msg = result.Msg });
    }

    // Queue one or more (item, chosen source) pairs — the source picker's
    // "Queue selected" action. Image-based sources need OCR (V6) and fail.
    [HttpPost("items/translate-batch")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> TranslateBatch([FromBody] TranslateBatchInput input)
    {
        var rawItems = input?.Items;
        if (rawItems == null || rawItems.Count == 0)
            return Json(new { success = false, msg = "No items provided", queued = 0, ocrQueued = 0, failed = Array.Empty<string>() });

        var userId = await CurrentUserIdAsync();
        var batch = new List<OrchestrationClient.BatchItem>();
        var fileNames = new List<string>();
        var ocrQueued = 0;
        var ocrFailed = new List<string>();
        foreach (var raw in rawItems)
        {
            if (raw.ItemId <= 0) continue;
            var ovr = raw.SourceOverride;
            var overrideImageBased = ovr != null && (ovr.ImageBased == true || ovr.ImageBasedStr is "1" or "true");
            if (overrideImageBased)
            {
                var ocrResult = await compute.EnqueueOcrJobAsync(raw.ItemId, userId, null,
                    ovr == null ? null : new LibraryAutoTranslateService.SubtitleSourceOverride(
                        ovr.Type ?? "", ovr.Path ?? "", ovr.Language ?? "", ovr.Codec ?? "",
                        ovr.TrackId, ovr.OcrLang, ovr.Fps, true),
                    ovr?.Language, resetStatus: false);
                if (ocrResult.Success) ocrQueued++;
                else ocrFailed.Add($"{raw.ItemId} ({ocrResult.Msg})");
                continue;
            }
            batch.Add(new OrchestrationClient.BatchItem(
                raw.ItemId, false,
                ovr == null ? null : new LibraryAutoTranslateService.SubtitleSourceOverride(
                    ovr.Type ?? "", ovr.Path ?? "", ovr.Language ?? "", ovr.Codec ?? "",
                    ovr.TrackId, ovr.OcrLang, ovr.Fps, false),
                ovr?.Language));
        }

        if (batch.Count == 0 && ocrQueued == 0)
            return Json(new
            {
                success = false,
                msg = ocrFailed.Count > 0 ? "OCR queueing failed" : "No valid items",
                queued = 0,
                ocrQueued = 0,
                failed = ocrFailed,
            });

        var results = await orchestration.PrepareTranslationBatchAsync(userId, batch);
        var queued = 0;
        var failed = new List<string>(ocrFailed);
        var names = await requests.GetFileNamesAsync(batch.Select(b => b.ItemId).ToList());
        foreach (var r in results)
        {
            if (r.Success) queued++;
            else failed.Add($"{names.GetValueOrDefault(r.ItemId, $"item {r.ItemId}")} ({r.Msg})");
        }

        var msgParts = new List<string>();
        if (queued > 0) msgParts.Add($"Queued {queued}");
        if (ocrQueued > 0) msgParts.Add($"queued {ocrQueued} for OCR");
        if (failed.Count > 0) msgParts.Add($"failed {failed.Count}");
        return Json(new
        {
            success = failed.Count == 0,
            msg = msgParts.Count > 0 ? string.Join(", ", msgParts) : "Nothing queued",
            queued,
            ocrQueued,
            failed,
        });
    }

    // Season translate: queue every episode of a season that still needs the
    // user's target languages.
    [HttpPost("season/{libraryPathId:long}/translate")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SeasonTranslate(long libraryPathId, [FromForm] string? season)
    {
        if (!int.TryParse(season, out var seasonNumber))
            return Json(new { success = false, msg = "Invalid season" });

        var userId = await CurrentUserIdAsync();
        var (success, msg, itemIds, skipped) =
            await requests.GetSeasonTranslateBatchAsync(userId, libraryPathId, seasonNumber);
        if (!success) return Json(new { success = false, msg });
        if (itemIds.Count == 0)
            return Json(new { success = true, msg = "No items in season", queued = 0, skipped, failed = Array.Empty<string>() });

        var failedMessages = new List<string>();
        var queuedCount = 0;
        foreach (var itemId in itemIds)
        {
            var ocr = await compute.EnqueueOcrJobAsync(itemId, userId, null, null, null, resetStatus: false);
            if (ocr.Success) queuedCount++;
            else failedMessages.Add($"{itemId} ({ocr.Msg})");
        }

        var parts = new List<string> { $"Queued {queuedCount} episode(s) for OCR" };
        if (skipped > 0) parts.Add($"skipped {skipped} (already done)");
        if (failedMessages.Count > 0) parts.Add($"failed {failedMessages.Count}");
        return Json(new
        {
            success = failedMessages.Count == 0,
            msg = string.Join(", ", parts),
            queued = queuedCount,
            skipped,
            failed = failedMessages,
        });
    }

    // Create a Whisper-generated subtitle workflow for a library item:
    // dedupes on the active workflow, then
    // placeholder translation jobs follow once transcription completes.
    [HttpPost("item/{itemId:long}/create-whisper-subtitle")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> CreateWhisperSubtitle(long itemId)
    {
        var result = await compute.CreateWhisperSubtitleAsync(await CurrentUserIdAsync(), itemId);
        return Json(new { success = result.Success, msg = result.Msg ?? "", subtitleId = result.SubtitleId });
    }

    private async Task<long> CurrentUserIdAsync()
    {
        await currentUser.EnsureLoadedAsync();
        return currentUser.Id;
    }

    public class TranslateBatchInput
    {
        public List<TranslateBatchEntry>? Items { get; set; }
    }

    public class TranslateBatchEntry
    {
        public long ItemId { get; set; }
        public SourceOverrideDto? SourceOverride { get; set; }
    }

    public class SourceOverrideDto
    {
        public string? Type { get; set; }
        public string? Path { get; set; }
        public string? Language { get; set; }
        public string? Codec { get; set; }
        public long? TrackId { get; set; }
        public string? OcrLang { get; set; }
        public double? Fps { get; set; }
        public string? ImageBasedStr { get; set; }
        public bool? ImageBased { get; set; }
    }
}