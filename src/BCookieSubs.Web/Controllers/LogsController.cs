using System.Globalization;
using System.Text;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize(Policy = Policies.Prefix + Permissions.CanViewLogs)]
[Route("logs")]
public class LogsController(ApplicationLogRepository logs) : Controller
{
    private static readonly string[] ValidLevels = ["Debug", "Info", "Warning", "Error"];

    [HttpGet]
    public async Task<IActionResult> Index(
        string? level, string? type, string? q, int page, int limit, CancellationToken ct)
    {
        var (levelKind, skip, take, page0) = ReadPaging(level, type, q, page, limit);
        var result = await logs.GetPagedAsync(skip, take, levelKind, type, q, ct);
        var types = await logs.GetTypesAsync(ct);

        ViewBag.Level = levelKind?.ToString().ToLowerInvariant();
        ViewBag.Type = type;
        ViewBag.Search = q ?? "";
        ViewBag.Types = types;
        ViewBag.Pagination = (page: page0, limit: take, total: result.Total,
            totalPages: (int)Math.Ceiling(result.Total / (double)take));
        return View(result.Logs);
    }

    [HttpGet("poll")]
    public async Task<IActionResult> Poll(
        string? level, string? type, string? q, int page, int limit, CancellationToken ct)
    {
        var (levelKind, skip, take, page0) = ReadPaging(level, type, q, page, limit);
        var result = await logs.GetPagedAsync(skip, take, levelKind, type, q, ct);
        var types = await logs.GetTypesAsync(ct);
        var totalPages = (int)Math.Ceiling(result.Total / (double)take);

        return Json(new
        {
            success = true,
            logs = result.Logs.Select(l => new
            {
                l.Id,
                CreatedAt = l.CreatedAt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
                Level = l.Level.ToString().ToLowerInvariant(),
                l.Type,
                l.EntityType, l.EntityId, l.Message, l.Metadata,
            }),
            types,
            pagination = new
            {
                page = page0, limit = take, total = result.Total, totalPages,
                hasPrev = page0 > 0, hasNext = page0 < totalPages - 1,
            },
        });
    }

    [HttpGet("export")]
    public async Task<IActionResult> Export(
        string? level, string? type, string? q, string? from, string? to, string? format, CancellationToken ct)
    {
        var levelKind = ParseLevel(level);
        var fromAt = ParseBound(from, endOfDay: false);
        var toAt = ParseBound(to, endOfDay: true);
        var formatKind = format is "json" or "csv" ? format : "txt";

        var rows = await logs.GetForExportAsync(levelKind, type, fromAt, toAt, q, ct);
        var stamp = DateTime.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss");
        var baseName = $"logs-{stamp}";

        if (formatKind == "json")
        {
            var options = new System.Text.Json.JsonSerializerOptions
            {
                WriteIndented = true,
                PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
                Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            };
            var payload = System.Text.Json.JsonSerializer.Serialize(rows.Select(l => new
            {
                CreatedAt = l.CreatedAt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
                Level = l.Level.ToString().ToLowerInvariant(),
                l.Type, l.EntityType, l.EntityId, l.Message,
                Metadata = TryParse(l.Metadata),
            }), options);
            return File(Encoding.UTF8.GetBytes(payload), "application/json; charset=utf-8", $"{baseName}.json");
        }

        if (formatKind == "csv")
        {
            var header = "createdAt,level,type,entityType,entityId,message,metadata";
            var lines = rows.Select(l => string.Join(",",
                Csv(l.CreatedAt.ToString("yyyy-MM-dd HH:mm:ss")), Csv(l.Level.ToString().ToLowerInvariant()), Csv(l.Type),
                Csv(l.EntityType), Csv(l.EntityId?.ToString()), Csv(l.Message), Csv(l.Metadata)));
            return File(Encoding.UTF8.GetBytes(
                string.Join("\n", new[] { header }.Concat(lines))),
                "text/csv; charset=utf-8", $"{baseName}.csv");
        }

        var txtLines = rows.Select(l =>
        {
            var ent = l.EntityType != null ? $" [{l.EntityType}{(l.EntityId != null ? ":" + l.EntityId : "")}]" : "";
            var tp = l.Type != null ? $" [{l.Type}]" : "";
            var meta = l.Metadata != null ? $"  {l.Metadata}" : "";
            return $"[{l.CreatedAt:yyyy-MM-dd HH:mm:ss}] [{l.Level.ToString().ToUpperInvariant()}]{tp}{ent} {l.Message}{(meta.Length > 0 ? "\n" + meta : "")}";
        });
        return File(Encoding.UTF8.GetBytes(string.Join("\n", txtLines)),
            "text/plain; charset=utf-8", $"{baseName}.txt");
    }

    private (LogLevelKind? Level, int Skip, int Limit, int Page) ReadPaging(
        string? level, string? type, string? q, int page, int limit)
    {
        var take = Math.Clamp(limit == 0 ? 30 : limit, 10, 100);
        var page0 = Math.Max(0, page);
        return (ParseLevel(level), page0 * take, take, page0);
    }

    private static LogLevelKind? ParseLevel(string? level) =>
        level != null && ValidLevels.Contains(level, StringComparer.OrdinalIgnoreCase)
            ? Enum.Parse<LogLevelKind>(level, ignoreCase: true)
            : null;

    // A bare YYYY-MM-DD becomes the full day (UTC) so a day picker yields an
    // inclusive range; anything else parses as a timestamp in UTC.
    private static DateTime? ParseBound(string? raw, bool endOfDay)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        raw = raw.Trim();
        if (raw.Length == 10 && DateTime.TryParseExact(raw, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var day))
        {
            var start = DateTime.SpecifyKind(day, DateTimeKind.Utc);
            return endOfDay ? start.AddDays(1).AddTicks(-1) : start;
        }
        if (DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed))
            return DateTime.SpecifyKind(parsed, DateTimeKind.Utc);
        return null;
    }

    private static string Csv(string? value)
    {
        var s = value ?? "";
        return s.Contains(',') || s.Contains('"') || s.Contains('\n') || s.Contains('\r')
            ? $"\"{s.Replace("\"", "\"\"")}\""
            : s;
    }

    private static object? TryParse(string? metadata)
    {
        if (metadata == null) return null;
        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<object>(metadata);
        }
        catch
        {
            return metadata;
        }
    }
}