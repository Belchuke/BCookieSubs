using System.Text.RegularExpressions;
using BCookieSubs.Shared.Services.Media;

namespace BCookieSubs.Shared.Services;

public static partial class LibraryNameParser
{
    public static readonly HashSet<string> VideoExtensions =
        [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".ts", ".mpg", ".mpeg", ".flv", ".webm"];

    public static bool IsVideoFile(string filePath) =>
        VideoExtensions.Contains(Path.GetExtension(filePath).ToLowerInvariant());

    public static bool IsSampleFile(string filename) =>
        SampleFileRegex().IsMatch(Path.GetFileNameWithoutExtension(filename));

    public static int? ParseSeasonFolderName(string folderName)
    {
        var t = folderName.Trim();
        if (SeasonFolderSpecialsRegex().IsMatch(t)) return 0;
        var exact = SeasonFolderExactRegex().Match(t);
        if (exact.Success) return int.Parse(exact.Groups[1].Value);
        var embedded = SeasonFolderEmbeddedRegex().Match(t);
        if (embedded.Success) return int.Parse(embedded.Groups[1].Value);
        var release = SeasonFolderReleaseRegex().Match(t);
        if (release.Success) return int.Parse(release.Groups[1].Value);
        return null;
    }

    public static int? ParseEpisodeFromFilename(string filename)
    {
        var baseName = Path.GetFileNameWithoutExtension(filename);
        var se = EpisodeSxxExxRegex().Match(baseName);
        if (se.Success) return int.Parse(se.Groups[1].Value);
        var x = EpisodeXyyRegex().Match(baseName);
        if (x.Success) return int.Parse(x.Groups[1].Value);
        var e = EpisodeStandaloneRegex().Match(baseName);
        if (e.Success) return int.Parse(e.Groups[1].Value);
        var ep = EpisodeWordRegex().Match(baseName);
        if (ep.Success) return int.Parse(ep.Groups[1].Value);
        var sp = EpisodeSpecialRegex().Match(baseName);
        if (sp.Success) return int.Parse(sp.Groups[1].Value);
        var anime = EpisodeAnimeRegex().Match(baseName);
        if (anime.Success) return int.Parse(anime.Groups[1].Value);
        return null;
    }

    public static int? ParseSeasonFromFilename(string filename)
    {
        var baseName = Path.GetFileNameWithoutExtension(filename);
        var se = SeasonSxxExxRegex().Match(baseName);
        if (se.Success) return int.Parse(se.Groups[1].Value);
        var x = SeasonXyyRegex().Match(baseName);
        if (x.Success) return int.Parse(x.Groups[1].Value);
        var seasonWord = SeasonWordRegex().Match(baseName);
        if (seasonWord.Success) return int.Parse(seasonWord.Groups[1].Value);
        return null;
    }

    public static bool IsFractionalSpecial(string filename) =>
        FractionalSpecialRegex().IsMatch(Path.GetFileNameWithoutExtension(filename));

    public static bool HasSxxExxMarker(string filename) =>
        SxxExxDetectRegex().IsMatch(Path.GetFileNameWithoutExtension(filename));

    public static string GetSeriesRootDir(string filePath, string libraryPathRoot)
    {
        var normalizedRoot = Path.GetFullPath(libraryPathRoot);
        var current = Path.GetDirectoryName(Path.GetFullPath(filePath))!;
        if (current == normalizedRoot) return libraryPathRoot;
        while (true)
        {
            var parent = Path.GetDirectoryName(current);
            if (parent == null || parent == current) return Path.GetDirectoryName(Path.GetFullPath(filePath))!;
            if (parent == normalizedRoot) return current;
            current = parent;
        }
    }

    public static string? GetSeasonFolderNameBetween(string filePath, string seriesRootDir)
    {
        var normalizedRoot = Path.GetFullPath(seriesRootDir);
        var normalizedParent = Path.GetDirectoryName(Path.GetFullPath(filePath))!;
        if (normalizedParent == normalizedRoot) return null;
        var current = normalizedParent;
        while (true)
        {
            var parent = Path.GetDirectoryName(current);
            if (parent == null) return null;
            if (parent == normalizedRoot) return Path.GetFileName(current);
            if (parent == current) return null;
            current = parent;
        }
    }

    public static Dictionary<string, int> ComputeSeasonEpisodeRebase(
        IReadOnlyList<string> videoFiles, string libraryRootPath)
    {
        var groups = new Dictionary<string, (int Min, bool HasSxxExx, bool Any)>();
        foreach (var vf in videoFiles)
        {
            var seriesRoot = GetSeriesRootDir(vf, libraryRootPath);
            var seasonFolder = GetSeasonFolderNameBetween(vf, seriesRoot);
            if (seasonFolder == null) continue;
            if (IsFractionalSpecial(vf)) continue;
            var key = Path.GetFullPath(seriesRoot) + Path.DirectorySeparatorChar + seasonFolder;
            var episode = ParseEpisodeFromFilename(vf);
            var hasSxxExx = HasSxxExxMarker(vf);
            if (!groups.TryGetValue(key, out var g)) g = (int.MaxValue, false, false);
            g.HasSxxExx |= hasSxxExx;
            if (episode != null)
            {
                g.Any = true;
                g.Min = Math.Min(g.Min, episode.Value);
            }
            groups[key] = g;
        }

        var offsets = new Dictionary<string, int>();
        foreach (var (key, g) in groups)
        {
            if (!g.Any || g.HasSxxExx || g.Min <= 1) continue;
            offsets[key] = g.Min - 1;
        }
        return offsets;
    }


    public static string StripReleaseTokens(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;
        var stripped = ReleaseTokenRegex().Replace(DotsAndUnderscoresToSpaces(name), " ");
        return WhitespaceRegex().Replace(stripped, " ").Trim();
    }

    private static string DotsAndUnderscoresToSpaces(string name)
    {
        var sb = new System.Text.StringBuilder(name.Length);
        foreach (var c in name) sb.Append(c is '.' or '_' ? ' ' : c);
        return sb.ToString();
    }

    public static long? ParseTmdbIdFromFolderName(string folderName)
    {
        var m = TmdbFolderTagRegex().Match(folderName);
        return m.Success ? long.Parse(m.Groups[1].Value) : null;
    }

    public static string StripFolderIdTags(string folderName) =>
        FolderIdTagRegex().Replace(folderName, "").Trim();

    /// <summary>Junk TMDB entries never auto-assigned to movies (e.g. the "Subs" placeholder entry).</summary>
    public static readonly long[] BlockedTmdbIdsForMovies = [1054041];

    public static bool IsBlockedTmdbId(long? tmdbId, string libraryType) =>
        libraryType == "movie" && tmdbId != null && BlockedTmdbIdsForMovies.Contains(tmdbId.Value);

    // ── Folder/stem classification ─────────────────────────────────────────

    // ISO 639-1 / 639-2/B codes plus common English names, for bare-language
    // subtitle stems ("english.srt", "spa.srt", "pt-BR.srt").
    public static readonly HashSet<string> LanguageNameTokens = new(StringComparer.Ordinal)
    {
        "eng", "en", "spa", "es", "fre", "fra", "fr", "ger", "de", "ita", "it", "por", "pt",
        "rus", "ru", "jpn", "ja", "kor", "ko", "chi", "zho", "zh", "ara", "ar", "hin", "hi",
        "tur", "tr", "dut", "nld", "nl", "pol", "pl", "swe", "sv", "nor", "no", "dan", "da",
        "fin", "fi", "gre", "ell", "el", "cze", "ces", "cs", "heb", "he", "hun", "hu", "rom",
        "ron", "ro", "tha", "th", "vie", "vi", "ind", "id", "may", "msa", "ms", "ukr", "uk",
        "bul", "bg", "hrv", "hr", "srp", "sr", "slk", "sk", "slv", "sl", "est", "et", "lav",
        "lv", "lit", "lt", "per", "fas", "fa", "cat", "ca", "glg", "gl", "ben", "bn", "tam",
        "ta", "tel", "te", "mal", "ml", "pan", "pa", "gla", "gd", "wel", "cym", "cy",
        "english", "spanish", "french", "german", "italian", "portuguese", "russian",
        "japanese", "korean", "chinese", "arabic", "hindi", "turkish", "dutch", "polish",
        "swedish", "norwegian", "danish", "finnish", "greek", "czech", "hebrew", "hungarian",
        "romanian", "thai", "vietnamese", "indonesian", "malay", "ukrainian", "bulgarian",
        "croatian", "serbian", "slovak", "slovenian", "estonian", "latvian", "lithuanian",
        "persian", "catalan", "galician", "bengali", "tamil", "telugu", "malayalam", "punjabi",
        "scottish", "welsh",
    };

    /// <summary>Subtitle stem that is only a language tag ("english", "pt-BR", "spa.SDH").</summary>
    public static bool IsLanguageOnlyStem(string stem)
    {
        var raw = stem.Trim().ToLowerInvariant();
        if (raw.Length == 0 || YearRegex().IsMatch(raw)) return false;
        var parts = raw.Split(['.', '_', '-'], StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return false;
        if (!LanguageNameTokens.Contains(parts[0])) return false;
        var suffix = string.Join("-", parts.Skip(1));
        return suffix.Length <= 6;
    }

    public static bool IsInSubsFolder(string srtPath) =>
        SubsFolderRegex().IsMatch(Path.GetFileName(Path.GetDirectoryName(Path.GetFullPath(srtPath))!));

    public static bool IsInExtrasFolder(string videoPath) =>
        ExtrasFolderRegex().IsMatch(Path.GetFileName(Path.GetDirectoryName(Path.GetFullPath(videoPath))!));

    /// <summary>Normalize a stem for companion matching: whitespace/dot/dash/underscore runs → single dot, lowercase.</summary>
    public static string NormalizeCompanionStem(string stem) =>
        CompanionSeparatorRegex().Replace(stem.ToLowerInvariant(), ".");

    // ── Source selection ───────────────────────────────────────────────────

    /// <summary>Pick the best subtitle file: source-language match, then text over image, then largest.</summary>
    public static string? SelectBestSrt(
        IReadOnlyList<string> companions,
        IReadOnlyList<string> standalone,
        string sourceLangIso639,
        string sourceLangName)
    {
        var pool = companions.Count > 0 ? companions : standalone;
        if (pool.Count == 0) return null;
        if (pool.Count == 1) return pool[0];

        var lowerIso = sourceLangIso639.ToLowerInvariant();
        var lowerName = sourceLangName.ToLowerInvariant();

        var langMatches = pool.Where(f =>
        {
            var lower = Path.GetFileName(f).ToLowerInvariant();
            var subExt = SubtitleFileTypes.SubtitleFileExtensionOf(lower);
            var baseName = subExt != null ? lower[..^subExt.Length] : lower;
            var lastDotPart = baseName.Contains('.') ? baseName.Split('.')[^1] : "";
            var hasLangSuffix = lastDotPart.Length >= 2 && lastDotPart.Length <= 8;
            return !hasLangSuffix || lastDotPart == lowerIso || lastDotPart == lowerName;
        }).ToList();

        var candidates = langMatches.Count > 0 ? langMatches : pool;
        var textCandidates = candidates
            .Where(f => !SubtitleFileTypes.IsSubFile(f) && !SubtitleFileTypes.IsSupFile(f))
            .ToList();
        var sameClass = textCandidates.Count > 0 ? textCandidates : candidates;

        string? best = null;
        foreach (var f in sameClass)
        {
            if (best == null) { best = f; continue; }
            try
            {
                if (new FileInfo(f).Length > new FileInfo(best).Length) best = f;
            }
            catch (IOException)
            {
            }
        }
        return best;
    }

    // ── Regexes ────────────────────────────────────────────────────────────

    [GeneratedRegex(@"^sample(?:[._-].*)?$", RegexOptions.IgnoreCase)]
    private static partial Regex SampleFileRegex();

    [GeneratedRegex(@"^(?:specials?|ova|extras?)$", RegexOptions.IgnoreCase)]
    private static partial Regex SeasonFolderSpecialsRegex();

    [GeneratedRegex(@"^(?:season|series|se?)\s*0?(\d{1,2})$", RegexOptions.IgnoreCase)]
    private static partial Regex SeasonFolderExactRegex();

    [GeneratedRegex(@"\bseason\s+0?(\d{1,2})\b", RegexOptions.IgnoreCase)]
    private static partial Regex SeasonFolderEmbeddedRegex();

    [GeneratedRegex(@"\bS0?(\d{1,2})\b", RegexOptions.IgnoreCase)]
    private static partial Regex SeasonFolderReleaseRegex();

    [GeneratedRegex(@"[Ss]\d{1,2}[Ee][Pp]?(\d{1,3})")]
    private static partial Regex EpisodeSxxExxRegex();

    [GeneratedRegex(@"\b\d{1,2}[xX](\d{2,3})\b")]
    private static partial Regex EpisodeXyyRegex();

    [GeneratedRegex(@"(?<![A-Za-z0-9])E[Pp]?(\d{1,3})(?![A-Za-z0-9])")]
    private static partial Regex EpisodeStandaloneRegex();

    [GeneratedRegex(@"\bepisode\s*(\d{1,3})\b", RegexOptions.IgnoreCase)]
    private static partial Regex EpisodeWordRegex();

    [GeneratedRegex(@"\bSP(\d{1,3})\b", RegexOptions.IgnoreCase)]
    private static partial Regex EpisodeSpecialRegex();

    [GeneratedRegex(@"[\s._-]+-[\s._-]+(\d{2,3})(?:[\s._-]+-[\s._-]+|[\s._-]*$|[\s._-]*\()")]
    private static partial Regex EpisodeAnimeRegex();

    [GeneratedRegex(@"[Ss](\d{1,2})[Ee][Pp]?\d{1,3}")]
    private static partial Regex SeasonSxxExxRegex();

    [GeneratedRegex(@"\b(\d{1,2})[xX]\d{2,3}\b")]
    private static partial Regex SeasonXyyRegex();

    [GeneratedRegex(@"\bseason\s*0?(\d{1,2})\b", RegexOptions.IgnoreCase)]
    private static partial Regex SeasonWordRegex();

    [GeneratedRegex(@"[Ss]\d{1,2}[Ee][Pp]?\d{1,3}\.\d(?![.\d])")]
    private static partial Regex FractionalSpecialRegex();

    [GeneratedRegex(@"[Ss]\d{1,2}[Ee][Pp]?\d{1,3}")]
    private static partial Regex SxxExxDetectRegex();

    [GeneratedRegex(@"[\[\{]\s*tm(?:db(?:id)?|bid)-(\d+)\s*[\]\}]", RegexOptions.IgnoreCase)]
    private static partial Regex TmdbFolderTagRegex();

    [GeneratedRegex(@"[\[\{]\s*(?:tm(?:db(?:id)?|bid)|imdb|tvdb)-[^\]\}]*[\]\}]", RegexOptions.IgnoreCase)]
    private static partial Regex FolderIdTagRegex();

    [GeneratedRegex(@"(?<![A-Za-z0-9])(?:2160p|1080p|720p|576p|480p|4k|uhd|hdr10|hdr|dv|dovi|10bit|8bit|sdr|web-?dl|web-?rip|webrip|webdl|blu-?ray|bdrip|brrip|dvdrip|dvdscr|remux|hdrip|hdtv|pdtv|dsrtv|cam|ts-?hdtc|tc|scr|satrip|tvrip|x264|x265|h264|h265|hevc|avc|vc1|vp9|av1|aac|ac3|eac3|ddp|dd|dts-?hd|dts-?ma|truehd|atmos|5[ .]1|7[ .]1|2[ .]0|2ch|6ch|8ch|repack|proper|internal|limited|festival|3d|imax|nf|amzn|atvp|cmor|hulu|dsnp|starz|crchd|galaxyrg|rarbg|yts|ettv|eztv|tigole|joy|psa|rmteam|footographe|nikita|d3g|telly)(?![A-Za-z0-9])", RegexOptions.IgnoreCase)]
    private static partial Regex ReleaseTokenRegex();

    [GeneratedRegex(@"\b(?:19|20)\d{2}\b")]
    private static partial Regex YearRegex();

    [GeneratedRegex(@"^subs$", RegexOptions.IgnoreCase)]
    private static partial Regex SubsFolderRegex();

    [GeneratedRegex(@"^(featurettes?|extras?|special\s*features?|bonus)$", RegexOptions.IgnoreCase)]
    private static partial Regex ExtrasFolderRegex();

    [GeneratedRegex(@"[\s._-]+")]
    private static partial Regex CompanionSeparatorRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();
}