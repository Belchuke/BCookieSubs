using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Storage;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Shared.Services;

public partial class LibraryScannerService(
    LibraryPathRepository libraryPaths,
    LibraryPathItemRepository items,
    MediaItemRepository mediaItemRepo,
    ExportedSubtitleFileRepository exportedFiles,
    TranslatedLibraryItemRepository translatedItems,
    LanguageRepository languages,
    LibraryMatchingService matching,
    MediaProbeService probe,
    ILibraryFileSystemFactory fsFactory,
    UserRepository users,
    ApplicationConfigRepository configRepo,
    ApplicationLogRepository logs,
    LibraryAutoTranslateService autoTranslate,
    LibrarySubtitleExportService subtitleExport,
    BCookieSubsDbContext db,
    IDashboardEventPublisher dashboardEvents,
    ILogger<LibraryScannerService> logger)
{
    public const string CreditText = "Translated by BCookieSubs";

    private sealed record ResolvedSrt(string Path, bool IsTemp);

    public sealed record LibraryScanProgress(long LibraryPathId, string Name, int Processed, int Total, string Phase);

    private static readonly bool MemoryDiagnostics =
        string.Equals(Environment.GetEnvironmentVariable("BCOOKIESUBS_SCAN_MEMORY_DIAGNOSTICS"), "1",
            StringComparison.OrdinalIgnoreCase);
    private const int MemoryDiagnosticInterval = 50;
    private System.Diagnostics.Process? diagProcess;

    private sealed record MovieSubtitleOwnership(
        long? MediaItemId, bool MultipleMatches, List<long> CandidateMediaItemIds, string? OwningVideo);

    public async Task ScanAsync(LibraryPath libraryPath, CancellationToken ct, Action<LibraryScanProgress>? progress = null)
    {
        ct.ThrowIfCancellationRequested();
        var adminUserId = (await users.GetHighestRoleUserAsync(ct))?.Id;
        if (adminUserId == null)
        {
            await LogAsync(LogLevelKind.Warning, "scanSkipped", "libraryScanner", libraryPath.Id,
                $"Skipping scan of \"{libraryPath.Name}\": no admin user available to attribute actions to",
                new { libraryPathName = libraryPath.Name }, ct);
            await libraryPaths.SetStateAsync(libraryPath.Id, LibraryPathState.Idle, ct);
            return;
        }

        await using var fs = await fsFactory.CreateAsync(libraryPath, ct);

        if (!await fs.ExistsAsync(libraryPath.Path, ct))
        {
            var location = fs.IsRemote
                ? $"not reachable over SFTP ({libraryPath.SftpHost}:{libraryPath.SftpPort})"
                : "does not exist on disk";
            await LogAsync(LogLevelKind.Warning, "scanSkipped", "libraryScanner", libraryPath.Id,
                $"Library path \"{libraryPath.Name}\" {location}: {libraryPath.Path}",
                new { libraryPathName = libraryPath.Name, path = libraryPath.Path }, ct);
            await libraryPaths.SetStateAsync(libraryPath.Id, LibraryPathState.Idle, ct);
            return;
        }

        {
            var existingItems = await items.GetAllByLibraryPathAsync(libraryPath.Id, ct);
            foreach (var inv in existingItems)
            {
                if (await fs.ExistsAsync(inv.Path, ct)) continue;
                await items.DeleteAsync(await items.GetAsync(inv.Id, ct) ?? inv, ct);
                await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", inv.Id,
                    $"Removed library item no longer on disk: {inv.Path}",
                    new { libraryPathName = libraryPath.Name, path = inv.Path }, ct);
            }
        }

        db.ChangeTracker.Clear();
        LogScanMemoryDiagnostics("prune", libraryPath, 0, videoCount: 0, srtCount: 0, companionCount: 0,
            seriesCacheCount: 0, movieCacheCount: 0);

        await PruneMissingExportedFilesAsync(libraryPath.Id, fs, ct);

        var (videoFiles, srtFiles) = await FindMediaFilesAsync(fs, libraryPath.Path, ct);
        var totalFiles = videoFiles.Count + srtFiles.Count;
        var processedFiles = 0;
        progress?.Invoke(new LibraryScanProgress(libraryPath.Id, libraryPath.Name, 0, totalFiles, "scanning"));

        var sourceLang = await languages.GetAsync(libraryPath.SourceLanguageId, ct);
        var iso = sourceLang?.Iso639 ?? "";
        var iso2b = sourceLang?.Iso6392B;
        var langName = sourceLang?.Name ?? "";

        var config = await configRepo.GetAsync(ct);
        var chunkSetting = config?.DefaultChunkSize ?? 12;

        var companionSrtPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // Pre-compute per-season episode rebase offsets (absolute → 1-based).
        var episodeRebase = libraryPath.Type == LibraryPathType.Series
            ? LibraryNameParser.ComputeSeasonEpisodeRebase(videoFiles, libraryPath.Path)
            : new Dictionary<string, int>();

        var seriesFolderCache = new Dictionary<string, SeriesCache>();
        var movieRootCache = new Dictionary<string, MovieCache>();

        foreach (var videoFile in videoFiles)
        {
            ct.ThrowIfCancellationRequested();
            processedFiles++;
            progress?.Invoke(new LibraryScanProgress(libraryPath.Id, libraryPath.Name, processedFiles, totalFiles, "scanning"));
            LogScanMemoryDiagnostics("video", libraryPath, processedFiles, videoFiles.Count, srtFiles.Count,
                companionSrtPaths.Count, seriesFolderCache.Count, movieRootCache.Count);
            db.ChangeTracker.Clear();
            var stem = Path.GetFileNameWithoutExtension(videoFile);

            var existingItem = await items.GetByPathAsync(libraryPath.Id, videoFile, ct);
            if (existingItem != null)
            {
                string? stagedExisting = null;
                try
                {
                    foreach (var s in await probe.FindCompanionSubtitlesAsync(videoFile, fs)) companionSrtPaths.Add(s);
                    if (!await CachedSourcesAreFreshAsync(existingItem.Id, videoFile, fs, ct))
                    {
                        ct.ThrowIfCancellationRequested();
                        stagedExisting = await StageVideoForProbingAsync(fs, videoFile, libraryPath.Id, ct);
                        await CacheItemSubtitleSourcesAsync(existingItem.Id, videoFile, iso, iso2b, langName,
                            fs, stagedExisting, ct);
                    }
                    await ReconcileBcookieTranslatedForItemAsync(existingItem.Id, videoFile, iso, iso2b, fs, ct);
                }
                finally
                {
                    LibraryStaging.SafeDeleteFile(stagedExisting);
                }
                continue;
            }

            var companions = await probe.FindCompanionSubtitlesAsync(videoFile, fs);
            foreach (var s in companions) companionSrtPaths.Add(s);

            string? stagedVideo = null;
            try
            {
                ResolvedSrt? resolvedSrt = null;
                var companionMatch = LibraryNameParser.SelectBestSrt(companions, [], iso, langName);
                if (companionMatch != null)
                {
                    resolvedSrt = new ResolvedSrt(companionMatch, false);
                }
                else
                {
                    stagedVideo = await StageVideoForProbingAsync(fs, videoFile, libraryPath.Id, ct);
                    var extracted = await probe.ExtractBestEmbeddedSrtAsync(
                        stagedVideo ?? videoFile, iso, iso2b, langName, ct: ct);
                    if (extracted != null) resolvedSrt = new ResolvedSrt(extracted, true);
                }

                long? mediaItemId = null;
                var multipleMatches = false;
                List<long> candidateMediaItemIds = [];
                int? season = null;
                int? episode = null;
                var isExtra = false;

                if (libraryPath.Type == LibraryPathType.Series)
                {
                    var seriesRoot = LibraryNameParser.GetSeriesRootDir(videoFile, libraryPath.Path);
                    if (!seriesFolderCache.TryGetValue(seriesRoot, out var cached))
                    {
                        var detection = await matching.MatchAsync(videoFile, "series", libraryPath.Path, ct);
                        cached = new SeriesCache(detection.MediaItemId, detection.MultipleMatches,
                            detection.CandidateMediaItemIds, detection.DetectedYear);
                        seriesFolderCache[seriesRoot] = cached;
                    }
                    mediaItemId = cached.MediaItemId;
                    multipleMatches = cached.MultipleMatches;
                    candidateMediaItemIds = cached.CandidateMediaItemIds;

                    var seasonFolder = LibraryNameParser.GetSeasonFolderNameBetween(videoFile, seriesRoot);
                    if (LibraryNameParser.IsFractionalSpecial(videoFile))
                    {
                        season = 0;
                        episode = null;
                    }
                    else
                    {
                        season = seasonFolder != null
                            ? LibraryNameParser.ParseSeasonFolderName(seasonFolder) ??
                              LibraryNameParser.ParseSeasonFromFilename(videoFile)
                            : LibraryNameParser.ParseSeasonFromFilename(videoFile);
                        season ??= 1;
                        episode = LibraryNameParser.ParseEpisodeFromFilename(videoFile);
                        if (episode != null && seasonFolder != null)
                        {
                            var key = SeasonFolderKey(seriesRoot, seasonFolder);
                            if (episodeRebase.TryGetValue(key, out var rebaseOffset))
                            {
                                episode -= rebaseOffset;
                            }
                        }
                    }
                }
                else
                {
                    if (LibraryNameParser.IsInExtrasFolder(videoFile))
                    {
                        var owner = FindOwningMovieVideoForExtra(videoFile, videoFiles);
                        if (owner != null)
                        {
                            var ownerRoot = Path.GetDirectoryName(Path.GetFullPath(owner))!;
                            if (!movieRootCache.TryGetValue(ownerRoot, out var cached))
                            {
                                var detection = await matching.MatchAsync(owner, "movie", libraryPath.Path, ct);
                                cached = new MovieCache(detection.MediaItemId, detection.MultipleMatches,
                                    detection.CandidateMediaItemIds, detection.Season, detection.Episode,
                                    detection.DetectedYear);
                                movieRootCache[ownerRoot] = cached;
                            }
                            mediaItemId = cached.MediaItemId;
                            multipleMatches = cached.MultipleMatches;
                            candidateMediaItemIds = cached.CandidateMediaItemIds;
                            season = 0;
                            episode = null;
                            isExtra = true;
                            await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", null,
                                $"Extra \"{Path.GetFileName(videoFile)}\" attached to movie video \"{Path.GetFileName(owner)}\"",
                                new { libraryPathName = libraryPath.Name, extraPath = videoFile, owningVideo = owner }, ct);
                        }
                        else
                        {
                            await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", null,
                                $"Extra \"{Path.GetFileName(videoFile)}\" has no owning movie video; leaving Unmatched",
                                new { libraryPathName = libraryPath.Name, extraPath = videoFile }, ct);
                        }
                    }
                    else
                    {
                        var movieRoot = Path.GetDirectoryName(Path.GetFullPath(videoFile))!;
                        if (!movieRootCache.TryGetValue(movieRoot, out var cached))
                        {
                            var detection = await matching.MatchAsync(videoFile, "movie", libraryPath.Path, ct);
                            cached = new MovieCache(detection.MediaItemId, detection.MultipleMatches,
                                detection.CandidateMediaItemIds, detection.Season, detection.Episode,
                                detection.DetectedYear);
                            movieRootCache[movieRoot] = cached;
                        }
                        mediaItemId = cached.MediaItemId;
                        multipleMatches = cached.MultipleMatches;
                        candidateMediaItemIds = cached.CandidateMediaItemIds;
                        season = cached.Season;
                        episode = cached.Episode;
                    }
                }

                var mediaItem = mediaItemId != null ? await mediaItemRepo.GetAsync(mediaItemId.Value, ct) : null;
                var extractFileName = BuildExtractFileName(mediaItem, season, episode, stem, ".srt");

                if (resolvedSrt == null)
                {
                    var noSrtItem = await CreateItemAsync(libraryPath.Id, videoFile, extractFileName,
                        mediaItemId, LibraryPathItemStatus.NoSrtsFound, season, episode, isExtra, ct);
                    if (noSrtItem != null)
                    {
                        await CacheItemSubtitleSourcesAsync(noSrtItem.Id, videoFile, iso, iso2b, langName, fs, stagedVideo, ct);
                        await ReconcileBcookieTranslatedForItemAsync(noSrtItem.Id, videoFile, iso, iso2b, fs, ct);
                    }
                    continue;
                }

                var status = mediaItemId != null ? LibraryPathItemStatus.NotStarted : LibraryPathItemStatus.NoMediaItem;
                var item = await CreateItemAsync(libraryPath.Id, videoFile, extractFileName,
                    mediaItemId, status, season, episode, isExtra, ct);
                if (item == null)
                {
                    if (resolvedSrt.IsTemp) ExtractTemp.SafeDeleteTempExtract(resolvedSrt.Path);
                    continue;
                }

                await CacheItemSubtitleSourcesAsync(item.Id, videoFile, iso, iso2b, langName, fs, stagedVideo, ct);
                await ReconcileBcookieTranslatedForItemAsync(item.Id, videoFile, iso, iso2b, fs, ct);

                if (multipleMatches && candidateMediaItemIds.Count > 0)
                {
                    foreach (var candidateId in candidateMediaItemIds)
                    {
                        await items.AddCandidateAsync(item.Id, candidateId, ct);
                    }
                }

                if (libraryPath.AutoTranslate && (mediaItemId != null || !multipleMatches))
                {
                    await autoTranslate.AutoTranslateItemAsync(libraryPath, item.Id, resolvedSrt.Path, resolvedSrt.IsTemp,
                        mediaItemId, season, episode, chunkSetting,
                        associatedVideoPath: stagedVideo ?? videoFile, actingUserId: adminUserId, ct: ct, fs: fs);
                }
                else if (resolvedSrt.IsTemp)
                {
                    ExtractTemp.SafeDeleteTempExtract(resolvedSrt.Path);
                }
            }
            finally
            {
                LibraryStaging.SafeDeleteFile(stagedVideo);
            }
        }

        foreach (var srtFile in srtFiles)
        {
            ct.ThrowIfCancellationRequested();
            processedFiles++;
            progress?.Invoke(new LibraryScanProgress(libraryPath.Id, libraryPath.Name, processedFiles, totalFiles, "scanning"));
            LogScanMemoryDiagnostics("subtitle", libraryPath, processedFiles, videoFiles.Count, srtFiles.Count,
                companionSrtPaths.Count, seriesFolderCache.Count, movieRootCache.Count);
            db.ChangeTracker.Clear();
            if (companionSrtPaths.Contains(srtFile))
            {
                var staleCompanion = await items.GetByPathAsync(libraryPath.Id, srtFile, ct);
                if (staleCompanion != null)
                {
                    await items.DeleteAsync(staleCompanion, ct);
                    await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", staleCompanion.Id,
                        $"Removed standalone subtitle item now grouped under its video: {srtFile}",
                        new { libraryPathName = libraryPath.Name, path = srtFile }, ct);
                }
                continue;
            }

            var srtBasename = Path.GetFileName(srtFile);
            if (srtBasename.StartsWith("[BCookieSub]")) continue;

            var exportedRecord = await exportedFiles.GetByPathAsync(libraryPath.Id, srtFile, ct);
            if (exportedRecord is { IsWhisper: false })
            {
                var staleExport = await items.GetByPathAsync(libraryPath.Id, srtFile, ct);
                if (staleExport != null)
                {
                    await items.DeleteAsync(staleExport, ct);
                    await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", staleExport.Id,
                        $"Removed BCookieSubs-exported subtitle item (not a translation source): {srtFile}",
                        new { libraryPathName = libraryPath.Name, path = srtFile }, ct);
                }
                continue;
            }

            var fileExt = SubtitleFileTypes.SubtitleFileExtensionOf(srtBasename) ?? ".srt";
            var stem = srtBasename.ToLowerInvariant().EndsWith(fileExt, StringComparison.Ordinal)
                ? srtBasename[..^fileExt.Length]
                : srtBasename;

            var existingSrtItem = await items.GetByPathAsync(libraryPath.Id, srtFile, ct);
            if (existingSrtItem != null)
            {
                if (libraryPath.Type == LibraryPathType.Movie && existingSrtItem.MediaItemId == null)
                {
                    await TryRepairMovieSubtitleOwnershipAsync(existingSrtItem, libraryPath, srtFile, stem,
                        videoFiles, adminUserId, ct);
                }
                continue;
            }

            long? srtMediaItemId = null;
            var srtMultipleMatches = false;
            List<long> srtCandidateMediaItemIds = [];
            int? srtSeason = null;
            int? srtEpisode = null;

            var matchedViaOwningVideo = false;
            var ownership = await ResolveMovieSubtitleOwnershipAsync(libraryPath, srtFile, stem, videoFiles, ct);
            if (ownership != null)
            {
                srtMediaItemId = ownership.MediaItemId;
                srtMultipleMatches = ownership.MultipleMatches;
                srtCandidateMediaItemIds = ownership.CandidateMediaItemIds;
                matchedViaOwningVideo = true;
                if (ownership.OwningVideo != null)
                {
                    await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", null,
                        $"Subtitle \"{srtBasename}\" attached to movie video \"{Path.GetFileName(ownership.OwningVideo)}\"",
                        new { libraryPathName = libraryPath.Name, srtPath = srtFile, owningVideo = ownership.OwningVideo }, ct);
                }
                else
                {
                    await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", null,
                        $"Subtitle \"{srtBasename}\" has no owning movie video; leaving Unmatched",
                        new { libraryPathName = libraryPath.Name, srtPath = srtFile }, ct);
                }
            }

            if (!matchedViaOwningVideo)
            {
                if (libraryPath.Type == LibraryPathType.Series)
                {
                    var seriesRoot = LibraryNameParser.GetSeriesRootDir(srtFile, libraryPath.Path);
                    if (!seriesFolderCache.TryGetValue(seriesRoot, out var cached))
                    {
                        var detection = await matching.MatchAsync(srtFile, "series", libraryPath.Path, ct);
                        cached = new SeriesCache(detection.MediaItemId, detection.MultipleMatches,
                            detection.CandidateMediaItemIds, detection.DetectedYear);
                        seriesFolderCache[seriesRoot] = cached;
                    }
                    srtMediaItemId = cached.MediaItemId;
                    srtMultipleMatches = cached.MultipleMatches;
                    srtCandidateMediaItemIds = cached.CandidateMediaItemIds;

                    var seasonFolder = LibraryNameParser.GetSeasonFolderNameBetween(srtFile, seriesRoot);
                    if (LibraryNameParser.IsFractionalSpecial(srtFile))
                    {
                        srtSeason = 0;
                        srtEpisode = null;
                    }
                    else
                    {
                        srtSeason = seasonFolder != null
                            ? LibraryNameParser.ParseSeasonFolderName(seasonFolder) ??
                              LibraryNameParser.ParseSeasonFromFilename(srtFile)
                            : LibraryNameParser.ParseSeasonFromFilename(srtFile);
                        srtSeason ??= 1;
                        srtEpisode = LibraryNameParser.ParseEpisodeFromFilename(srtFile);
                    }
                }
                else
                {
                    var detection = await matching.MatchAsync(srtFile, "movie", libraryPath.Path, ct);
                    srtMediaItemId = detection.MediaItemId;
                    srtMultipleMatches = detection.MultipleMatches;
                    srtCandidateMediaItemIds = detection.CandidateMediaItemIds;
                    srtSeason = detection.Season;
                    srtEpisode = detection.Episode;
                }
            }

            var srtMediaItem = srtMediaItemId != null ? await mediaItemRepo.GetAsync(srtMediaItemId.Value, ct) : null;
            var srtExtractFileName = BuildExtractFileName(srtMediaItem, srtSeason, srtEpisode, stem, fileExt);
            var srtStatus = srtMediaItemId != null ? LibraryPathItemStatus.NotStarted : LibraryPathItemStatus.NoMediaItem;

            var srtItem = await CreateItemAsync(libraryPath.Id, srtFile, srtExtractFileName,
                srtMediaItemId, srtStatus, srtSeason, srtEpisode, false, ct);
            if (srtItem == null) continue;

            if (srtMultipleMatches && srtCandidateMediaItemIds.Count > 0)
            {
                foreach (var candidateId in srtCandidateMediaItemIds)
                {
                    await items.AddCandidateAsync(srtItem.Id, candidateId, ct);
                }
            }

            if (libraryPath.AutoTranslate && (srtMediaItemId != null || !srtMultipleMatches))
            {
                await autoTranslate.AutoTranslateItemAsync(libraryPath, srtItem.Id, srtFile, false,
                    srtMediaItemId, srtSeason, srtEpisode, chunkSetting, actingUserId: adminUserId, ct: ct, fs: fs);
            }
        }

        // autoExtractItems (V5): export completed translations next to their
        // media for autoExtract paths.
        LogScanMemoryDiagnostics("done", libraryPath, processedFiles, videoFiles.Count, srtFiles.Count,
            companionSrtPaths.Count, seriesFolderCache.Count, movieRootCache.Count, force: true);
        db.ChangeTracker.Clear();
        if (libraryPath.AutoExtract)
        {
            await subtitleExport.AutoExtractItemsAsync(ct);
        }

        if (!libraryPath.InitialScanCompleted)
        {
            await libraryPaths.SetInitialScanCompletedAsync(libraryPath.Id, ct);
        }

        progress?.Invoke(new LibraryScanProgress(libraryPath.Id, libraryPath.Name, totalFiles, totalFiles, "done"));
    }

    private sealed record SeriesCache(
        long? MediaItemId, bool MultipleMatches, List<long> CandidateMediaItemIds, int? DetectedYear);

    private sealed record MovieCache(
        long? MediaItemId, bool MultipleMatches, List<long> CandidateMediaItemIds,
        int? Season, int? Episode, int? DetectedYear);

    private static string SeasonFolderKey(string seriesRoot, string seasonFolder) =>
        Path.GetFullPath(seriesRoot) + Path.DirectorySeparatorChar + seasonFolder;

    // ── Filesystem walk ─────────────────────────────────────────────────────

    // ffprobe/mkvmerge/ffmpeg need a real local file: SFTP videos are staged
    // into /work first; local paths pass straight through (no copy). Failures
    // degrade to companion-only probing rather than failing the scan.
    private async Task<string?> StageVideoForProbingAsync(
        ILibraryFileSystem fs, string videoFile, long libraryPathId, CancellationToken ct)
    {
        if (!fs.IsRemote) return null;
        try
        {
            return await fs.StageToWorkAsync(videoFile, LibraryStaging.ScanDir(libraryPathId), ct);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or LibraryConnectionException)
        {
            logger.LogWarning(ex, "Failed to stage SFTP video for probing: {Path}", videoFile);
            return null;
        }
    }

    private static async Task<(List<string> VideoFiles, List<string> SrtFiles)> FindMediaFilesAsync(
        ILibraryFileSystem fs, string dirPath, CancellationToken ct)
    {
        var videoFiles = new List<string>();
        var srtFiles = new List<string>();
        await WalkAsync(fs, dirPath, videoFiles, srtFiles, ct);
        return (videoFiles, srtFiles);
    }

    private static async Task WalkAsync(ILibraryFileSystem fs, string dirPath,
        List<string> videoFiles, List<string> srtFiles, CancellationToken ct)
    {
        await foreach (var entry in fs.EnumerateDirectoryEntriesAsync(dirPath, ct))
        {
            if (entry.IsDirectory)
            {
                if (entry.Name.ToLowerInvariant().EndsWith(".trickplay")) continue;
                await WalkAsync(fs, entry.FullPath, videoFiles, srtFiles, ct);
            }
            else
            {
                var ext = Path.GetExtension(entry.Name).ToLowerInvariant();
                if (LibraryNameParser.VideoExtensions.Contains(ext))
                {
                    if (!LibraryNameParser.IsSampleFile(entry.FullPath)) videoFiles.Add(entry.FullPath);
                }
                else if (SubtitleFileTypes.IsSubtitleExtension(ext))
                {
                    srtFiles.Add(entry.FullPath);
                }
            }
        }
    }

    // ── Source cache ────────────────────────────────────────────────────────

    private async Task CacheItemSubtitleSourcesAsync(
        long itemId, string videoFilePath, string iso, string? iso2b, string langName,
        ILibraryFileSystem fs, string? localVideoPath, CancellationToken ct)
    {
        try
        {
            var st = await fs.StatAsync(videoFilePath, ct);
            var mtime = st != null ? st.LastWriteTimeUtc.Ticks / TimeSpan.TicksPerMillisecond : 0;
            var size = st?.Size ?? 0;
            var sources = await probe.ListSubtitleSourcesAsync(videoFilePath, iso, iso2b, langName,
                true, ct, fs, localVideoPath);
            await items.UpsertSubtitleSourcesAsync(itemId, sources, mtime, size, ct);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to cache subtitle sources for {Path}", videoFilePath);
        }
    }

    private async Task<bool> CachedSourcesAreFreshAsync(long itemId, string videoFilePath, ILibraryFileSystem fs, CancellationToken ct)
    {
        var cached = await items.GetSubtitleSourcesAsync(itemId, ct);
        if (cached == null) return false;
        try
        {
            var st = await fs.StatAsync(videoFilePath, ct);
            return cached.FileMtimeMs == (st?.LastWriteTimeUtc.Ticks / TimeSpan.TicksPerMillisecond ?? 0) &&
                   cached.FileSize == (st?.Size ?? 0);
        }
        catch (Exception ex) when (ex is IOException or LibraryConnectionException)
        {
            return false;
        }
    }

    // ── bcookietranslated reconcile ─────────────────────────────────────────

    // BCookieSubs-translated files next to a video carry CREDIT_TEXT and a
    // <video>.<lang>.<ext> name; the rows drive translated badges. Runs every
    // scan so deleted files drop their rows; mtime caching avoids re-reads.
    private async Task ReconcileBcookieTranslatedForItemAsync(
        long itemId, string videoFile, string? srcIso, string? srcIso2b, ILibraryFileSystem fs, CancellationToken ct)
    {
        var videoNorm = LibraryNameParser.NormalizeCompanionStem(Path.GetFileNameWithoutExtension(videoFile));
        var srcLower = (srcIso ?? "").ToLowerInvariant();
        var src2bLower = (srcIso2b ?? "").ToLowerInvariant();

        var companions = await probe.FindCompanionSubtitlesAsync(videoFile, fs);
        var existing = await translatedItems.GetByItemAsync(itemId, ct);
        if (companions.Count == 0)
        {
            if (existing.Count > 0) await translatedItems.ReplaceForItemAsync(itemId, [], ct);
            return;
        }

        var desired = new List<TranslatedLibraryItem>();
        var seenLangIds = new HashSet<long>();
        foreach (var f in companions)
        {
            var subExt = SubtitleFileTypes.SubtitleFileExtensionOf(f);
            if (subExt == null || subExt is ".sub" or ".sup") continue;
            var stem = Path.GetFileNameWithoutExtension(f);
            var stemNorm = LibraryNameParser.NormalizeCompanionStem(stem);
            if (!stemNorm.StartsWith(videoNorm + ".", StringComparison.Ordinal)) continue;
            var langCode = stemNorm[(videoNorm.Length + 1)..].Split('.')[0];
            if (langCode.Length == 0) continue;
            if (langCode == srcLower || (src2bLower.Length > 0 && langCode == src2bLower)) continue;
            var lang = await languages.GetByIso639Async(langCode, ct);
            if (lang == null || !seenLangIds.Add(lang.Id)) continue;

            long mtime;
            try
            {
                var st = await fs.StatAsync(f, ct);
                if (st == null) continue;
                mtime = st.LastWriteTimeUtc.Ticks / TimeSpan.TicksPerMillisecond;
            }
            catch (Exception ex) when (ex is IOException or LibraryConnectionException)
            {
                continue;
            }

            var cachedMatch = existing.FirstOrDefault(r => r.DetectedAtPath == f);
            if (cachedMatch != null && cachedMatch.FileMtimeMs == mtime)
            {
                desired.Add(new TranslatedLibraryItem
                {
                    LanguageId = cachedMatch.LanguageId,
                    DetectedAtPath = f,
                    FileMtimeMs = mtime,
                });
                continue;
            }

            try
            {
                var text = await fs.ReadTextAsync(f, ct);
                if (text.Contains(CreditText))
                {
                    desired.Add(new TranslatedLibraryItem
                    {
                        LanguageId = lang.Id,
                        DetectedAtPath = f,
                        FileMtimeMs = mtime,
                    });
                }
            }
            catch (Exception ex) when (ex is IOException or LibraryConnectionException)
            {
            }
        }
        await translatedItems.ReplaceForItemAsync(itemId, desired, ct);
    }

    // ── Ownership helpers ───────────────────────────────────────────────────

    private static bool IsInMovieVideoFolder(string srtPath, List<string> videoFiles)
    {
        var srtDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(srtPath))!);
        return videoFiles.Any(vf => Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(vf))!) == srtDir);
    }

    private static string? FindOwningVideoFile(string srtPath, List<string> videoFiles)
    {
        var srtDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(srtPath))!) + Path.DirectorySeparatorChar;
        string? best = null;
        var bestLen = -1;
        foreach (var vf in videoFiles)
        {
            var vDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(vf))!);
            if (srtDir != vDir + Path.DirectorySeparatorChar && !srtDir.StartsWith(vDir + Path.DirectorySeparatorChar, StringComparison.Ordinal)) continue;
            if (vDir.Length > bestLen)
            {
                best = vf;
                bestLen = vDir.Length;
            }
        }
        return best;
    }

    // Subtitle in a subfolder below the owning video's folder (Subs/, numbered
    // packs, Jellyfin subtitle folders) — the video folder is a strict ancestor.
    private static bool IsInSubfolderOfVideo(string srtPath, string owningVideo)
    {
        var srtDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(srtPath))!) + Path.DirectorySeparatorChar;
        var videoDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(owningVideo))!) + Path.DirectorySeparatorChar;
        return srtDir.Length > videoDir.Length && srtDir.StartsWith(videoDir, StringComparison.Ordinal);
    }

    /// <summary>
    /// Movie-path standalone subtitles: beside the video, directly in the movie
    /// folder, or in a subfolder of it attach to the owning video's match
    /// instead of garbage-matching the stem. Returns null outside movie paths
    /// or when no owning video / trigger applies.
    /// </summary>
    private async Task<MovieSubtitleOwnership?> ResolveMovieSubtitleOwnershipAsync(
        LibraryPath libraryPath, string srtFile, string stem, List<string> videoFiles, CancellationToken ct)
    {
        if (libraryPath.Type != LibraryPathType.Movie) return null;

        var owningVideo = FindOwningVideoFile(srtFile, videoFiles);
        if (owningVideo == null) return null;
        if (!LibraryNameParser.IsLanguageOnlyStem(stem) &&
            !LibraryNameParser.IsInSubsFolder(srtFile) &&
            !IsInMovieVideoFolder(srtFile, videoFiles) &&
            !IsInSubfolderOfVideo(srtFile, owningVideo))
        {
            return null;
        }

        var owningItem = await items.GetByPathAsync(libraryPath.Id, owningVideo, ct);
        if (owningItem == null) return new MovieSubtitleOwnership(null, false, [], null);

        if (owningItem.MediaItemId != null)
        {
            return new MovieSubtitleOwnership(owningItem.MediaItemId, false, [], owningVideo);
        }

        var owningCandidates = await items.GetCandidatesAsync(owningItem.Id, ct);
        return owningCandidates.Count > 0
            ? new MovieSubtitleOwnership(null, true, owningCandidates, owningVideo)
            : new MovieSubtitleOwnership(null, false, [], owningVideo);
    }

    /// <summary>Re-attaches an existing unassociated movie subtitle item to the owning video's match.</summary>
    private async Task TryRepairMovieSubtitleOwnershipAsync(
        LibraryPathItem existingItem, LibraryPath libraryPath, string srtFile, string stem,
        List<string> videoFiles, long? adminUserId, CancellationToken ct)
    {
        var ownership = await ResolveMovieSubtitleOwnershipAsync(libraryPath, srtFile, stem, videoFiles, ct);
        if (ownership?.MediaItemId == null) return;

        await items.SetMediaItemAsync(existingItem.Id, ownership.MediaItemId, ct);
        await items.SetStatusAsync(existingItem.Id, LibraryPathItemStatus.NotStarted, ct);
        if (ownership.MultipleMatches && ownership.CandidateMediaItemIds.Count > 0)
        {
            await items.ClearCandidatesAsync(existingItem.Id, ct);
            foreach (var candidateId in ownership.CandidateMediaItemIds)
            {
                await items.AddCandidateAsync(existingItem.Id, candidateId, ct);
            }
        }
        await LogAsync(LogLevelKind.Info, "libraryScanner", "libraryScanner", existingItem.Id,
            $"Re-attached subtitle \"{Path.GetFileName(srtFile)}\" to movie video \"{Path.GetFileName(ownership.OwningVideo!)}\"",
            new { libraryPathName = libraryPath.Name, srtPath = srtFile, owningVideo = ownership.OwningVideo,
                  actingUserId = adminUserId }, ct);
    }

    // Periodic one-line scan snapshot (BCOOKIESUBS_SCAN_MEMORY_DIAGNOSTICS=1):
    // heap/working set/private bytes, EF tracked count and scan-cache sizes, to
    // localize production scan-memory growth. Never per-file.
    private void LogScanMemoryDiagnostics(string phase, LibraryPath libraryPath, int processed,
        int videoCount, int srtCount, int companionCount, int seriesCacheCount, int movieCacheCount,
        bool force = false)
    {
        if (!MemoryDiagnostics) return;
        if (!force && processed > 0 && processed % MemoryDiagnosticInterval != 0) return;
        diagProcess ??= System.Diagnostics.Process.GetCurrentProcess();
        diagProcess.Refresh();
        var heapMb = GC.GetGCMemoryInfo().HeapSizeBytes / 1024 / 1024;
        logger.LogInformation(
            "Scan memory: {Library} ({Type}) phase={Phase} processed={Processed} heapMb={Heap} workingSetMb={WorkingSet} privateMb={Private} efTracked={Tracked} videoFiles={Videos} srtFiles={Subs} companionSubs={Companions} seriesCache={Series} movieCache={Movies}",
            libraryPath.Name, libraryPath.Type, phase, processed, heapMb,
            diagProcess.WorkingSet64 / 1024 / 1024, diagProcess.PrivateMemorySize64 / 1024 / 1024,
            db.ChangeTracker.Entries().Count(),
            videoCount, srtCount, companionCount, seriesCacheCount, movieCacheCount);
    }

    private static string? FindOwningMovieVideoForExtra(string extraPath, List<string> videoFiles)
    {
        var extraDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(extraPath))!);
        string? best = null;
        var bestLen = -1;
        foreach (var vf in videoFiles)
        {
            if (LibraryNameParser.IsInExtrasFolder(vf)) continue;
            var vDir = Path.GetFullPath(Path.GetDirectoryName(Path.GetFullPath(vf))!);
            if (vDir == extraDir) continue;
            if (extraDir.StartsWith(vDir + Path.DirectorySeparatorChar, StringComparison.Ordinal) && vDir.Length > bestLen)
            {
                best = vf;
                bestLen = vDir.Length;
            }
        }
        return best;
    }

    // ── Row helpers ─────────────────────────────────────────────────────────

    private async Task PruneMissingExportedFilesAsync(long libraryPathId, ILibraryFileSystem fs, CancellationToken ct)
    {
        var rows = await exportedFiles.GetByLibraryPathAsync(libraryPathId, ct);
        foreach (var row in rows)
        {
            try
            {
                if (!await fs.ExistsAsync(row.Path, ct))
                {
                    await exportedFiles.DeleteAsync(row, ct);
                }
            }
            catch (Exception ex) when (ex is IOException or LibraryConnectionException)
            {
                await exportedFiles.DeleteAsync(row, ct);
            }
        }
    }

    private async Task<LibraryPathItem?> CreateItemAsync(
        long libraryPathId, string path, string extractFileName, long? mediaItemId,
        LibraryPathItemStatus status, int? season, int? episode, bool isExtra, CancellationToken ct)
    {
        var item = new LibraryPathItem
        {
            LibraryPathId = libraryPathId,
            Path = path,
            ExtractFileName = extractFileName,
            MediaItemId = mediaItemId,
            Status = status,
            Season = season,
            Episode = episode,
            IsExtra = isExtra,
        };
        return await items.CreateAsync(item, ct);
    }

    // Extract filename: "<Title>.SxxEyy.(Year)<ext>" with title
    // sanitized for filesystems; bare stem when unmatched.
    private static string BuildExtractFileName(
        MediaItem? mediaItem, int? season, int? episode, string fallbackStem, string ext)
    {
        if (mediaItem == null) return $"{fallbackStem}{ext}";
        var sanitized = UnsafeCharsRegex().Replace(mediaItem.Title, "");
        sanitized = WhitespaceRegex().Replace(sanitized, ".").Trim();
        var name = sanitized;
        if (season != null && episode != null)
        {
            name += $".S{season.Value:00}E{episode.Value:00}";
        }
        if (mediaItem.Year != null) name += $".({mediaItem.Year})";
        return $"{name}{ext}";
    }

    private async Task LogAsync(LogLevelKind level, string type, string entityType, long? entityId,
        string message, object? metadata, CancellationToken ct)
    {
        try
        {
            var log = new ApplicationLog
            {
                Level = level,
                Type = type,
                EntityType = entityType,
                EntityId = entityId,
                Message = message,
                Metadata = metadata is null ? null : System.Text.Json.JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            };
            await logs.AddAsync(log, ct);
            dashboardEvents.LogAdded(log.Id);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to write application log for {Type}", type);
        }
    }

    [GeneratedRegex(@"[/\\:*?""<>|]")]
    private static partial Regex UnsafeCharsRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();
}