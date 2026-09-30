using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Storage;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Shared.Services;

public record RequestGroupItemDto(
    long ItemId, int? Season, int? Episode, string FileName, string LibraryPathName, long LibraryPathId,
    long? SubtitleId, List<long> MissingTargetLangIds, bool HasActiveJobs, string? WhisperStatus,
    bool IsVideo, bool HasSrt, List<long> TranslatedTargetLangIds,
    string? Title = null, bool? HasEmbedded = null, bool SubtitleDeleted = false);

public record RequestGroupDto(
    string Key, string Title, int? Year, string? Genres, string? PosterPath, string Type,
    List<RequestGroupItemDto> Items)
{
    public List<RequestGroupItemDto>? Extras { get; set; }
    public string? FilePath { get; set; }
    public bool FullyTranslated { get; set; }
}

public record LibraryRequestCounts(int Movie, int Series, int Unmatched);

public class LibraryRequestsService(
    BCookieSubsDbContext db,
    LibraryPathRepository libraryPaths,
    LibraryPathItemRepository items,
    SubtitleRepository subtitles,
    TranslatedLibraryItemRepository translatedItems,
    LanguageRepository languages,
    LibraryPathsService pathsService,
    MediaProbeService probe,
    ILibraryFileSystemFactory fsFactory,
    SubtitleTaskService tasks,
    ILogger<LibraryRequestsService> logger)
{
    private static bool IsMatched(LibraryItemDto item) => LibraryPathsService.IsMatched(item);

    public async Task<(List<RequestGroupDto> Groups, List<string> AllGenres)> GetDataAsync(
        long userId, string type, CancellationToken ct = default)
    {
        var groups = type == "unmatched"
            ? await BuildUnmatchedGroupsAsync(userId, ct)
            : await BuildRequestGroupsAsync(userId, type == "series" ? "series" : "movie", ct);

        var allGenres = new List<string>();
        foreach (var group in groups)
        {
            if (group.Genres == null) continue;
            foreach (var g in group.Genres.Split(','))
            {
                var trimmed = g.Trim();
                if (trimmed.Length > 0 && !allGenres.Contains(trimmed)) allGenres.Add(trimmed);
            }
        }
        allGenres.Sort(StringComparer.CurrentCulture);
        return (groups, allGenres);
    }

    public async Task<LibraryRequestCounts> GetCountsAsync(long userId, CancellationToken ct = default)
    {
        var movie = await BuildRequestGroupsAsync(userId, "movie", ct);
        var series = await BuildRequestGroupsAsync(userId, "series", ct);
        var unmatched = await BuildUnmatchedGroupsAsync(userId, ct);
        return new LibraryRequestCounts(movie.Count, series.Count, unmatched.Count);
    }

    public async Task<(bool Success, string? Msg, List<SubtitleSourceCandidate> Sources, bool CacheFresh)>
        GetSubtitleSourcesAsync(long itemId, CancellationToken ct = default)
    {
        var item = await items.GetAsync(itemId, ct);
        if (item == null) return (false, "Item not found", [], false);
        var lp = await libraryPaths.GetAsync(item.LibraryPathId, ct);
        if (lp == null) return (false, "Library path not found", [], false);
        if (await languages.GetAsync(lp.SourceLanguageId, ct) == null)
            return (false, "Source language not found", [], false);

        if (SubtitleFileTypes.IsSubtitleExtension(Path.GetExtension(item.Path)))
        {
            return (true, "Standalone subtitle — no source selection needed", [], true);
        }

        var cached = await items.GetSubtitleSourcesAsync(itemId, ct);
        if (cached == null) return (true, null, [], false);
        await using var fs = await fsFactory.CreateAsync(lp, ct);
        var fresh = await IsCacheFreshAsync(cached, item.Path, fs, ct);
        return (true, null, cached.Sources, fresh);
    }

    public async Task<(bool Success, string? Msg, List<SubtitleSourceCandidate> Sources)>
        RecomputeSubtitleSourcesAsync(long itemId, CancellationToken ct = default)
    {
        var item = await items.GetAsync(itemId, ct);
        if (item == null) return (false, "Item not found", []);
        var lp = await libraryPaths.GetAsync(item.LibraryPathId, ct);
        if (lp == null) return (false, "Library path not found", []);
        var sourceLang = await languages.GetAsync(lp.SourceLanguageId, ct);
        if (sourceLang == null) return (false, "Source language not found", []);

        await using var fs = await fsFactory.CreateAsync(lp, ct);
        string? staged = null;
        try
        {
            if (fs.IsRemote)
                staged = await fs.StageToWorkAsync(item.Path, LibraryStaging.ScanDir(lp.Id), ct);
            var sources = await probe.ListSubtitleSourcesAsync(
                item.Path, sourceLang.Iso639, sourceLang.Iso6392B, sourceLang.Name, true, ct, fs, staged);
            var st = await fs.StatAsync(item.Path, ct);
            await items.UpsertSubtitleSourcesAsync(itemId, sources,
                st != null ? st.LastWriteTimeUtc.Ticks / TimeSpan.TicksPerMillisecond : 0,
                st?.Size ?? 0, ct);
            return (true, null, sources);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to recompute subtitle sources for item {ItemId} at {Path}", itemId, item.Path);
            return (false, "Failed to probe subtitle sources", []);
        }
        finally
        {
            LibraryStaging.SafeDeleteFile(staged);
        }
    }

    public async Task<SubtitleTaskResult> AddMissingLanguagesAsync(
        long userId, long itemId, List<long> targetLangIds, CancellationToken ct = default)
    {
        var subtitleId = await db.Subtitles.AsNoTracking()
            .Where(s => s.LibraryPathItemId == itemId && s.DeletedAt == null)
            .OrderByDescending(s => s.Id)
            .Select(s => (long?)s.Id)
            .FirstOrDefaultAsync(ct);
        if (subtitleId == null)
            return new SubtitleTaskResult(false, "No existing subtitle to add jobs to");
        return await tasks.AddMissingTargetLanguageJobsAsync(userId, subtitleId.Value, targetLangIds, ct);
    }

    public async Task<(bool Success, string Msg, List<long> ItemIds, int Skipped)> GetSeasonTranslateBatchAsync(
        long userId, long libraryPathId, int season, CancellationToken ct = default)
    {
        var lp = await libraryPaths.GetAsync(libraryPathId, ct);
        if (lp == null) return (false, "Library path not found", [], 0);

        var userLangIds = (await languages.GetUserTranslationLanguagesAsync(userId, ct))
            .Select(t => t.LanguageId).ToList();
        var blacklistIds = (await db.LibraryPathItemBlacklist.Select(b => b.LibraryPathItemId).ToListAsync(ct))
            .ToHashSet();

        var batch = new List<long>();
        var skipped = 0;
        foreach (var item in await items.GetAllByLibraryPathAsync(libraryPathId, ct))
        {
            if (item.Season != season || blacklistIds.Contains(item.Id)) continue;

            var subId = await db.Subtitles.AsNoTracking()
                .Where(s => s.LibraryPathItemId == item.Id && s.DeletedAt == null)
                .OrderByDescending(s => s.Id)
                .Select(s => (long?)s.Id)
                .FirstOrDefaultAsync(ct);
            if (subId != null && userLangIds.Count > 0)
            {
                var completed = await db.SubtitleJobs.AsNoTracking()
                    .Where(j => j.SubtitleId == subId.Value && j.DeletedAt == null &&
                                j.Status == SubtitleJobStatus.Completed)
                    .Select(j => j.TargetLanguageId)
                    .Distinct()
                    .ToListAsync(ct);
                if (userLangIds.All(completed.Contains))
                {
                    skipped++;
                    continue;
                }
            }
            batch.Add(item.Id);
        }
        return (true, "", batch, skipped);
    }

    // File names for batch failure messages.
    public async Task<Dictionary<long, string>> GetFileNamesAsync(List<long> itemIds, CancellationToken ct = default)
    {
        var rows = await db.LibraryPathItems.AsNoTracking()
            .Where(i => itemIds.Contains(i.Id))
            .Select(i => new { i.Id, i.Path })
            .ToListAsync(ct);
        return rows.ToDictionary(r => r.Id, r => Path.GetFileName(r.Path));
    }

    private static async Task<bool> IsCacheFreshAsync(
        LibraryPathItemSubtitleSource cached, string path, ILibraryFileSystem fs, CancellationToken ct)
    {
        try
        {
            var st = await fs.StatAsync(path, ct);
            return st != null &&
                   cached.FileMtimeMs == st.LastWriteTimeUtc.Ticks / TimeSpan.TicksPerMillisecond &&
                   cached.FileSize == st.Size;
        }
        catch (Exception ex) when (ex is IOException or LibraryConnectionException)
        {
            return false;
        }
    }

    // ── Group builders ─────────

    private async Task<List<RequestGroupDto>> BuildRequestGroupsAsync(
        long userId, string type, CancellationToken ct)
    {
        var libraryPathsList = (await libraryPaths.GetByTypeAsync(
            type == "series" ? LibraryPathType.Series : LibraryPathType.Movie, ct))
            .Where(lp => lp.Enabled).ToList();
        if (libraryPathsList.Count == 0) return [];

        var userTargetLangIds = (await languages.GetUserTranslationLanguagesAsync(userId, ct))
            .Select(t => t.LanguageId).ToList();

        var enriched = await pathsService.EnrichItemsAsync(
            await items.GetByLibraryPathIdsAsync(libraryPathsList.Select(p => p.Id).ToList(), ct), ct);
        var (whisperByItem, translatedByItem) = await LoadBatchedMapsAsync(enriched.Values.Select(i => i.Id).ToList(), ct);

        var groupsMap = new Dictionary<string, RequestGroupDto>();

        Dictionary<long, LibraryPathItemSubtitleSource> extraSources = [];
        try
        {
            extraSources = await items.GetSubtitleSourcesByItemIdsAsync(
                enriched.Values.Where(i => i.IsExtra).Select(i => i.Id).ToList(), ct);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to read source caches for extras");
        }

        RequestGroupDto EnsureGroup(LibraryItemDto item)
        {
            var key = item.MediaItem!.Id.ToString();
            if (!groupsMap.TryGetValue(key, out var g))
            {
                g = new RequestGroupDto(
                    key,
                    item.MediaItem.Title ?? Path.GetFileName(item.Path) ?? "Untitled",
                    item.MediaItem.Year,
                    item.MediaItem.Genres,
                    item.MediaItem.PhotoPath,
                    type, []);
                groupsMap[key] = g;
            }
            return g;
        }

        foreach (var item in enriched.Values)
        {
            if (!IsMatched(item)) continue;
            var gi = ItemToGroupItem(item, whisperByItem, userTargetLangIds, type, translatedByItem);
            if (gi == null) continue;

            var g = EnsureGroup(item);
            if (item.IsExtra && type == "movie")
            {
                g.Extras ??= [];
                g.Extras.Add(gi with
                {
                    Title = Path.GetFileNameWithoutExtension(item.Path),
                    HasEmbedded = extraSources.GetValueOrDefault(item.Id)?.Sources
                        .Any(s => s.Type == "embedded") ?? false,
                });
            }
            else
            {
                g.Items.Add(gi);
                g.Items.Sort((a, b) =>
                {
                    if (a.Season != null && b.Season != null)
                    {
                        if (a.Season != b.Season) return a.Season.Value.CompareTo(b.Season.Value);
                        return (a.Episode ?? 0).CompareTo(b.Episode ?? 0);
                    }
                    return string.Compare(a.FileName, b.FileName, StringComparison.CurrentCulture);
                });
            }
        }

        var allGroups = new List<RequestGroupDto>();
        foreach (var g in groupsMap.Values)
        {
            if (g.Items.Count == 0 && (g.Extras == null || g.Extras.Count == 0)) continue;

            var translatable = g.Items.Where(it => it.SubtitleId != null).ToList();
            g.FullyTranslated = translatable.Count > 0 && userTargetLangIds.Count > 0 &&
                translatable.All(it => userTargetLangIds.All(id => it.TranslatedTargetLangIds.Contains(id)));
            allGroups.Add(g);
        }
        allGroups.Sort((a, b) => string.Compare(a.Title, b.Title, StringComparison.CurrentCulture));
        return allGroups;
    }

    private async Task<List<RequestGroupDto>> BuildUnmatchedGroupsAsync(long userId, CancellationToken ct)
    {
        var paths = (await libraryPaths.GetByTypeAsync(LibraryPathType.Movie, ct))
            .Concat(await libraryPaths.GetByTypeAsync(LibraryPathType.Series, ct))
            .Where(lp => lp.Enabled).ToList();
        if (paths.Count == 0) return [];

        var userTargetLangIds = (await languages.GetUserTranslationLanguagesAsync(userId, ct))
            .Select(t => t.LanguageId).ToList();

        var enriched = await pathsService.EnrichItemsAsync(
            await items.GetByLibraryPathIdsAsync(paths.Select(p => p.Id).ToList(), ct), ct);
        var (whisperByItem, translatedByItem) = await LoadBatchedMapsAsync(enriched.Values.Select(i => i.Id).ToList(), ct);

        var groups = new List<RequestGroupDto>();
        foreach (var item in enriched.Values)
        {
            if (IsMatched(item)) continue;
            var gi = ItemToGroupItem(item, whisperByItem, userTargetLangIds, null, translatedByItem);
            if (gi == null) continue;
            groups.Add(new RequestGroupDto(
                $"unmatched-{item.Id}", Path.GetFileName(item.Path), null, null, null, "unmatched",
                [gi]) { FilePath = item.Path });
        }
        groups.Sort((a, b) => string.Compare(a.Title, b.Title, StringComparison.CurrentCulture));
        return groups;
    }

    // Whisper status is keyed by the item's own id — episodes share a media
    // item, but a whisper subtitle belongs to one episode only.
    private async Task<(Dictionary<long, string?> WhisperByItem, Dictionary<long, List<long>> TranslatedByItem)>
        LoadBatchedMapsAsync(List<long> itemIds, CancellationToken ct)
    {
        var whisperStates = await subtitles.GetWhisperStateByItemIdsAsync(itemIds, ct);
        var translatedRows = await translatedItems.GetByItemIdsAsync(itemIds, ct);
        var translatedByItem = translatedRows
            .GroupBy(t => t.LibraryPathItemId)
            .ToDictionary(g => g.Key, g => g.Select(t => t.LanguageId).ToList());
        return (whisperStates.ToDictionary(kv => kv.Key, kv => WhisperStatusString(kv.Value)), translatedByItem);
    }

    // whisperTranscriptionStatus strings (also the i18n keys).
    private static string? WhisperStatusString(WhisperTranscriptionState? state) => state switch
    {
        WhisperTranscriptionState.QueuedForTranscription => "queued_for_transcription",
        WhisperTranscriptionState.Transcribing => "transcribing",
        WhisperTranscriptionState.TranscriptionFailed => "transcription_failed",
        WhisperTranscriptionState.TranscriptionCompleted => "transcription_completed",
        WhisperTranscriptionState.QueuedForTranslation => "queued_for_translation",
        WhisperTranscriptionState.Translating => "translating",
        _ => null,
    };

    // Shared per-item decision: null hides the item.
    private static RequestGroupItemDto? ItemToGroupItem(
        LibraryItemDto item,
        Dictionary<long, string?> whisperByItem,
        List<long> userTargetLangIds,
        string? type,
        Dictionary<long, List<long>> translatedByItem)
    {
        if (item.Blacklist != null) return null;

        var whisperStatus = whisperByItem.GetValueOrDefault(item.Id);
        var translatedTargetLangIds = OrderTranslatedLangs(
            (translatedByItem.GetValueOrDefault(item.Id) ?? []).Where(userTargetLangIds.Contains).ToList(),
            userTargetLangIds);

        if (item.Status is "not_started" or "no_srts_found")
        {
            return MakeGroupItem(item, null, userTargetLangIds, false, whisperStatus, translatedTargetLangIds);
        }

        if (item.SubtitleInfo is { Deleted: false })
        {
            var jobRows = item.SubtitleInfo.Jobs;
            var finishedLangIds = jobRows
                .Where(j => j.JobStatus == "completed")
                .Select(j => j.TargetLangId)
                .ToHashSet();
            var hasActiveJobs = jobRows.Any(j => j.JobStatus is "queued" or "running");
            var missingTargetLangIds = userTargetLangIds.Where(id => !finishedLangIds.Contains(id)).ToList();
            var allCompleted = userTargetLangIds.Count > 0 && userTargetLangIds.All(finishedLangIds.Contains);

            var keepForSeries = type == "series";
            var keepForTranslated = type != "series" && translatedTargetLangIds.Count > 0;
            if (allCompleted && !keepForSeries && !keepForTranslated) return null;
            if (missingTargetLangIds.Count == 0 && !hasActiveJobs && !keepForSeries && !keepForTranslated) return null;

            return MakeGroupItem(item, item.SubtitleInfo.SubtitleId, missingTargetLangIds,
                hasActiveJobs, whisperStatus, translatedTargetLangIds);
        }

        if (item.SubtitleInfo is { Deleted: true })
        {
            var groupItem = MakeGroupItem(item, null, userTargetLangIds, false, whisperStatus, translatedTargetLangIds);
            return groupItem with { SubtitleDeleted = true };
        }

        return null;
    }

    private static List<long> OrderTranslatedLangs(List<long> langIds, List<long> userTargetLangIds) =>
        langIds.OrderBy(userTargetLangIds.IndexOf).ToList();

    private static RequestGroupItemDto MakeGroupItem(
        LibraryItemDto item, long? subtitleId, List<long> missingTargetLangIds, bool hasActiveJobs,
        string? whisperStatus, List<long> translatedTargetLangIds) => new(
        item.Id, item.Season, item.Episode, Path.GetFileName(item.Path), "", item.LibraryPathId,
        subtitleId, missingTargetLangIds, hasActiveJobs, whisperStatus,
        LibraryNameParser.VideoExtensions.Contains(Path.GetExtension(item.Path).ToLowerInvariant()),
        item.Status != "no_srts_found", translatedTargetLangIds);
}