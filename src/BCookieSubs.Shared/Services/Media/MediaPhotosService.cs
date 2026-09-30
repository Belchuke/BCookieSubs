using System.Text.RegularExpressions;

namespace BCookieSubs.Shared.Services.Media;

public class MediaPhotosService(IHttpClientFactory httpClientFactory)
{
    public const string DirEnvVar = "MEDIA_PHOTOS_DIR";

    public static string ResolveDirectory()
    {
        var raw = Environment.GetEnvironmentVariable(DirEnvVar)?.Trim();
        return string.IsNullOrWhiteSpace(raw)
            ? Path.Combine(Environment.CurrentDirectory, "mediaItemPhotos")
            : raw;
    }

    public static void EnsureDirectory()
    {
        try
        {
            Directory.CreateDirectory(ResolveDirectory());
        }
        catch (IOException)
        {
        }
    }

    public static string SafeId(string uniqueId) =>
        Regex.Replace(uniqueId, @"[^a-zA-Z0-9_-]", "_").Truncate(120);

    public async Task<string?> DownloadPosterAsync(string posterUrl, string uniqueId, CancellationToken ct = default)
    {
        try
        {
            var response = await httpClientFactory.CreateClient("media-photos").GetAsync(posterUrl, ct);
            if (!response.IsSuccessStatusCode) return null;
            var contentType = response.Content.Headers.ContentType?.MediaType ?? "image/jpeg";
            var ext = contentType.Contains("png") ? "png" : contentType.Contains("webp") ? "webp" : "jpg";
            var filename = $"{SafeId(uniqueId)}.{ext}";
            EnsureDirectory();
            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            await using var file = File.Create(Path.Combine(ResolveDirectory(), filename));
            await stream.CopyToAsync(file, ct);
            return filename;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            return null;
        }
    }

    public string? CopyLocalPoster(string srcPath, string uniqueId)
    {
        try
        {
            if (!File.Exists(srcPath)) return null;
            var ext = Path.GetExtension(srcPath).ToLowerInvariant();
            if (string.IsNullOrEmpty(ext)) ext = ".jpg";
            var filename = SafeId(uniqueId) + ext;
            EnsureDirectory();
            File.Copy(srcPath, Path.Combine(ResolveDirectory(), filename), overwrite: true);
            return filename;
        }
        catch (IOException)
        {
            return null;
        }
    }

    public static readonly IReadOnlyList<string> UploadExtensions = [".jpg", ".jpeg", ".png", ".webp"];

    public static string UploadExtensionFor(string? originalName)
    {
        var ext = Path.GetExtension(originalName ?? "").ToLowerInvariant();
        return UploadExtensions.Contains(ext) ? ext : ".jpg";
    }

    /// <summary>Save a browser-uploaded poster; returns the stored bare filename or null.</summary>
    public async Task<string?> SaveUploadedPhotoAsync(Stream content, string? originalName, long mediaItemId, CancellationToken ct = default)
    {
        var filename = $"custom-{mediaItemId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}{UploadExtensionFor(originalName)}";
        try
        {
            EnsureDirectory();
            await using var file = File.Create(Path.Combine(ResolveDirectory(), filename));
            await content.CopyToAsync(file, ct);
            return filename;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Delete a previous custom upload (only custom- names, never TMDB posters).</summary>
    public static bool TryDeleteCustomPhoto(string? filename)
    {
        if (string.IsNullOrWhiteSpace(filename) || !filename.StartsWith("custom-")) return false;
        try
        {
            File.Delete(Path.Combine(ResolveDirectory(), filename));
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}

file static class StringExtensions
{
    public static string Truncate(this string value, int max) =>
        value.Length <= max ? value : value[..max];
}