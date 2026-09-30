using BCookieSubs.Shared.Services.Media;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize]
[Route("media-photos")]
public class MediaPhotosController : Controller
{
    [HttpGet("{filename}")]
    public IActionResult Get(string filename)
    {
        var safe = Path.GetFileName(filename);
        if (safe.Length == 0 || safe.StartsWith('.')) return NotFound();

        var dir = Path.GetFullPath(MediaPhotosService.ResolveDirectory());
        var full = Path.GetFullPath(Path.Combine(dir, safe));
        if (full != dir && !full.StartsWith(dir + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            return NotFound();
        if (!System.IO.File.Exists(full)) return NotFound();

        var contentType = Path.GetExtension(safe).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".jpg" or ".jpeg" => "image/jpeg",
            _ => "application/octet-stream",
        };
        var info = new FileInfo(full);
        var etag = new Microsoft.Net.Http.Headers.EntityTagHeaderValue($"\"{info.Length}-{info.LastWriteTimeUtc.Ticks}\"");
        return PhysicalFile(full, contentType, info.LastWriteTimeUtc, etag, enableRangeProcessing: true);
    }
}