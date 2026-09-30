using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Storage;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public record TranslateResult(bool Success, string Msg);

public class LibraryAutoTranslateService(
    BCookieSubsDbContext db,
    SubtitleTaskService tasks,
    LanguageRepository languages,
    ApplicationConfigRepository configRepo,
    ApplicationLogRepository logs,
    MediaProbeService probe,
    ILibraryFileSystemFactory fsFactory,
    FFprobeService ffprobe,
    IDashboardEventPublisher dashboardEvents)
{
    public async Task<TranslateResult> AutoTranslateItemAsync(
        LibraryPath libraryPath, long libraryPathItemId, string srtFilePath, bool isTemp,
        long? mediaItemId, int? season, int? episode, int chunkSetting,
        List<long>? overrideTargetLangIds = null, long? sourceLangIdOverride = null,
        string? associatedVideoPath = null, double? fpsOverride = null,
        long? actingUserId = null, CancellationToken ct = default,
        ILibraryFileSystem? fs = null)
    {
        ILibraryFileSystem? ownedFs = null;
        if (fs == null) ownedFs = await fsFactory.CreateAsync(libraryPath, ct);
        var fsx = fs ?? ownedFs!;
        try
        {
            if (await db.LibraryPathItemBlacklist.AnyAsync(b => b.LibraryPathItemId == libraryPathItemId, ct))
            {
                if (isTemp) ExtractTemp.SafeDeleteTempExtract(srtFilePath);
                return new TranslateResult(false, "Item is blacklisted from translation");
            }

            var effectiveSourceLangId = sourceLangIdOverride ?? libraryPath.SourceLanguageId;

            string srtContent;
            SubtitleTextOrigin? textOrigin = null;
            OriginalSubtitleFormat? originalSourceFormat = null;

            var ext = Path.GetExtension(srtFilePath).ToLowerInvariant();
            if (ext == ".sup")
            {
                const string ocrMsg = ".sup (PGS) subtitles require OCR, which is handled by the Python compute workers.";
                await LogAsync(LogLevelKind.Error, "libraryScanner", libraryPathItemId,
                    $"Failed to import .sup subtitle for translation: {ocrMsg}",
                    new { sourceFormat = "sup", error = ocrMsg }, ct);
                await SetItemStatusAsync(libraryPathItemId, LibraryPathItemStatus.Failed, ct);
                if (isTemp) ExtractTemp.SafeDeleteTempExtract(srtFilePath);
                return new TranslateResult(false, ocrMsg);
            }

            if (ext == ".sub")
            {
                string? stagedMedia = null;
                try
                {
                    var content = await fsx.ReadTextAsync(srtFilePath, ct);
                    if (associatedVideoPath != null && !File.Exists(associatedVideoPath) && fsx.IsRemote)
                        stagedMedia = await fsx.StageToWorkAsync(associatedVideoPath,
                            LibraryStaging.ScanDir(libraryPath.Id), ct);
                    var converted = SubTextAdapter.ConvertTextSubToSrt(srtFilePath, content, fpsOverride,
                        associatedVideoPath != null
                            ? await ffprobe.DetectFpsAsync(stagedMedia ?? associatedVideoPath, ct)
                            : null);
                    srtContent = converted.Srt;
                    textOrigin = SubtitleTextOrigin.Parsed;
                    originalSourceFormat = OriginalSubtitleFormat.Sub;

                    await LogAsync(LogLevelKind.Info, "libraryScanner", libraryPathItemId,
                        $"Imported .sub subtitle ({converted.Kind}, parsed) for translation",
                        new { sourceFormat = "sub", textOrigin = "parsed", subKind = converted.Kind.ToString(),
                            rows = converted.Entries.Count, fpsUsed = converted.FpsUsed,
                            fromEmbeddedExtract = isTemp }, ct);
                }
                catch (Exception e) when (e is SubParseException or IOException or LibraryConnectionException)
                {
                    await LogAsync(LogLevelKind.Error, "libraryScanner", libraryPathItemId,
                        $"Failed to import .sub subtitle for translation: {e.Message}",
                        new { sourceFormat = "sub", error = e.Message }, ct);
                    await SetItemStatusAsync(libraryPathItemId, LibraryPathItemStatus.Failed, ct);
                    if (isTemp) ExtractTemp.SafeDeleteTempExtract(srtFilePath);
                    return new TranslateResult(false, e.Message);
                }
                finally
                {
                    LibraryStaging.SafeDeleteFile(stagedMedia);
                }
            }
            else
            {
                try
                {
                    srtContent = await fsx.ReadTextAsync(srtFilePath, ct);
                }
                catch (Exception e)
                {
                    await LogAsync(LogLevelKind.Error, "libraryScanner", libraryPathItemId,
                        "Failed to read SRT file for auto-translate",
                        new { path = srtFilePath, isTemp, error = e.ToString() }, ct);
                    await SetItemStatusAsync(libraryPathItemId, LibraryPathItemStatus.Failed, ct);
                    if (isTemp) ExtractTemp.SafeDeleteTempExtract(srtFilePath);
                    return new TranslateResult(false, "Could not read SRT file");
                }
            }

            if (isTemp) ExtractTemp.SafeDeleteTempExtract(srtFilePath);

            List<long> targetLangIds;
            if (overrideTargetLangIds != null)
            {
                targetLangIds = overrideTargetLangIds;
            }
            else
            {
                targetLangIds = (await languages.GetDefaultTranslationLanguagesAsync(ct))
                    .Select(l => l.LanguageId)
                    .ToList();
            }
            if (targetLangIds.Count == 0)
            {
                await LogAsync(LogLevelKind.Warning, "libraryScanner", libraryPathItemId,
                    "No default target languages configured — cannot auto-translate library item", null, ct);
                return new TranslateResult(false, "No default target languages configured — add them in Settings");
            }

            var srtFileName = Path.GetFileName(srtFilePath);

            string? displayName = null;
            MediaItem? mediaItem = null;
            if (mediaItemId != null)
                mediaItem = await db.MediaItems.FirstOrDefaultAsync(m => m.Id == mediaItemId.Value, ct);
            displayName = mediaItem?.Title;

            var storedSourcePath = isTemp ? null : srtFilePath;
            var storedMediaDir = isTemp
                ? Path.GetDirectoryName(libraryPath.Path)
                : Path.GetDirectoryName(srtFilePath);

            var result = await tasks.CreateSubtitleTaskAsync(
                actingUserId ?? await AdminUserIdAsync(ct),
                mediaItemId, effectiveSourceLangId, targetLangIds, srtContent, chunkSetting,
                season, episode, srtFileName, displayName,
                SubtitleSourceKind.Library, storedSourcePath, storedMediaDir, libraryPathItemId,
                textOrigin, originalSourceFormat, ct);

            if (result.Success)
            {
                await SetItemStatusAsync(libraryPathItemId, LibraryPathItemStatus.Queued, ct);
                await LogAsync(LogLevelKind.Info, "libraryScanner", libraryPathItemId,
                    $"Queued library item for translation: {srtFileName}",
                    new { srtFileName, targetLangIds, fromEmbeddedExtract = isTemp,
                        textOrigin, originalSourceFormat }, ct);
                dashboardEvents.LibraryRequestsChanged();
                return new TranslateResult(true, result.Msg ?? "Queued for translation");
            }

            await LogAsync(LogLevelKind.Warning, "libraryScanner", libraryPathItemId,
                $"Failed to create subtitle task for library item: {result.Msg ?? "unknown reason"}",
                new { srtFileName, msg = result.Msg }, ct);
            return new TranslateResult(false, result.Msg ?? "Failed to create subtitle task");
        }
        finally
        {
            if (ownedFs != null) await ownedFs.DisposeAsync();
        }
    }

    public async Task<TranslateResult> PrepareTranslationForItemAsync(
        long itemId, bool resetStatus, long userId,
        SubtitleSourceOverride? sourceOverride, string? sourceLanguageHint = null,
        string? ocrSrtPath = null, CancellationToken ct = default)
    {
        var item = await db.LibraryPathItems.FirstOrDefaultAsync(i => i.Id == itemId, ct);
        if (item == null) return new TranslateResult(false, "Item not found");
        if (await db.LibraryPathItemBlacklist.AnyAsync(b => b.LibraryPathItemId == itemId, ct))
            return new TranslateResult(false, "Item is blacklisted — remove it from the blacklist first");

        var libraryPath = await db.LibraryPaths.FirstOrDefaultAsync(p => p.Id == item.LibraryPathId, ct);
        if (libraryPath == null) return new TranslateResult(false, "Library path not found");
        await using var fs = await fsFactory.CreateAsync(libraryPath, ct);

        if (resetStatus)
            await SetItemStatusAsync(itemId, LibraryPathItemStatus.NotStarted, ct);

        var isSubtitleItem = SubtitleFileTypes.SubtitleExtensions.Contains(
            Path.GetExtension(item.Path).ToLowerInvariant());
        var associatedVideoPath = isSubtitleItem ? null : item.Path;

        var sourceLang = await db.Languages.FirstOrDefaultAsync(l => l.Id == libraryPath.SourceLanguageId, ct);

        MediaProbeService.ResolvedSrtSource? srtSource = null;
        if (ocrSrtPath != null)
        {
            srtSource = new MediaProbeService.ResolvedSrtSource(ocrSrtPath, true);
        }
        else if (isSubtitleItem)
        {
            srtSource = new MediaProbeService.ResolvedSrtSource(item.Path, false);
        }
        else if (sourceOverride != null && !string.IsNullOrEmpty(sourceOverride.Path))
        {
            if (sourceOverride.Type == "external" && await fs.ExistsAsync(sourceOverride.Path, ct))
            {
                if (!LibraryPathsService.IsWithinRoot(sourceOverride.Path, libraryPath.Path))
                    return new TranslateResult(false, "Source file is outside the library path");
                srtSource = new MediaProbeService.ResolvedSrtSource(sourceOverride.Path, false);
            }
            else if (sourceOverride.Type == "embedded" && sourceLang != null)
            {
                srtSource = await ResolveSrtSourceStagedAsync(fs, libraryPath, item.Path, sourceLang.Iso639,
                    sourceLang.Iso6392B, sourceLang.Name, sourceOverride.TrackId, sourceOverride.Codec, ct);
            }
        }
        else if (sourceLang != null)
        {
            srtSource = await ResolveSrtSourceStagedAsync(fs, libraryPath, item.Path, sourceLang.Iso639,
                sourceLang.Iso6392B, sourceLang.Name, ct: ct);
        }

        if (srtSource == null)
            return new TranslateResult(false, "No SRT file found next to video file");

        var config = await configRepo.GetAsync(ct);
        if (config == null) return new TranslateResult(false, "Configuration not found");

        var userLangs = await languages.GetUserTranslationLanguagesAsync(userId, ct);
        var targetLangIds = userLangs.Count > 0
            ? userLangs.Select(l => l.LanguageId).ToList()
            : (await languages.GetDefaultTranslationLanguagesAsync(ct)).Select(l => l.LanguageId).ToList();

        long? sourceLangIdOverride = null;
        var sourceLangCode = sourceOverride?.Language ?? sourceLanguageHint;
        if (!string.IsNullOrEmpty(sourceLangCode))
        {
            var lang = await languages.GetByIso639Async(sourceLangCode, ct);
            sourceLangIdOverride = lang?.Id;
        }

        try
        {
            return await AutoTranslateItemAsync(libraryPath, itemId, srtSource.Path, srtSource.IsTemp,
                item.MediaItemId, item.Season, item.Episode, config.DefaultChunkSize,
                targetLangIds, sourceLangIdOverride, associatedVideoPath, sourceOverride?.Fps, ct: ct, fs: fs);
        }
        catch (Exception)
        {
            return new TranslateResult(false, "Failed to queue translation");
        }
    }

    private async Task<MediaProbeService.ResolvedSrtSource?> ResolveSrtSourceStagedAsync(
        ILibraryFileSystem fs, LibraryPath libraryPath, string itemPath,
        string iso1, string? iso2b, string langName,
        long? preferTrackId = null, string? preferCodec = null, CancellationToken ct = default)
    {
        if (preferTrackId is null or <= 0 && preferCodec == null)
        {
            var best = LibraryNameParser.SelectBestSrt(
                await probe.FindCompanionSubtitlesAsync(itemPath, fs), [], iso1, langName);
            if (best != null) return new MediaProbeService.ResolvedSrtSource(best, false);
        }

        string? staged = null;
        try
        {
            if (fs.IsRemote)
                staged = await fs.StageToWorkAsync(itemPath, LibraryStaging.ScanDir(libraryPath.Id), ct);
            return await probe.ResolveSrtSourceAsync(itemPath, iso1, iso2b, langName,
                preferTrackId, preferCodec, ct, fs, staged);
        }
        finally
        {
            LibraryStaging.SafeDeleteFile(staged);
        }
    }

    public sealed record SubtitleSourceOverride(
        string Type, string Path, string Language, string Codec,
        long? TrackId = null, string? OcrLang = null, double? Fps = null, bool ImageBased = false);

    private async Task<long> AdminUserIdAsync(CancellationToken ct)
    {
        var adminId = await db.UserRoles
            .Join(db.Roles, ur => ur.RoleId, r => r.Id, (ur, r) => new { ur.UserId, r.Level })
            .GroupBy(x => x.UserId)
            .OrderByDescending(g => g.Max(x => x.Level))
            .ThenBy(g => g.Key)
            .Select(g => (long?)g.Key)
            .FirstOrDefaultAsync(ct);
        if (adminId != null) return adminId.Value;
        var first = await db.Users.OrderBy(u => u.Id).Select(u => (long?)u.Id).FirstOrDefaultAsync(ct);
        return first ?? 0;
    }

    private async Task SetItemStatusAsync(long itemId, LibraryPathItemStatus status, CancellationToken ct)
    {
        await db.LibraryPathItems.Where(i => i.Id == itemId).ExecuteUpdateAsync(u => u
            .SetProperty(x => x.Status, status)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
    }

    private async Task LogAsync(LogLevelKind level, string entityType, long? entityId,
        string message, object? metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new ApplicationLog
            {
                Level = level,
                Type = entityType,
                EntityType = entityType,
                EntityId = entityId,
                Message = message,
                Metadata = metadata is null ? null : System.Text.Json.JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            }, ct);
        }
        catch (Exception)
        {
        }
    }
}