using System.Text.Json;
using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Shared.Services;

public record LibraryMatchResult(
    long? MediaItemId,
    bool MultipleMatches,
    List<long> CandidateMediaItemIds,
    int? Season,
    int? Episode,
    int? DetectedYear);

public record NameFormatterDetection(
    string? Name,
    string Type,
    int? Year,
    int? Season,
    int? Episode,
    List<TmdbSearchItem> TheMovieDbRequestResult);

public partial class LibraryMatchingService(
    MediaItemService mediaItems,
    MediaItemRepository mediaItemRepo,
    TheMovieDbService tmdb,
    LlmChatService llm,
    ModelRepository models,
    PromptRepository prompts,
    ApplicationConfigRepository configs,
    UserRepository users,
    PermissionService permissions,
    ApplicationLogRepository logs,
    ILogger<LibraryMatchingService> logger)
{
    public const string NameDetectionPermission = "canAddSubtitleToTranslateDashboard";
    public const string TmdbMatcherPromptName = "theMovieDBMatchingPrompt";

    private static readonly JsonSerializerOptions DetectionJson = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    [GeneratedRegex(@"[Ss](\d{1,2})[Ee](\d{1,2})")]
    private static partial Regex FinalSxxExxRegex();

    public async Task<LibraryMatchResult> MatchAsync(
        string fileName, string libraryType, string libraryPathRoot, CancellationToken ct = default)
    {
        var libraryTypeKind = libraryType == "movie" ? MediaKind.Movie : MediaKind.Series;
        var actingUserId = (await users.GetHighestRoleUserAsync(ct))?.Id;

        int? season = null;
        int? episode = null;
        int? detectedYear = null;
        List<long> candidateMediaItemIds = [];

        var nfoDir = libraryType == "series"
            ? LibraryNameParser.GetSeriesRootDir(fileName, libraryPathRoot)
            : Path.GetDirectoryName(Path.GetFullPath(fileName))!;
        var nfoPath = NfoParser.FindPrimaryNfoPath(nfoDir, libraryType);
        var nfoMeta = nfoPath != null ? NfoParser.Parse(nfoPath) : null;

        if (nfoMeta is { Title: not null, Genres: not null })
        {
            var nfoPoster = NfoParser.ResolveNfoPoster(nfoPath!, nfoMeta.PosterValue);
            if (nfoPoster != null)
            {
                try
                {
                    var mediaResult = await mediaItems.CreateAsync(
                        actingUserId, nfoMeta.Title, nfoMeta.OriginalTitle, libraryTypeKind,
                        nfoMeta.Year, false, nfoMeta.Genres,
                        nfoMeta.TmdbId != null ? nfoMeta.TmdbId.ToString() : null,
                        localPosterPath: nfoPoster, ct: ct);
                    if (mediaResult.Success && mediaResult.MediaItem != null)
                    {
                        await LogAsync(LogLevelKind.Info, "nfoMatch", "libraryScanner",
                            $"NFO match for \"{Path.GetFileName(fileName)}\" → {nfoMeta.Title} (poster+genres from NFO; skipped TheMovieDatabase)",
                            new { fileName = Path.GetFileName(fileName), nfoPath, title = nfoMeta.Title, tmdbId = nfoMeta.TmdbId }, ct);
                        return new LibraryMatchResult(mediaResult.MediaItem.Id, false, [], null, null, nfoMeta.Year);
                    }
                }
                catch (Exception ex)
                {
                    await LogAsync(LogLevelKind.Warning, "nfoMatch", "libraryScanner",
                        $"NFO match failed for \"{Path.GetFileName(fileName)}\": {Truncate(ex.Message)}",
                        new { fileName = Path.GetFileName(fileName), nfoPath, error = ex.ToString() }, ct);
                }
            }
        }

        var config = await configs.GetAsync(ct);
        var idSources = new List<(long TmdbId, string Source)>();
        if (nfoMeta?.TmdbId is { } nfoTmdbId) idSources.Add((nfoTmdbId, "NFO"));
        var folderTmdbId = LibraryNameParser.ParseTmdbIdFromFolderName(Path.GetFileName(nfoDir));
        if (folderTmdbId is { } folderId && folderId != nfoMeta?.TmdbId) idSources.Add((folderId, "folder name"));

        foreach (var (tmdbId, source) in idSources)
        {
            try
            {
                if (LibraryNameParser.IsBlockedTmdbId(tmdbId, libraryType))
                {
                    await LogAsync(LogLevelKind.Info, "tmdbBlocked", "libraryScanner",
                        $"Blocked TMDB junk id {tmdbId} ({source}) for \"{Path.GetFileName(fileName)}\"; skipping and leaving Unmatched",
                        new { fileName = Path.GetFileName(fileName), tmdbId, tmdbIdSource = source }, ct);
                    continue;
                }
                var details = await tmdb.DetailsAsync(tmdbId, libraryType, ct);
                if (details != null)
                {
                    var tmdbYear = ParseYear(details.ReleaseDate);
                    var mediaResult = await mediaItems.CreateAsync(
                        actingUserId, details.Name ?? tmdbId.ToString(), details.OriginalTitle, libraryTypeKind,
                        tmdbYear, details.IsAnime, details.Genres,
                        details.Id.ToString(), details.PosterUrl, ct: ct);
                    if (mediaResult.Success && mediaResult.MediaItem != null)
                    {
                        await LogAsync(LogLevelKind.Info, "tmdbMatch", "libraryScanner",
                            $"{source} TMDB match for \"{Path.GetFileName(fileName)}\" → {details.Name} (id {details.Id})",
                            new { fileName = Path.GetFileName(fileName), tmdbId, tmdbIdSource = source, title = details.Name }, ct);
                        return new LibraryMatchResult(mediaResult.MediaItem.Id, false, [], null, null, tmdbYear);
                    }
                }
                else if (config is { TheMovieDbActive: true })
                {
                    await LogAsync(LogLevelKind.Warning, "tmdbMatch", "libraryScanner",
                        $"TMDB id {tmdbId} ({source}) did not resolve for \"{Path.GetFileName(fileName)}\"; continuing to fallback matching",
                        new { fileName = Path.GetFileName(fileName), tmdbId, tmdbIdSource = source }, ct);
                }
            }
            catch (Exception ex)
            {
                await LogAsync(LogLevelKind.Warning, "tmdbMatch", "libraryScanner",
                    $"{source} TMDB fetch failed for \"{Path.GetFileName(fileName)}\": {Truncate(ex.Message)}",
                    new { fileName = Path.GetFileName(fileName), tmdbId, tmdbIdSource = source }, ct);
            }
        }

        var stem = Path.GetFileNameWithoutExtension(fileName);
        var detectionNames = new List<string>();
        if (libraryType == "series")
        {
            var seriesRoot = LibraryNameParser.GetSeriesRootDir(fileName, libraryPathRoot);
            detectionNames.Add(LibraryNameParser.StripReleaseTokens(Path.GetFileName(seriesRoot)));
            var cleanStem = LibraryNameParser.StripReleaseTokens(stem);
            if (cleanStem.Length > 0 && !detectionNames.Contains(cleanStem)) detectionNames.Add(cleanStem);
        }
        else
        {
            var dir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(fileName))!);
            var root = Path.GetFullPath(libraryPathRoot);
            var folderName = dir == root ? null : LibraryNameParser.StripReleaseTokens(LibraryNameParser.StripFolderIdTags(Path.GetFileName(dir)));
            var cleanStem = LibraryNameParser.StripReleaseTokens(stem);
            detectionNames.Add(cleanStem);
            if (!string.IsNullOrEmpty(folderName) && folderName != cleanStem) detectionNames.Add(folderName);
        }

        DetectionOutcome? multipleOutcome = null;
        for (var i = 0; i < detectionNames.Count; i++)
        {
            var outcome = await AttemptDetectionMatchAsync(
                actingUserId, detectionNames[i], libraryType, fileName, ct);

            if (outcome.Status == "matched")
            {
                return new LibraryMatchResult(outcome.MediaItemId, false, [],
                    outcome.Season, outcome.Episode, outcome.DetectedYear);
            }

            if (outcome.Status == "multiple" && multipleOutcome == null)
            {
                multipleOutcome = outcome;
            }

            if (outcome.Season is { } s) season = s;
            if (outcome.Episode is { } e) episode = e;
            if (outcome.DetectedYear is { } y) detectedYear = y;

            if (libraryType == "series" && i == 0 && outcome.Status == "multiple" &&
                multipleOutcome is { CandidateMediaItemIds.Count: > 0 })
            {
                break;
            }
        }

        if (multipleOutcome != null)
        {
            return new LibraryMatchResult(null, true, multipleOutcome.CandidateMediaItemIds,
                multipleOutcome.Season, multipleOutcome.Episode, multipleOutcome.DetectedYear);
        }

        if (season == null || episode == null)
        {
            var seMatch = FinalSxxExxRegex().Match(Path.GetFileName(fileName));
            if (seMatch.Success)
            {
                season = int.Parse(seMatch.Groups[1].Value);
                episode = int.Parse(seMatch.Groups[2].Value);
            }
        }

        return new LibraryMatchResult(null, false, [], season, episode, detectedYear);
    }

    private sealed record DetectionOutcome(
        string Status, int? Season, int? Episode, int? DetectedYear,
        long? MediaItemId, List<long> CandidateMediaItemIds);

    public Task<NameFormatterDetection?> DetectSubtitleNameAsync(
        long userId, string fileName, string? forcedType = null, CancellationToken ct = default) =>
        DetectFromPromptAsync(userId, fileName, forcedType, fileName, ct);

    private async Task<DetectionOutcome> AttemptDetectionMatchAsync(
        long? actingUserId, string detectionName, string libraryType, string fileName, CancellationToken ct)
    {
        int? attemptSeason = null;
        int? attemptEpisode = null;
        int? attemptYear = null;
        var attemptCandidates = new List<long>();
        var libraryTypeKind = libraryType == "movie" ? MediaKind.Movie : MediaKind.Series;

        try
        {
            var detected = await DetectFromPromptAsync(actingUserId, detectionName, libraryType, fileName, ct);
            if (detected != null)
            {
                attemptSeason = detected.Season;
                attemptEpisode = detected.Episode;
                attemptYear = detected.Year;

                var rawResults = detected.TheMovieDbRequestResult;
                var results = rawResults.Where(r => !LibraryNameParser.IsBlockedTmdbId(r.Id, libraryType)).ToList();
                var hadOnlyBlockedResults = rawResults.Count > 0 && results.Count == 0;

                if (results.Count > 0)
                {
                    var filtered = attemptYear is { } ay
                        ? results.Where(r =>
                        {
                            var releaseYear = ParseYear(r.ReleaseDate);
                            return releaseYear == null || releaseYear == ay;
                        }).ToList()
                        : results;
                    if (filtered.Count == 0) filtered = results;

                    if (filtered.Count == 1)
                    {
                        var match = filtered[0];
                        var mediaResult = await CreateFromTmdbItemAsync(
                            actingUserId, match, detected.Name, libraryTypeKind, attemptYear, ct);
                        if (mediaResult.Success && mediaResult.MediaItem != null)
                        {
                            return new DetectionOutcome("matched", attemptSeason, attemptEpisode, attemptYear,
                                mediaResult.MediaItem.Id, []);
                        }
                    }
                    else
                    {
                        var aiWinner = await SelectBestTheMovieDbMatchAsync(
                            actingUserId, detectionName, filtered, fileName, ct);
                        if (aiWinner != null)
                        {
                            var mediaResult = await CreateFromTmdbItemAsync(
                                actingUserId, aiWinner, detected.Name, libraryTypeKind, attemptYear, ct);
                            if (mediaResult.Success && mediaResult.MediaItem != null)
                            {
                                return new DetectionOutcome("matched", attemptSeason, attemptEpisode, attemptYear,
                                    mediaResult.MediaItem.Id, []);
                            }
                        }

                        await LogAsync(LogLevelKind.Info, "tmdbMultiple", "libraryScanner",
                            $"Multiple TMDb candidates for \"{Path.GetFileName(fileName)}\" from \"{detectionName}\"; falling back to manual selection",
                            new { fileName = Path.GetFileName(fileName), detectionName, candidateCount = filtered.Count }, ct);

                        foreach (var match in filtered)
                        {
                            var mediaResult = await CreateFromTmdbItemAsync(
                                actingUserId, match, detected.Name, libraryTypeKind, attemptYear, ct);
                            if (mediaResult.Success && mediaResult.MediaItem != null)
                            {
                                attemptCandidates.Add(mediaResult.MediaItem.Id);
                            }
                        }
                        return new DetectionOutcome("multiple", attemptSeason, attemptEpisode, attemptYear,
                            null, attemptCandidates);
                    }
                }
                else if (hadOnlyBlockedResults)
                {
                    await LogAsync(LogLevelKind.Info, "tmdbBlocked", "libraryScanner",
                        $"Blocked TMDB junk match for \"{Path.GetFileName(fileName)}\"; leaving Unmatched",
                        new { fileName = Path.GetFileName(fileName), detectionName, blockedIds = rawResults.Select(r => r.Id).ToArray() }, ct);
                }
                else if (detected.Name != null)
                {
                    var existing = await mediaItemRepo.GetByKeysAsync(null, detected.Name, libraryTypeKind, attemptYear, ct);
                    if (existing != null)
                    {
                        return new DetectionOutcome("matched", attemptSeason, attemptEpisode, attemptYear,
                            existing.Id, []);
                    }

                    if (libraryType == "series")
                    {
                        var matched = await mediaItemRepo.FindSeriesReusableAsync(detected.Name, ct);
                        if (matched != null)
                        {
                            await LogAsync(LogLevelKind.Info, "seriesReuse", "libraryScanner",
                                $"Reusing matched series media item for \"{Path.GetFileName(fileName)}\" → \"{detected.Name}\" (id {matched.Id})",
                                new { fileName = Path.GetFileName(fileName), detectionName, detectedName = detected.Name, mediaItemId = matched.Id }, ct);
                            return new DetectionOutcome("matched", attemptSeason, attemptEpisode, attemptYear,
                                matched.Id, []);
                        }
                    }

                    var placeholder = await mediaItems.CreateAsync(
                        actingUserId, detected.Name, null, libraryTypeKind, attemptYear, false, null, ct: ct);
                    if (placeholder.Success && placeholder.MediaItem != null)
                    {
                        return new DetectionOutcome("matched", attemptSeason, attemptEpisode, attemptYear,
                            placeholder.MediaItem.Id, []);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            await LogAsync(LogLevelKind.Warning, "nameDetection", "libraryScanner",
                $"Name detection failed for file: {Path.GetFileName(fileName)}",
                new { fileName, libraryType, detectionName, error = ex.ToString() }, ct);
        }

        return new DetectionOutcome("none", attemptSeason, attemptEpisode, attemptYear, null, []);
    }

    private async Task<MediaItemCreateResult> CreateFromTmdbItemAsync(
        long? actingUserId, TmdbSearchItem match, string? fallbackName,
        MediaKind libraryTypeKind, int? attemptYear, CancellationToken ct)
    {
        var tmdbYear = ParseYear(match.ReleaseDate);
        return await mediaItems.CreateAsync(
            actingUserId,
            match.Name ?? fallbackName ?? string.Empty,
            match.OriginalTitle,
            libraryTypeKind,
            tmdbYear ?? attemptYear,
            match.IsAnime,
            match.Genres.Length > 0 ? match.Genres : null,
            match.Id.ToString(),
            match.PosterUrl.Length > 0 ? match.PosterUrl : null,
            ct: ct);
    }

    private async Task<NameFormatterDetection?> DetectFromPromptAsync(
        long? actingUserId, string detectionName, string? forcedType, string fileName, CancellationToken ct)
    {
        if (detectionName.Length == 0) return null;
        var config = await configs.GetAsync(ct);
        if (config is not { NameDetectionActive: true }) return null;

        if (actingUserId is not { } userId) return null;
        var perms = await permissions.GetEffectivePermissionsAsync(userId, ct);
        if (!perms.Contains(NameDetectionPermission)) return null;

        var candidates = await models.GetActiveByRoleAsync(ModelRoleKind.NameFormatter, ct);
        if (candidates.Count == 0) return null;
        var promptVersion = await prompts.GetActiveVersionByKindAsync(PromptKind.NameFormatter, ct);
        if (promptVersion == null) return null;

        var finishedPrompt = promptVersion.PromptText.Replace("//filename//", detectionName);

        try
        {
            var response = await llm.ChatAsync(candidates[0], finishedPrompt, ct: ct);
            var json = LlmChatService.ExtractJsonObject(response.Content);
            if (json == null) return null;

            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            string? Str(string prop) =>
                root.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String
                    ? el.GetString()
                    : null;
            int? Num(string prop) =>
                root.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.Number
                    ? el.GetInt32()
                    : null;

            var name = Str("name");
            var type = Str("type") is { } t && t is "series" or "movie" ? t : "movie";
            var detection = new NameFormatterDetection(
                name, type, Num("year"), Num("season"), Num("episode"), []);

            var searchType = forcedType ?? detection.Type;
            var (items, _) = await tmdb.SearchAsync(detection.Name ?? "", searchType, detection.Year, ct);
            if (items.Count > 0)
            {
                detection = detection with { TheMovieDbRequestResult = items };
            }
            return detection;
        }
        catch (Exception ex)
        {
            await LogAsync(LogLevelKind.Error, "nameFormatter", "nameFormatter",
                $"Name formatter failed for \"{fileName}\": {Truncate(ex.Message)}",
                new { fileName, error = ex.ToString() }, ct);
            return null;
        }
    }

    // TheMovieDb match selection: LLM picks one candidate; winnerId -1
    // means "no good match". Returns null whenever there is no confident winner.
    private async Task<TmdbSearchItem?> SelectBestTheMovieDbMatchAsync(
        long? actingUserId, string fileName, List<TmdbSearchItem> candidates, string detectionName,
        CancellationToken ct)
    {
        if (detectionName.Length == 0 || candidates.Count == 0) return null;
        var config = await configs.GetAsync(ct);
        if (config is not { NameDetectionActive: true }) return null;

        if (actingUserId is not { } userId) return null;
        var perms = await permissions.GetEffectivePermissionsAsync(userId, ct);
        if (!perms.Contains(NameDetectionPermission)) return null;

        var modelsByRole = await models.GetActiveByRoleAsync(ModelRoleKind.NameFormatter, ct);
        if (modelsByRole.Count == 0) return null;
        var promptVersion = await prompts.GetActiveVersionByPromptNameAsync(TmdbMatcherPromptName, ct);
        if (promptVersion == null) return null;

        var candidateList = JsonSerializer.Serialize(candidates.Select(c => new
        {
            id = c.Id,
            title = c.Name,
            original_title = c.OriginalTitle,
            release_date = c.ReleaseDate,
            media_type = "movie | tv",
        }));
        var finishedPrompt = promptVersion.PromptText
            .Replace("//filename//", detectionName)
            .Replace("//TheMovieDBCandidate//", candidateList);

        try
        {
            var response = await llm.ChatAsync(modelsByRole[0], finishedPrompt, ct: ct);
            var json = LlmChatService.ExtractJsonObject(response.Content);
            if (json == null)
            {
                await LogAsync(LogLevelKind.Warning, "tmdbMatching", "libraryScanner",
                    $"theMovieDBMatchingPrompt returned no JSON object for \"{detectionName}\"",
                    new { fileName = detectionName, candidateCount = candidates.Count, rawResponse = Truncate(response.Content, 500) }, ct);
                return null;
            }

            long? winnerId = null;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("winnerId", out var w) && w.ValueKind == JsonValueKind.Number)
                {
                    winnerId = w.GetInt64();
                }
            }
            catch (JsonException)
            {
            }

            if (winnerId == null)
            {
                await LogAsync(LogLevelKind.Warning, "tmdbMatching", "libraryScanner",
                    $"theMovieDBMatchingPrompt returned malformed winnerId for \"{detectionName}\"",
                    new { fileName = detectionName, candidateCount = candidates.Count, json }, ct);
                return null;
            }
            if (winnerId == -1)
            {
                await LogAsync(LogLevelKind.Info, "tmdbMatching", "libraryScanner",
                    $"theMovieDBMatchingPrompt indicated no good match for \"{detectionName}\"",
                    new { fileName = detectionName, candidateCount = candidates.Count }, ct);
                return null;
            }

            var winner = candidates.FirstOrDefault(c => c.Id == winnerId.Value);
            if (winner == null)
            {
                await LogAsync(LogLevelKind.Warning, "tmdbMatching", "libraryScanner",
                    $"theMovieDBMatchingPrompt winnerId {winnerId} not in candidate list for \"{detectionName}\"",
                    new { fileName = detectionName, winnerId, candidateCount = candidates.Count, candidateIds = candidates.Select(c => c.Id).ToArray() }, ct);
                return null;
            }

            await LogAsync(LogLevelKind.Info, "tmdbMatching", "libraryScanner",
                $"theMovieDBMatchingPrompt executed for \"{detectionName}\" with {candidates.Count} candidates — AI soft-picked {winner.Id} ({winner.Name})",
                new { fileName = detectionName, candidateCount = candidates.Count, winnerId = winner.Id, winnerName = winner.Name }, ct);
            return winner;
        }
        catch (Exception ex)
        {
            await LogAsync(LogLevelKind.Warning, "tmdbMatching", "libraryScanner",
                $"theMovieDBMatchingPrompt failed for \"{detectionName}\": {Truncate(ex.Message)}",
                new { fileName = detectionName, error = ex.ToString() }, ct);
            return null;
        }
    }

    private static int? ParseYear(string? releaseDate)
    {
        if (string.IsNullOrEmpty(releaseDate)) return null;
        var dash = releaseDate.IndexOf('-');
        var yearPart = dash > 0 ? releaseDate[..dash] : releaseDate;
        return int.TryParse(yearPart, out var y) ? y : null;
    }

    private static string Truncate(string s, int max = 200) =>
        s.Length <= max ? s : s[..max];

    private async Task LogAsync(LogLevelKind level, string type, string entityType, string message,
        object? metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new ApplicationLog
            {
                Level = level,
                Type = type,
                EntityType = entityType,
                Message = message,
                Metadata = metadata is null ? null : JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            }, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to write application log for {Type}", type);
        }
    }
}