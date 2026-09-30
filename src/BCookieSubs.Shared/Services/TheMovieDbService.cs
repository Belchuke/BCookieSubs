using Microsoft.Extensions.Logging;
using System.Text.Json;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public record TmdbSearchItem(
    long Id,
    string Name,
    string? OriginalTitle,
    string? ReleaseDate,
    string PosterUrl,
    string Genres,
    bool IsAnime);

public class TheMovieDbService(
    IHttpClientFactory httpClientFactory,
    SecretsService secrets,
    ApplicationConfigRepository configs,
    ILogger<TheMovieDbService> logger)
{
    private const string PosterBaseUrl = "https://image.tmdb.org/t/p/w600_and_h900_face/";

    private static long _rateLimitedUntilMs;

    private static readonly (long Id, string Name)[] Genres =
    [
        (28, "Action"), (12, "Adventure"), (16, "Animation"), (35, "Comedy"),
        (80, "Crime"), (99, "Documentary"), (18, "Drama"), (10751, "Family"),
        (14, "Fantasy"), (36, "History"), (27, "Horror"), (10402, "Music"),
        (9648, "Mystery"), (10749, "Romance"), (878, "Science Fiction"),
        (10770, "TV Movie"), (53, "Thriller"), (10752, "War"), (37, "Western"),
        (10759, "Action & Adventure"), (10762, "Kids"), (10763, "News"),
        (10764, "Reality"), (10765, "Sci-Fi & Fantasy"), (10766, "Soap"),
        (10767, "Talk"), (10768, "War & Politics"),
    ];

    public static bool IsAnime(string? originalLanguage, IEnumerable<long> genreIds) =>
        genreIds.Any(id => id == 16) && originalLanguage is "ja" or "zh" or "ko";

    public async Task<(List<TmdbSearchItem> Items, string? Error)> SearchAsync(
        string query, string type, int? year, CancellationToken ct = default)
    {
        var config = await configs.GetAsync(ct);
        if (config is not { TheMovieDbActive: true })
        {
            return ([], "The Movie DB API key not configured");
        }
        var apiKey = await secrets.GetAsync(Security.SecretKeys.TmdbApiKey, ct);
        if (string.IsNullOrEmpty(apiKey))
        {
            return ([], "The Movie DB API key not configured");
        }

        var url = $"https://api.themoviedb.org/3/search/{(type == "movie" ? "movie" : "tv")}" +
                  $"?api_key={Uri.EscapeDataString(apiKey)}&query={Uri.EscapeDataString(query)}";
        if (year is { } y) url += $"&year={y}";

        try
        {
            var response = await FetchWithBackoffAsync(url, ct);
            if (response == null) return ([], "The Movie DB API error");
            using var doc = JsonDocument.Parse(response);
            var results = doc.RootElement.TryGetProperty("results", out var r) && r.ValueKind == JsonValueKind.Array
                ? r
                : default;
            var items = new List<TmdbSearchItem>();
            if (results.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in results.EnumerateArray())
                {
                    items.Add(MapSearchItem(item, type));
                }
            }
            return (items, null);
        }
        catch (JsonException ex)
        {
            logger.LogWarning(ex, "TMDB search returned invalid JSON");
            return ([], "The Movie DB API error: invalid response");
        }
        catch (HttpRequestException ex)
        {
            logger.LogWarning(ex, "TMDB search request failed");
            return ([], "The Movie DB API error: request failed");
        }
    }

    public async Task<TmdbSearchItem?> DetailsAsync(long tmdbId, string type, CancellationToken ct = default)
    {
        var config = await configs.GetAsync(ct);
        if (config is not { TheMovieDbActive: true }) return null;
        var apiKey = await secrets.GetAsync(Security.SecretKeys.TmdbApiKey, ct);
        if (string.IsNullOrEmpty(apiKey)) return null;

        var endpoint = type == "movie" ? "movie" : "tv";
        var url = $"https://api.themoviedb.org/3/{endpoint}/{tmdbId}?api_key={Uri.EscapeDataString(apiKey)}";
        try
        {
            var response = await FetchWithBackoffAsync(url, ct);
            if (response == null) return null;
            using var doc = JsonDocument.Parse(response);
            return MapSearchItem(doc.RootElement, type);
        }
        catch (Exception ex) when (ex is JsonException or HttpRequestException)
        {
            logger.LogDebug(ex, "TMDB details lookup failed for {Id}", tmdbId);
            return null;
        }
    }

    private static TmdbSearchItem MapSearchItem(JsonElement item, string type)
    {
        string? Str(string name) =>
            item.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

        var posterPath = Str("poster_path");
        var posterUrl = posterPath != null ? PosterBaseUrl + posterPath : "";

        var isMovie = type == "movie";
        var genreIds = new List<long>();
        if (item.TryGetProperty("genre_ids", out var genreIdsEl) && genreIdsEl.ValueKind == JsonValueKind.Array)
        {
            genreIds.AddRange(genreIdsEl.EnumerateArray().Select(g => g.GetInt64()));
        }
        var genres = Genres.Where(g => genreIds.Contains(g.Id)).Select(g => g.Name).ToList();

        string? originalLanguage = null;
        if (item.TryGetProperty("original_language", out var langEl) && langEl.ValueKind == JsonValueKind.String)
        {
            originalLanguage = langEl.GetString();
        }
        if (!isMovie && item.TryGetProperty("genres", out var genresEl) && genresEl.ValueKind == JsonValueKind.Array)
        {
            genres = genresEl.EnumerateArray()
                .Where(g => g.TryGetProperty("name", out _))
                .Select(g => g.GetProperty("name").GetString() ?? "")
                .Where(n => n.Length > 0)
                .ToList();
        }

        return new TmdbSearchItem(
            item.GetProperty("id").GetInt64(),
            (isMovie ? Str("title") : Str("name")) ?? "",
            isMovie ? Str("original_title") : Str("original_name"),
            isMovie ? Str("release_date") : Str("first_air_date"),
            posterUrl,
            string.Join(", ", genres),
            IsAnime(originalLanguage, genreIds));
    }

    private async Task<string?> FetchWithBackoffAsync(string url, CancellationToken ct)
    {
        var client = httpClientFactory.CreateClient("tmdb");
        var waitMs = Interlocked.Read(ref _rateLimitedUntilMs) - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (waitMs > 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(waitMs), ct);
        }

        var response = await client.GetAsync(url, ct);
        if (response.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
        {
            var waitSeconds = 60;
            if (response.Headers.RetryAfter?.Delta is { } delta && delta > TimeSpan.Zero && delta <= TimeSpan.FromSeconds(300))
            {
                waitSeconds = (int)Math.Ceiling(delta.TotalSeconds);
            }
            Interlocked.Exchange(ref _rateLimitedUntilMs,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + waitSeconds * 1000L);
            logger.LogWarning("TMDB returned 429; waiting {Seconds}s before retrying", waitSeconds);
            await Task.Delay(TimeSpan.FromSeconds(waitSeconds), ct);
            response.Dispose();
            response = await client.GetAsync(url, ct);
        }
        using (response)
        {
            if (!response.IsSuccessStatusCode) return null;
            return await response.Content.ReadAsStringAsync(ct);
        }
    }
}