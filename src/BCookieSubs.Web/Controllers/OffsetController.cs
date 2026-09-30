using System.Text;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Shared.Services.Storage;
using BCookieSubs.Shared.Services.Translation;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize(Policy = Policies.Prefix + Permissions.CanViewOffsetPage)]
[Route("offset")]
public class OffsetController(
    LibraryPathRepository libraryPaths,
    LibraryPathItemRepository libraryPathItems,
    LanguageRepository languages,
    ApplicationLogRepository logs,
    ILibraryFileSystemFactory fsFactory,
    CurrentUserContext currentUser) : Controller
{
    [HttpGet]
    public async Task<IActionResult> Index(CancellationToken ct)
    {
        var paths = await libraryPaths.GetAllAsync(ct);
        ViewBag.LibraryPaths = paths.Where(lp => lp.Enabled).ToList();
        ViewBag.Languages = await languages.GetAllAsync(ct);
        ViewBag.MaxOffsetMs = SrtOffsetService.MaxOffsetMs;
        return View();
    }

    [HttpPost("parse")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanEditSubtitleOffsets)]
    [ValidateAntiForgeryToken]
    [RequestFormLimits(MultipartBodyLengthLimit = 5 * 1024 * 1024)]
    public async Task<IActionResult> Parse(IFormFile? srt, string? content, double? fps)
    {
        string? raw = null;
        var fileName = "content";
        if (srt is { Length: > 0 })
        {
            if (srt.Length > 5 * 1024 * 1024)
                return Json(new { success = false, msg = "File too large (5MB limit)" });
            await using var stream = srt.OpenReadStream();
            using var reader = new StreamReader(stream);
            raw = await reader.ReadToEndAsync();
            fileName = srt.FileName;
        }
        else if (!string.IsNullOrEmpty(content))
        {
            raw = content;
        }
        if (raw == null) return Json(new { success = false, msg = "No subtitle content provided" });

        try
        {
            return Json(DetectEditorFormat(fileName, raw, fps));
        }
        catch (MicroDvdFpsRequiredException ex)
        {
            return Json(new { success = false, msg = ex.Message, needsFps = true });
        }
        catch (SubParseException ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }
        catch (Exception ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }
    }

    [HttpPost("preview")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanEditSubtitleOffsets)]
    [ValidateAntiForgeryToken]
    public IActionResult Preview([FromBody] OffsetApplyRequest body)
    {
        try
        {
            var offsetMs = SrtOffsetService.ValidateOffsetMs(body.OffsetMs);
            var entries = ParseEntries(body.Entries);
            var result = SrtOffsetService.ApplyOffsetEntries(entries, offsetMs, ToScope(body.Scope), body.Fps);
            var srtEntries = result.Select(e => new SrtEntry(
                e.Id, e.StartMs, e.EndMs <= e.StartMs ? e.StartMs + 1 : e.EndMs,
                e.StartTime, e.EndTime, e.Text)).ToList();
            return Json(new
            {
                success = true,
                entries = ToEntryDtos(result),
                srt = SrtParser.Serialize(srtEntries),
                offsetMs,
            });
        }
        catch (Exception ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }
    }

    [HttpPost("parse-library")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanEditSubtitleOffsets)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> ParseLibrary([FromBody] ParseLibraryRequest body, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(body.Path)) return Json(new { success = false, msg = "No file path provided" });

        var ext = Path.GetExtension(body.Path).ToLowerInvariant();
        if (ext is not (".srt" or ".ass" or ".ssa" or ".sub"))
            return Json(new { success = false, msg =
                "Supported formats: .srt, .ass/.ssa and text .sub. Image subtitles (VobSub .sub+.idx, PGS .sup) can't be offset here." });
        if (body.LibraryPathId is not { } libraryPathId)
            return Json(new { success = false, msg = "Missing libraryPathId" });

        var lp = await libraryPaths.GetAsync(libraryPathId, ct);
        if (lp == null) return Json(new { success = false, msg = "Library path not found" });
        if (string.IsNullOrEmpty(lp.Path)) return Json(new { success = false, msg = "Library path has no filesystem path" });

        if (!LibraryPathsService.IsWithinRoot(body.Path, lp.Path))
            return Json(new { success = false, msg = "File is outside the library path" });
        var target = Path.GetFullPath(body.Path);

        string raw;
        try
        {
            await using var fs = await fsFactory.CreateAsync(lp, ct);
            if (!await fs.ExistsAsync(target, ct)) return Json(new { success = false, msg = "File not found" });
            raw = await fs.ReadTextAsync(target, ct);
        }
        catch (Exception ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }

        try
        {
            var result = DetectEditorFormat(target, raw, body.Fps);
            var baseName = Path.GetFileNameWithoutExtension(target);
            var lastPart = baseName.Split('.').LastOrDefault()?.ToLowerInvariant() ?? "";
            var targetLang = lastPart.Length > 0 ? await languages.GetByIso639Async(lastPart, ct) : null;
            var sourceLang = await languages.GetAsync(lp.SourceLanguageId, ct);
            return Json(new
            {
                success = true,
                result.Format,
                result.Entries,
                result.Count,
                result.Fps,
                sourceLang = ToLang(sourceLang),
                targetLang = ToLang(targetLang),
            });
        }
        catch (MicroDvdFpsRequiredException ex)
        {
            return Json(new { success = false, msg = ex.Message, needsFps = true });
        }
        catch (SubParseException ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }
        catch (Exception ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }
    }

    [HttpGet("library-media/{lpId:long}")]
    public async Task<IActionResult> LibraryMedia(long lpId, CancellationToken ct)
    {
        var lp = await libraryPaths.GetAsync(lpId, ct);
        if (lp == null || string.IsNullOrEmpty(lp.Path)) return Json(new { items = new object[0] });

        var rows = await libraryPathItems.GetLibraryMediaItemsForOffsetAsync(lpId, ct);
        var items = new List<object>();
        var seen = new HashSet<long>();
        foreach (var row in rows)
        {
            if (!seen.Add(row.MediaItemId)) continue;
            items.Add(new
            {
                lpiId = row.LpiId,
                mediaItemId = row.MediaItemId,
                title = row.Title ?? "(Unknown)",
                type = row.Type ?? "unknown",
                year = row.Year,
                row.Season,
                row.Episode,
            });
        }
        return Json(new { items });
    }

    [HttpGet("library-srt-files/{lpiId:long}")]
    public async Task<IActionResult> LibrarySrtFiles(long lpiId, CancellationToken ct)
    {
        var lpi = await libraryPathItems.GetAsync(lpiId, ct);
        if (lpi == null) return Json(new { files = new object[0], libraryPathId = (long?)null });

        var lp = await libraryPaths.GetAsync(lpi.LibraryPathId, ct);
        if (lp == null || string.IsNullOrEmpty(lp.Path))
            return Json(new { files = new object[0], libraryPathId = (long?)lpi.LibraryPathId });

        var root = Path.GetFullPath(lp.Path!);
        var videoDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(lpi.Path))!);
        if (!LibraryPathsService.IsWithinRoot(videoDir, root))
            return Json(new { files = new object[0], libraryPathId = (long?)lpi.LibraryPathId });

        var files = new List<object>();
        try
        {
            await using var fs = await fsFactory.CreateAsync(lp, ct);
            var names = new List<string>();
            await foreach (var entry in fs.EnumerateDirectoryEntriesAsync(videoDir, ct))
            {
                if (entry.IsDirectory) continue;
                if (Path.GetExtension(entry.Name).ToLowerInvariant() is ".srt" or ".ass" or ".ssa" or ".sub" or ".sup")
                    names.Add(entry.Name);
            }
            names.Sort(StringComparer.OrdinalIgnoreCase);
            foreach (var name in names)
            {
                var path = Path.Combine(videoDir, name);
                var (kind, supported, note) = await DescribeSubtitleFileAsync(path, fs, ct);
                files.Add(new { name, path, kind, supported, note });
            }
        }
        catch
        {
        }
        return Json(new { files, libraryPathId = (long?)lpi.LibraryPathId });
    }

    public record OffsetEntryDto(string? Id, long StartMs, long EndMs, string? StartTime, string? EndTime, string? Text,
        int? Line, long? FrameStart, long? FrameEnd, long? OrigStart, long? OrigEnd);
    public record OffsetScopeDto(string Type, int StartIndex, int FromIndex, int ToIndex, int Index);
    public record OffsetApplyRequest(List<OffsetEntryDto>? Entries, long OffsetMs, OffsetScopeDto? Scope,
        string? FileName, bool AddCredit, string? Format, string? Raw, double? Fps);
    public record ParseLibraryRequest(string? Path, long? LibraryPathId, double? Fps);
    public record SaveToLibraryPathRequest(string? TargetPath, List<OffsetEntryDto>? Entries, bool AddCredit,
        string? Format, double? Fps);

    [HttpPost("save")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanEditSubtitleOffsets)]
    [ValidateAntiForgeryToken]
    public IActionResult Save([FromBody] OffsetApplyRequest body)
    {
        try
        {
            var entries = ParseEntries(body.Entries);
            if (entries.Count == 0) return Json(new { success = false, msg = "No entries provided" });

            var content = SerializeForEditor(body.Format, entries, body.Raw, body.Fps, body.AddCredit, subViewerToSrt: true);
            var safeName = SanitizeFileName(body.FileName ?? "subtitle.srt");
            if (body.Format == "subviewer") safeName = Path.ChangeExtension(safeName, ".srt") ?? safeName;
            var contentType = body.Format is "srt" or null
                ? "application/x-subrip; charset=utf-8"
                : "text/plain; charset=utf-8";
            return File(Encoding.UTF8.GetBytes(content), contentType, safeName);
        }
        catch (Exception ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }
    }

    [HttpPost("save-to-library-path")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanEditSubtitleOffsets)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SaveToLibraryPath([FromBody] SaveToLibraryPathRequest body, CancellationToken ct)
    {
        try
        {
            var entries = ParseEntries(body.Entries);
            if (entries.Count == 0) return Json(new { success = false, msg = "No entries provided" });
            if (string.IsNullOrEmpty(body.TargetPath)) return Json(new { success = false, msg = "No target path" });

            var libraries = await libraryPaths.GetWithFilesystemPathAsync(ct);
            var match = libraries.FirstOrDefault(l => LibraryPathsService.IsWithinRoot(body.TargetPath, l.Path));
            if (match == null)
                return Json(new { success = false, msg = "Target is outside any library path" });

            var target = Path.GetFullPath(body.TargetPath);

            string raw;
            string format;
            string content;
            await using (var fs = await fsFactory.CreateAsync(match, ct))
            {
                raw = await fs.ReadTextAsync(target, ct);
                format = DetectEditorFormat(target, raw, body.Fps).Format;
                if (format == "subviewer")
                    return Json(new { success = false, msg =
                        "SubViewer .sub is converted to SRT by this editor — use Download instead of saving in place." });
                content = SerializeForEditor(format, entries, raw, body.Fps, body.AddCredit, subViewerToSrt: false);

                await fs.WriteTextAsync(target, content, ct);
            }
            await currentUser.EnsureLoadedAsync(ct);
            await LogAsync($"Wrote edited subtitle to {body.TargetPath}",
                new { targetPath = body.TargetPath, format }, ct);
            return Json(new { success = true, msg = "Saved", fileName = Path.GetFileName(body.TargetPath), path = body.TargetPath });
        }
        catch (Exception ex)
        {
            return Json(new { success = false, msg = ex.Message });
        }
    }

    // ── Format handling ──────────────────────────────────────────────────────

    private sealed record ParseResult(string Format, List<object> Entries, int Count,
        double? Fps, string? Raw);

    // Detects the editor format for a file. Throws SubParseException for image
    // subtitle kinds (.sup, VobSub) and unrecognized .sub content.
    private static ParseResult DetectEditorFormat(string fileName, string raw, double? fpsOverride)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        if (ext == ".sup")
            throw new SubParseException("PGS (.sup) is an image subtitle — it goes through the OCR pipeline and can't be offset here.");

        if (ext is ".ass" or ".ssa")
        {
            var format = ext == ".ass" ? SubtitleFormat.Ass : SubtitleFormat.Ssa;
            var rows = AssSubtitleAdapter.ParseAssRows(raw, format);
            if (rows.Count == 0)
                throw new SubParseException("ASS/SSA parsed but contained no Dialogue rows");
            var entries = rows.Select(r => (object)new
            {
                id = r.Id,
                startMs = r.StartMs,
                endMs = r.EndMs,
                startTime = SrtParser.MsToSrtTime(r.StartMs),
                endTime = SrtParser.MsToSrtTime(r.EndMs),
                text = r.Text,
                line = r.Meta?.LineIndex,
                frameStart = (long?)null,
                frameEnd = (long?)null,
                origStart = r.StartMs,
                origEnd = r.EndMs,
            }).ToList();
            return new ParseResult(ext == ".ass" ? "ass" : "ssa", entries, entries.Count, null, raw);
        }

        if (ext is ".sub" or ".txt" or "")
        {
            var kind = SubTextAdapter.DetectSubKind(fileName, raw);
            if (kind == SubKind.VobSub)
                throw new SubParseException("VobSub (.sub + .idx) is an image subtitle — it goes through the OCR pipeline and can't be offset here.");
            if (kind is SubKind.TextMicroDvd or SubKind.TextSubViewer)
                return ParseSubText(fileName, raw, fpsOverride);
            if (ext == ".sub")
                throw new SubParseException($"Unsupported .sub format: not MicroDVD or SubViewer. Cannot parse \"{Path.GetFileName(fileName)}\".");
        }

        var srtEntries = SrtParser.Parse(raw);
        if (srtEntries.Count == 0) throw new SubParseException("SRT contains no entries");
        var srtList = srtEntries.Select(e => (object)new
        {
            id = e.Id,
            startMs = e.StartMs,
            endMs = e.EndMs,
            startTime = e.StartTime,
            endTime = e.EndTime,
            text = e.Text,
            line = (int?)null,
            frameStart = (long?)null,
            frameEnd = (long?)null,
            origStart = e.StartMs,
            origEnd = e.EndMs,
        }).ToList();
        return new ParseResult("srt", srtList, srtList.Count, null, null);
    }

    private static ParseResult ParseSubText(string fileName, string raw, double? fpsOverride)
    {
        var parsed = SubTextAdapter.ParseTextSubEntries(fileName, raw, fpsOverride);
        var format = parsed.Kind == SubKind.TextMicroDvd ? "microdvd" : "subviewer";
        var entries = new List<object>();
        for (var i = 0; i < parsed.Entries.Count; i++)
        {
            var e = parsed.Entries[i];
            var origStart = e.FrameStart ?? e.StartMs;
            var origEnd = e.FrameEnd ?? e.EndMs;
            entries.Add(new
            {
                id = (i + 1).ToString(),
                startMs = e.StartMs,
                endMs = e.EndMs,
                startTime = SrtParser.MsToSrtTime(e.StartMs),
                endTime = SrtParser.MsToSrtTime(e.EndMs),
                text = e.Text,
                line = e.FrameStart == null ? (int?)null : e.LineIndex,
                frameStart = e.FrameStart,
                frameEnd = e.FrameEnd,
                origStart,
                origEnd,
            });
        }
        return new ParseResult(format, entries, entries.Count, parsed.FpsUsed, raw);
    }

    // Serializes edited entries back into the source format. ASS/SSA and
    // MicroDVD rewrite only the timing fields of the original bytes; SubViewer
    // converts to SRT (allowed for download, refused for in-place save).
    private static string SerializeForEditor(
        string? format, List<OffsetEntry> entries, string? raw, double? fps, bool addCredit, bool subViewerToSrt)
    {
        switch (format)
        {
            case "ass" or "ssa":
                if (string.IsNullOrEmpty(raw))
                    throw new SubParseException("Original subtitle content is missing — reload the file and try again.");
                var changes = new List<AssSubtitleAdapter.AssTimingChange>();
                foreach (var e in entries)
                {
                    if (e.Line is not { } line)
                        throw new SubParseException("Entry is missing its source line index — reload the file.");
                    changes.Add(new AssSubtitleAdapter.AssTimingChange(
                        line, e.StartMs, e.EndMs, e.Text, e.OrigStart, e.OrigEnd));
                }
                return AssSubtitleAdapter.ShiftDialogueTimings(
                    raw, format == "ass" ? SubtitleFormat.Ass : SubtitleFormat.Ssa, changes, addCredit)
                    ?? throw new SubParseException("The subtitle changed since it was loaded — reload it and try again.");

            case "microdvd":
                if (string.IsNullOrEmpty(raw))
                    throw new SubParseException("Original subtitle content is missing — reload the file and try again.");
                if (fps is not > 0)
                    throw new SubParseException("Frames per second (FPS) is required for frame-based .sub files — enter it above.");
                var mdChanges = new List<SubTextAdapter.MicroDvdTimingChange>();
                foreach (var e in entries)
                {
                    if (e.Line is not { } line || e.FrameStart is not { } frameStart)
                        throw new SubParseException("Entry is missing its frame data — reload the file.");
                    mdChanges.Add(new SubTextAdapter.MicroDvdTimingChange(
                        line, frameStart, e.FrameEnd ?? frameStart, e.Text, e.OrigStart, e.OrigEnd));
                }
                return SubTextAdapter.ShiftMicroDvdFrames(raw, mdChanges, addCredit, fps.Value)
                    ?? throw new SubParseException("The subtitle changed since it was loaded — reload it and try again.");

            case "subviewer" when !subViewerToSrt:
                throw new SubParseException(
                    "SubViewer .sub is converted to SRT by this editor — use Download instead of saving in place.");

            default:
                var srt = SrtParser.Serialize(entries.Select(e => new SrtEntry(
                    e.Id,
                    e.StartMs,
                    e.EndMs <= e.StartMs ? e.StartMs + 1 : e.EndMs,
                    e.StartTime, e.EndTime, e.Text)).ToList());
                return addCredit ? SubtitleExport.AddCreditToSrt(srt) : srt;
        }
    }

    private static async Task<(string Kind, bool Supported, string? Note)> DescribeSubtitleFileAsync(
        string path, ILibraryFileSystem? fs, CancellationToken ct)
    {
        var ext = Path.GetExtension(path).ToLowerInvariant();
        switch (ext)
        {
            case ".srt": return ("srt", true, null);
            case ".ass": return ("ass", true, null);
            case ".ssa": return ("ssa", true, null);
            case ".sup": return ("pgs", false, "PGS image subtitle — OCR pipeline");
            case ".sub":
                var kind = SubKind.Unsupported;
                if (fs is { IsRemote: true })
                {
                    if (await fs.ExistsAsync(Path.ChangeExtension(path, ".idx")!, ct))
                        kind = SubKind.VobSub;
                    else
                        kind = SubTextAdapter.DetectSubKind(path, await fs.ReadTextAsync(path, ct));
                }
                else
                {
                    kind = SubTextAdapter.DetectSubKind(path);
                }
                return kind switch
                {
                    SubKind.TextMicroDvd => ("microdvd", true, null),
                    SubKind.TextSubViewer => ("subviewer", true, "Converted to SRT on save"),
                    SubKind.VobSub => ("vobsub", false, "VobSub image subtitle (has .idx) — OCR pipeline"),
                    _ => ("unknown", false, "Unrecognized .sub format"),
                };
            default: return ("unknown", false, null);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static List<OffsetEntry> ParseEntries(List<OffsetEntryDto>? raw) =>
        raw?.Select(e => new OffsetEntry(
            e.Id ?? "", Math.Max(0, e.StartMs), Math.Max(0, e.EndMs),
            e.StartTime ?? "", e.EndTime ?? "", e.Text ?? "",
            e.Line, e.FrameStart, e.FrameEnd, e.OrigStart, e.OrigEnd)).ToList() ?? [];

    private static IEnumerable<object> ToEntryDtos(List<OffsetEntry> entries) =>
        entries.Select(e => (object)new
        {
            id = e.Id,
            startMs = e.StartMs,
            endMs = e.EndMs,
            startTime = e.StartTime,
            endTime = e.EndTime,
            text = e.Text,
            line = e.Line,
            frameStart = e.FrameStart,
            frameEnd = e.FrameEnd,
            origStart = e.OrigStart,
            origEnd = e.OrigEnd,
        });

    private static OffsetScope ToScope(OffsetScopeDto? scope) =>
        scope == null
            ? OffsetScope.All
            : new OffsetScope(scope.Type, scope.StartIndex, scope.FromIndex, scope.ToIndex, scope.Index);

    private static string SanitizeFileName(string name)
    {
        var safeName = name.Replace("/", "_").Replace("\\", "_");
        foreach (var c in new[] { ':', '*', '?', '"', '<', '>', '|' })
        {
            safeName = safeName.Replace(c, '_');
        }
        return safeName;
    }

    private static object? ToLang(Language? l) =>
        l == null ? null : new { l.Name, l.Iso639, l.Locale };

    private async Task LogAsync(string message, object metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new BCookieSubs.Shared.Database.Entities.ApplicationLog
            {
                Level = LogLevelKind.Info,
                Type = "offset",
                EntityType = "offset",
                EntityId = currentUser.Id,
                Message = message,
                Metadata = System.Text.Json.JsonSerializer.Serialize(metadata),
            }, ct);
        }
        catch
        {
        }
    }
}