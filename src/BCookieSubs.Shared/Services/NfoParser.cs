using System.Text.RegularExpressions;

namespace BCookieSubs.Shared.Services;

public record NfoMetadata(
    string? Title,
    string? OriginalTitle,
    int? Year,
    string? Genres,
    long? TmdbId,
    string? PosterValue);

public static partial class NfoParser
{
    public static NfoMetadata? Parse(string nfoPath)
    {
        string content;
        try
        {
            content = File.ReadAllText(nfoPath);
        }
        catch (IOException)
        {
            return null;
        }

        if (EpisodeDetailsTagRegex().IsMatch(content)) return null;

        string? Pick(string tag)
        {
            var m = TagRegex(tag).Match(content);
            if (!m.Success) return null;
            var v = m.Groups[1].Value.Trim();
            return v.Length == 0 ? null : DecodeXmlEntities(v);
        }

        var title = Pick("title");
        var originalTitle = Pick("originaltitle");

        int? year = null;
        var yearStr = Pick("year");
        if (yearStr != null)
        {
            var ym = FourDigitRegex().Match(yearStr);
            if (ym.Success) year = int.Parse(ym.Groups[1].Value);
        }
        if (year == null)
        {
            foreach (var dateTag in new[] { "premiered", "releasedate", "aired" })
            {
                var d = Pick(dateTag);
                if (d == null) continue;
                var ym = FourDigitRegex().Match(d);
                if (ym.Success)
                {
                    year = int.Parse(ym.Groups[1].Value);
                    break;
                }
            }
        }

        var genres = string.Join(", ", GenreRegex().Matches(content)
            .Select(m => DecodeXmlEntities(m.Groups[1].Value.Trim()))
            .Where(g => g.Length > 0));
        var genresValue = genres.Length > 0 ? genres : null;

        long? tmdbId = null;
        var tmdbXml = TmdbIdTagRegex().Match(content);
        if (!tmdbXml.Success) tmdbXml = UniqueIdTmdbRegex().Match(content);
        if (tmdbXml.Success)
        {
            tmdbId = long.Parse(tmdbXml.Groups[1].Value);
        }
        else
        {
            var urlMatch = TmdbUrlRegex().Match(content);
            if (urlMatch.Success) tmdbId = long.Parse(urlMatch.Groups[1].Value);
        }

        string? posterValue = null;
        var artMatch = ArtBlockRegex().Match(content);
        if (artMatch.Success)
        {
            var posterMatch = TagRegex("poster").Match(artMatch.Groups[1].Value);
            if (posterMatch.Success)
            {
                var v = posterMatch.Groups[1].Value.Trim();
                if (v.Length > 0) posterValue = DecodeXmlEntities(v);
            }
        }

        return new NfoMetadata(title, originalTitle, year, genresValue, tmdbId, posterValue);
    }

    public static string? FindPrimaryNfoPath(string dir, string libraryType)
    {
        string[] entries;
        try
        {
            entries = Directory.GetFiles(dir, "*.nfo");
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        if (entries.Length == 0) return null;

        var preferred = libraryType == "movie" ? "movie.nfo" : "tvshow.nfo";
        var canonical = entries.FirstOrDefault(p =>
            Path.GetFileName(p).Equals(preferred, StringComparison.OrdinalIgnoreCase));
        if (canonical != null) return canonical;
        return libraryType == "movie"
            ? entries.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).First()
            : null;
    }

    public static string? ResolveNfoPoster(string nfoPath, string? posterValue)
    {
        if (posterValue == null) return null;
        var nfoDir = Path.GetDirectoryName(Path.GetFullPath(nfoPath))!;
        var baseName = Path.GetFileName(posterValue);
        foreach (var candidate in new[] { posterValue, Path.Combine(nfoDir, baseName), Path.Combine(nfoDir, "metadata", baseName) })
        {
            try
            {
                if (File.Exists(candidate)) return candidate;
            }
            catch (IOException)
            {
            }
        }
        return null;
    }

    public static string DecodeXmlEntities(string s) => s
        .Replace("&amp;", "&")
        .Replace("&lt;", "<")
        .Replace("&gt;", ">")
        .Replace("&quot;", "\"")
        .Replace("&apos;", "'");

    [GeneratedRegex(@"<episodedetails\b", RegexOptions.IgnoreCase)]
    private static partial Regex EpisodeDetailsTagRegex();

    [GeneratedRegex(@"(\d{4})")]
    private static partial Regex FourDigitRegex();

    [GeneratedRegex(@"<genre>\s*([^\s<][^<]*?)\s*</genre>", RegexOptions.IgnoreCase)]
    private static partial Regex GenreRegex();

    [GeneratedRegex(@"<tmdbid>\s*(\d+)\s*</tmdbid>", RegexOptions.IgnoreCase)]
    private static partial Regex TmdbIdTagRegex();

    [GeneratedRegex(@"<uniqueid[^>]+type=[""']tmdb[""'][^>]*>\s*(\d+)\s*</uniqueid>", RegexOptions.IgnoreCase)]
    private static partial Regex UniqueIdTmdbRegex();

    [GeneratedRegex(@"themoviedb\.org/(?:movie|tv)/(\d+)")]
    private static partial Regex TmdbUrlRegex();

    [GeneratedRegex(@"<art>([\s\S]*?)</art>", RegexOptions.IgnoreCase)]
    private static partial Regex ArtBlockRegex();

    private static Regex TagRegex(string tag) => new(
        $@"<{tag}[^>]*>\s*([\s\S]*?)\s*</{tag}>", RegexOptions.IgnoreCase);
}