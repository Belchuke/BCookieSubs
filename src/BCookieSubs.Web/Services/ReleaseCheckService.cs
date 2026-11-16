using System.Net;
using System.Reflection;
using System.Text.Json;
using BCookieSubs.Shared.Services;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Web.Services;

public record LatestRelease(
    string Tag, string Version, string? Name, string HtmlUrl, DateTime? PublishedAt);

public record ReleaseStatus(
    string CurrentVersion, LatestRelease? Latest, bool Upgradeable, string? Error);

// Checks GitHub for the newest published release. The result is cached; failures are
// cached briefly too so page reloads do not hammer the API.
public class ReleaseCheckService(IHttpClientFactory httpFactory, IMemoryCache cache, ILogger<ReleaseCheckService> logger)
{
    public const string HttpClientName = "github-releases";

    private static readonly string Repo =
        Environment.GetEnvironmentVariable("RELEASES_REPO")?.Trim() is { Length: > 0 } repo ? repo : "Belchuke/BCookieSubs";

    private const string OkKey = "releasecheck:latest";
    private const string FailKey = "releasecheck:failure";

    public async Task<ReleaseStatus> GetStatusAsync(CancellationToken ct = default)
    {
        var current = CurrentVersion();
        var (latest, error) = await GetLatestAsync(ct);
        if (latest == null)
            return new ReleaseStatus(current, null, false, error);

        return new ReleaseStatus(current, latest, IsNewer(latest.Version, current), null);
    }

    // Same assembly the About page reports; informational version carries a "+<commit>" suffix.
    public static string CurrentVersion()
    {
        var assembly = typeof(BCookieSubs.Shared.Services.SystemInfoService).Assembly;
        var version = assembly.GetCustomAttribute<System.Reflection.AssemblyInformationalVersionAttribute>()
                          ?.InformationalVersion
                      ?? assembly.GetName().Version?.ToString()
                      ?? "unknown";
        return version.Split('+')[0];
    }

    public static string TagToVersion(string tag) => tag.StartsWith('v') ? tag[1..] : tag;

    public static bool IsNewer(string latest, string current)
    {
        if (System.Version.TryParse(latest.Split('-')[0], out var l) &&
            System.Version.TryParse(current.Split('-')[0], out var c))
            return l > c;
        // Unparseable forms fall back to plain inequality so admins still get told.
        return !string.Equals(latest, current, StringComparison.OrdinalIgnoreCase);
    }

    private async Task<(LatestRelease? Latest, string? Error)> GetLatestAsync(CancellationToken ct)
    {
        if (cache.TryGetValue(FailKey, out string? cachedError) && cachedError != null)
            return (null, cachedError);
        if (cache.TryGetValue(OkKey, out LatestRelease? cached) && cached != null)
            return (cached, null);

        try
        {
            var client = httpFactory.CreateClient(HttpClientName);
            using var response = await client.GetAsync($"repos/{Repo}/releases/latest", ct);

            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                var none = "No release published yet.";
                cache.Set(FailKey, none, TimeSpan.FromMinutes(10));
                return (null, none);
            }

            response.EnsureSuccessStatusCode();

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var root = doc.RootElement;

            var tag = root.GetProperty("tag_name").GetString() ?? "";
            var release = new LatestRelease(
                tag,
                TagToVersion(tag),
                root.TryGetProperty("name", out var nameEl) ? nameEl.GetString() : null,
                root.TryGetProperty("html_url", out var urlEl) ? urlEl.GetString() ?? "" : "",
                root.TryGetProperty("published_at", out var pubEl) && pubEl.ValueKind == JsonValueKind.String
                    ? pubEl.GetDateTimeOffset().UtcDateTime
                    : null);

            cache.Set(OkKey, release, TimeSpan.FromHours(1));
            return (release, null);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogWarning(ex, "GitHub release check failed for {Repo}", Repo);
            var error = "Could not check GitHub for a newer release right now.";
            cache.Set(FailKey, error, TimeSpan.FromMinutes(10));
            return (null, error);
        }
    }
}
