using System.Text.Json;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using BCookieSubs.Web.ViewModels;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize(Policy = Policies.LibraryPages)]
[Route("library-paths")]
public class LibraryPathsController(
    LibraryPathsService libraryPaths,
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
        var vm = new LibraryPathsPageVm(
            await languages.GetAllAsync(),
            string.IsNullOrWhiteSpace(config?.RootLibraryPath) ? null : config!.RootLibraryPath,
            showPosters,
            Request.Query["toast"].FirstOrDefault(),
            Request.Query["msg"].FirstOrDefault());
        return View(vm);
    }

    [HttpGet("data")]
    public async Task<IActionResult> Data([FromQuery] string type = "movie") =>
        Json(new { paths = await libraryPaths.GetViewDataAsync(type) });

    [HttpGet("blacklist-data")]
    public async Task<IActionResult> BlacklistData() =>
        Json(new { blacklisted = await libraryPaths.GetBlacklistedAsync() });

    [HttpGet("items")]
    public async Task<IActionResult> Items([FromQuery] string? ids)
    {
        var idList = ParseItemIds(ids);
        return Json(new { items = await libraryPaths.GetItemsByIdsAsync(idList) });
    }

    [HttpGet("browse")]
    // The picker exists only for the add/edit library-path dialogs; view-only
    // users have no use for it.
    [Authorize(Policy = Policies.PathBrowse)]
    public async Task<IActionResult> Browse([FromQuery] string? path)
    {
        var result = await libraryPaths.BrowseAsync(path);
        return Json(new
        {
            path = result.Path,
            parent = result.Parent,
            dirs = result.Dirs.Select(d => new { name = d.Name, fullPath = d.FullPath }),
            error = result.Error,
        });
    }

    [HttpGet("blacklist")]
    public IActionResult Blacklist() => Redirect("/library-paths?tab=blacklist");

    [HttpPost("create")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create([FromForm] LibraryPathInput input)
    {
        var result = await libraryPaths.CreateAsync(await CurrentUserIdAsync(), ToForm(input));
        if (!result.Success)
            return ToastError(result.Msg ?? "Failed to create");
        return ToastSuccess("Library path created");
    }

    [HttpPost("update/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Update(long id, [FromForm] LibraryPathInput input)
    {
        var result = await libraryPaths.UpdateAsync(await CurrentUserIdAsync(), id, ToForm(input));
        if (!result.Success)
            return ToastError(result.Msg ?? "Failed to update");
        return ToastSuccess("Library path updated");
    }

    [HttpPost("test-sftp")]
    // Permission (add OR edit) is checked in TestSftpConnectionAsync.
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> TestSftp([FromBody] SftpTestInput input, CancellationToken ct)
    {
        var result = await libraryPaths.TestSftpConnectionAsync(
            await CurrentUserIdAsync(), input.Id, ToTestForm(input), ct);
        return Json(new
        {
            success = result.Success,
            error = result.Error,
            presentedFingerprint = result.PresentedFingerprint,
            needsTrust = result.NeedsTrust,
            keyChanged = result.KeyChanged,
            steps = result.Steps,
        });
    }

    [HttpPost("toggle/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Toggle(long id)
    {
        var result = await libraryPaths.ToggleAsync(await CurrentUserIdAsync(), id);
        if (!result.Success)
            return ToastError(result.Msg ?? "Failed");
        return Redirect("/library-paths");
    }

    [HttpPost("rescan/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Rescan(long id)
    {
        var result = await libraryPaths.RescanAsync(await CurrentUserIdAsync(), id);
        if (IsJsonRequest())
            return Json(new { success = result.Success, msg = result.Msg });
        if (!result.Success)
            return ToastError(result.Msg ?? "Failed");
        return ToastSuccess(result.Msg ?? "Rescan scheduled");
    }

    [HttpPost("delete/{id:long}")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(long id)
    {
        var result = await libraryPaths.DeleteAsync(await CurrentUserIdAsync(), id);
        if (!result.Success)
            return ToastError(result.Msg ?? "Failed to delete");
        return ToastSuccess("Library path deleted");
    }

    [HttpPost("item/{itemId:long}/select-candidate")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SelectCandidate(long itemId, [FromForm] TmdbMatchInput input)
    {
        long? mediaItemId = long.TryParse(input.MediaItemId, out var parsed) ? parsed : null;
        var result = await libraryPaths.SelectCandidateAsync(await CurrentUserIdAsync(), itemId, mediaItemId);
        if (IsJsonRequest())
            return Json(new { success = result.Success, msg = result.Msg });
        if (!result.Success)
            return ToastError(result.Msg ?? "Failed");
        return ToastSuccess(result.Msg ?? "Media match selected");
    }

    [HttpGet("item/{itemId:long}/search-tmdb")]
    public async Task<IActionResult> SearchTmdb(long itemId, [FromQuery] string? q)
    {
        var (items, success, msg) = await libraryPaths.SearchTmdbForItemAsync(itemId, q ?? "");
        return Json(new { items, success, msg });
    }

    [HttpGet("bulk-search-tmdb")]
    public async Task<IActionResult> BulkSearchTmdb([FromQuery] string? q, [FromQuery] string type = "movie")
    {
        if (string.IsNullOrWhiteSpace(q)) return Json(new { items = Array.Empty<object>(), success = true });
        var (items, error) = await libraryPaths.SearchTmdbAsync(q, type);
        return Json(new { items, success = error == null, msg = error });
    }

    // The endpoint takes flat fields like every other match route.
    [HttpPost("bulk-change-match")]
    [Authorize(Policy = Policies.Prefix + LibraryPathsService.ChangeMatchPermission)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> BulkChangeMatch([FromForm] BulkChangeMatchInput input)
    {
        var itemIds = ParseItemIds(input.ItemIds);
        if (itemIds.Count == 0)
            return Json(new { success = false, msg = "No items selected" });
        if (string.IsNullOrWhiteSpace(input.Title))
            return Json(new { success = false, msg = "Invalid TMDB result" });

        var form = new LibraryTmdbMatchForm(input.Title, input.OriginalTitle, input.Year,
            input.IsAnime, input.Genres, input.TheMovieDbId, input.PosterUrl, input.Type);
        var result = await libraryPaths.BulkChangeMatchAsync(
            await CurrentUserIdAsync(), itemIds, input.Type ?? "movie", form);
        return Json(new
        {
            success = result.Success,
            msg = result.Msg,
            mediaItemId = result.MediaItemId,
            updated = result.Updated,
            skipped = result.Skipped,
        });
    }

    [HttpPost("item/{itemId:long}/select-tmdb-result")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SelectTmdbResult(long itemId, [FromForm] TmdbMatchInput input)
    {
        var result = await libraryPaths.SelectTmdbResultAsync(await CurrentUserIdAsync(), itemId, ToMatchForm(input));
        if (IsJsonRequest())
            return Json(new { success = result.Success, msg = result.Msg, mediaItemId = result.MediaItemId });
        if (!result.Success)
            return ToastError(result.Msg ?? "Failed");
        return ToastSuccess(result.Msg ?? "Match selected");
    }

    [HttpPost("group/select-candidate")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> GroupSelectCandidate([FromForm] TmdbMatchInput input)
    {
        long? mediaItemId = long.TryParse(input.MediaItemId, out var parsed) ? parsed : null;
        var result = await libraryPaths.GroupSelectCandidateAsync(
            await CurrentUserIdAsync(), ParseItemIds(input.ItemIds), mediaItemId);
        return Json(new { success = result.Success, msg = result.Msg });
    }

    [HttpPost("group/select-tmdb-result")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> GroupSelectTmdbResult([FromForm] TmdbMatchInput input)
    {
        var result = await libraryPaths.GroupSelectTmdbResultAsync(
            await CurrentUserIdAsync(), ParseItemIds(input.ItemIds), ToMatchForm(input));
        return Json(new
        {
            success = result.Success,
            msg = result.Msg,
            mediaItemId = result.MediaItemId,
        });
    }

    [HttpPost("item/{itemId:long}/blacklist")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> BlacklistItem(long itemId, [FromForm] string? reason)
    {
        var result = await libraryPaths.BlacklistAsync(await CurrentUserIdAsync(), itemId, reason);
        if (IsJsonRequest())
            return Json(new
            {
                success = result.Success,
                msg = result.Msg ?? (result.Success ? "Item blacklisted" : "Failed to blacklist"),
            });
        var msg = result.Success ? "Item blacklisted" : result.Msg ?? "Failed to blacklist";
        return BlacklistAwareRedirect(result.Success, msg);
    }

    [HttpPost("item/{itemId:long}/translate")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Translate(long itemId, [FromForm] TranslateSourceInput input)
    {
        var userId = await CurrentUserIdAsync();

        var srcIso = (input.SourceLanguage ?? "").Trim().ToLowerInvariant();
        if (srcIso.Length > 0)
        {
            var targetIso = (await languages.GetUserTranslationLanguagesAsync(userId))
                .Select(t => t.Language?.Iso639?.ToLowerInvariant())
                .Where(s => !string.IsNullOrEmpty(s))
                .ToHashSet();
            if (targetIso.Contains(srcIso))
            {
                const string msg = "Source language is one of your target languages";
                if (IsJsonRequest()) return Json(new { success = false, msg, skipped = true });
                return ToastError(msg);
            }
        }

        var sourceOverride = BuildSourceOverride(input);
        if (sourceOverride is { ImageBased: true })
        {
            var ocr = await compute.EnqueueOcrJobAsync(itemId, userId, null,
                sourceOverride, input.SourceLanguage, resetStatus: false);
            if (IsJsonRequest()) return Json(new { success = ocr.Success, msg = ocr.Msg });
            return ocr.Success ? ToastSuccess(ocr.Msg) : ToastError(ocr.Msg);
        }

        var (success, prepMsg) = await orchestration.PrepareTranslationAsync(
            itemId, false, userId, sourceOverride, input.SourceLanguage);
        if (IsJsonRequest()) return Json(new { success, msg = prepMsg });
        return success ? ToastSuccess(prepMsg) : ToastError(prepMsg);
    }

    [HttpPost("item/{itemId:long}/readd")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Readd(long itemId)
    {
        var (success, msg) = await orchestration.PrepareTranslationAsync(
            itemId, true, await CurrentUserIdAsync(), null);
        if (IsJsonRequest()) return Json(new { success, msg });
        return success ? ToastSuccess(msg) : ToastError(msg);
    }

    [HttpPost("item/{itemId:long}/unblacklist")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> UnblacklistItem(long itemId)
    {
        var result = await libraryPaths.UnblacklistAsync(await CurrentUserIdAsync(), itemId);
        var msg = result.Success ? "Item removed from blacklist" : result.Msg ?? "Failed to remove";
        return BlacklistAwareRedirect(result.Success, msg);
    }

    [HttpPost("group/blacklist")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> GroupBlacklist([FromForm] GroupBlacklistInput input)
    {
        var itemIds = ParseItemIds(input.ItemIds);
        if (itemIds.Count == 0)
        {
            if (IsJsonRequest()) return Json(new { success = false, msg = "No items specified" });
            return ToastError("No items specified");
        }

        var result = await libraryPaths.GroupBlacklistAsync(await CurrentUserIdAsync(), itemIds, input.Reason);
        if (IsJsonRequest())
            return Json(new { success = true, msg = result.Msg, itemIds });
        return ToastSuccess(result.Msg ?? "Items blacklisted");
    }

    [HttpPost("media-item/{mediaItemId:long}/upload-photo")]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> UploadPhoto(long mediaItemId, IFormFile? photo)
    {
        if (photo == null || photo.Length == 0)
            return Json(new { success = false, msg = "No file uploaded" });

        await using var stream = photo.OpenReadStream();
        var result = await libraryPaths.UploadPhotoAsync(
            await CurrentUserIdAsync(), mediaItemId, stream, photo.FileName,
            photo.ContentType, photo.Length);
        return Json(new { success = result.Success, msg = result.Msg, photoPath = result.PhotoPath });
    }

    // ── Input models ────────────────────────────────────────────────────────

    public class LibraryPathInput
    {
        public string? Name { get; set; }
        public string? Path { get; set; }
        public string? SourceLangId { get; set; }
        public string? Type { get; set; }
        public string? Enabled { get; set; }
        public string? AutoTranslate { get; set; }
        public string? AutoExtract { get; set; }
        public string? ScanMode { get; set; }
        public string? ScanRepeatInterval { get; set; }
        public string? ScanRepeatUnit { get; set; }
        public string? ScanDayOfWeek { get; set; }
        public string? ScanStartTimeHour { get; set; }
        public string? ScanStartTimeMinute { get; set; }
        public string? ScanDurationMinutes { get; set; }
        public string? ScanFirstStartAt { get; set; }
        public string? Storage { get; set; }
        public string? SftpHost { get; set; }
        public string? SftpPort { get; set; }
        public string? SftpUsername { get; set; }
        public string? SftpAuthMode { get; set; }
        public string? SftpPassword { get; set; }
        public string? SftpPrivateKey { get; set; }
        public string? SftpKeyPassphrase { get; set; }
        public string? ClearSftpPassword { get; set; }
        public string? ClearSftpPrivateKey { get; set; }
        public string? ClearSftpKeyPassphrase { get; set; }
        public string? SftpHostKeyFingerprint { get; set; }
    }

    // Test-connection payload: same fields as the form (JSON), plus the path id
    // so stored secrets can stand in for empty credential fields.
    public class SftpTestInput : LibraryPathInput
    {
        public long? Id { get; set; }
    }

    public class TmdbMatchInput
    {
        public string? ItemIds { get; set; }
        public string? MediaItemId { get; set; }
        public string? Type { get; set; }
        public string? Title { get; set; }
        public string? OriginalTitle { get; set; }
        public string? Year { get; set; }
        public string? IsAnime { get; set; }
        public string? Genres { get; set; }
        public string? TheMovieDbId { get; set; }
        public string? PosterUrl { get; set; }
    }

    public class BulkChangeMatchInput : TmdbMatchInput
    {
    }

    public class GroupBlacklistInput
    {
        public string? ItemIds { get; set; }
        public string? Reason { get; set; }
    }

    public class TranslateSourceInput
    {
        public string? SourceType { get; set; }
        public string? SourcePath { get; set; }
        public string? SourceLanguage { get; set; }
        public string? SourceCodec { get; set; }
        public string? SourceTrackId { get; set; }
        public string? OcrLang { get; set; }
        public string? Fps { get; set; }
        public string? ImageBased { get; set; }
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private static LibraryAutoTranslateService.SubtitleSourceOverride? BuildSourceOverride(TranslateSourceInput input)
    {
        if (string.IsNullOrEmpty(input.SourcePath)) return null;
        return new LibraryAutoTranslateService.SubtitleSourceOverride(
            input.SourceType ?? "",
            input.SourcePath,
            input.SourceLanguage ?? "",
            input.SourceCodec ?? "",
            long.TryParse(input.SourceTrackId, out var trackId) ? trackId : null,
            string.IsNullOrEmpty(input.OcrLang) ? null : input.OcrLang,
            double.TryParse(input.Fps, System.Globalization.CultureInfo.InvariantCulture, out var fps) ? fps : null,
            input.ImageBased == "1" || string.Equals(input.ImageBased, "true", StringComparison.OrdinalIgnoreCase));
    }

    private async Task<long> CurrentUserIdAsync()
    {
        await currentUser.EnsureLoadedAsync();
        return currentUser.Id;
    }

    private bool IsJsonRequest() => Request.Query["json"].FirstOrDefault() == "1";

    private RedirectResult ToastSuccess(string msg) => Toast("success", msg);

    private RedirectResult ToastError(string msg) => Toast("error", msg);

    private RedirectResult Toast(string type, string msg) =>
        Redirect($"/library-paths?toast={type}&msg={Uri.EscapeDataString(msg)}");

    // Blacklist posts return to the blacklist tab via ?from=blacklist.
    private RedirectResult BlacklistAwareRedirect(bool success, string msg)
    {
        var fromBlacklist = Request.Query["from"].FirstOrDefault() == "blacklist";
        var redirectTo = fromBlacklist ? "/library-paths?tab=blacklist" : "/library-paths";
        var sep = fromBlacklist ? "&" : "?";
        return Redirect($"{redirectTo}{sep}toast={(success ? "success" : "error")}&msg={Uri.EscapeDataString(msg)}");
    }

    private static LibraryPathForm ToForm(LibraryPathInput input) => new(
        input.Name ?? "",
        input.Path ?? "",
        long.TryParse(input.SourceLangId, out var langId) ? langId : 0,
        input.Type ?? "",
        input.Enabled == "1",
        input.AutoTranslate == "1",
        input.AutoExtract == "1",
        NullIfEmpty(input.ScanMode),
        ParseIntOrNull(input.ScanRepeatInterval),
        NullIfEmpty(input.ScanRepeatUnit),
        ParseIntOrNull(input.ScanDayOfWeek),
        ParseIntOrNull(input.ScanStartTimeHour),
        ParseIntOrNull(input.ScanStartTimeMinute),
        ParseIntOrNull(input.ScanDurationMinutes),
        NullIfEmpty(input.ScanFirstStartAt),
        NullIfEmpty(input.Storage) ?? "local",
        NullIfEmpty(input.SftpHost),
        ParseIntOrNull(input.SftpPort),
        NullIfEmpty(input.SftpUsername),
        NullIfEmpty(input.SftpAuthMode) ?? "password",
        input.SftpPassword,
        input.SftpPrivateKey,
        input.SftpKeyPassphrase,
        input.ClearSftpPassword == "1",
        input.ClearSftpPrivateKey == "1",
        input.ClearSftpKeyPassphrase == "1",
        NullIfEmpty(input.SftpHostKeyFingerprint));

    // Test payload: only the SFTP-relevant fields are meaningful.
    private static LibraryPathForm ToTestForm(LibraryPathInput input) => new(
        input.Name ?? "",
        input.Path ?? "",
        0, "movie", false, false, false,
        null, null, null, null, null, null, null, null,
        NullIfEmpty(input.Storage) ?? "sftp",
        NullIfEmpty(input.SftpHost),
        ParseIntOrNull(input.SftpPort),
        NullIfEmpty(input.SftpUsername),
        NullIfEmpty(input.SftpAuthMode) ?? "password",
        input.SftpPassword,
        input.SftpPrivateKey,
        input.SftpKeyPassphrase,
        input.ClearSftpPassword == "1",
        input.ClearSftpPrivateKey == "1",
        input.ClearSftpKeyPassphrase == "1",
        NullIfEmpty(input.SftpHostKeyFingerprint));

    private static LibraryTmdbMatchForm ToMatchForm(TmdbMatchInput input) => new(
        input.Title, input.OriginalTitle, input.Year, input.IsAnime,
        input.Genres, input.TheMovieDbId, input.PosterUrl, input.Type);

    private static string? NullIfEmpty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    private static int? ParseIntOrNull(string? raw) =>
        int.TryParse(raw, out var value) ? value : null;

    // Accepts "1,2,3" or a JSON array of numbers.
    private static List<long> ParseItemIds(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return [];
        var trimmed = raw.Trim();
        var ids = new List<long>();
        if (trimmed.StartsWith('['))
        {
            try
            {
                using var doc = JsonDocument.Parse(trimmed);
                if (doc.RootElement.ValueKind == JsonValueKind.Array)
                {
                    foreach (var el in doc.RootElement.EnumerateArray())
                    {
                        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out var n) && n > 0)
                            ids.Add(n);
                    }
                }
            }
            catch (JsonException)
            {
            }
            return ids;
        }
        foreach (var part in trimmed.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (long.TryParse(part, out var n) && n > 0) ids.Add(n);
        }
        return ids;
    }
}