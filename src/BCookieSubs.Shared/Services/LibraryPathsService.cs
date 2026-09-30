using System.Globalization;
using System.Text.Json;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Storage;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Shared.Services;

public record LibraryOperationResult(bool Success, string? Msg = null);

public record LibraryMediaItemDto(
    long Id, string Type, string Title, string? OriginalTitle, int? Year,
    string? TheMovieDbId, bool? IsAnime, string? Genres, string? PhotoPath);

public record LibraryCandidateDto(
    long LibraryPathItemId, long MediaItemId, string? Title, int? Year, string? PhotoPath, string? Type);

public record LibrarySubtitleJobDto(long JobId, long TargetLangId, string? LangName, string? LangFlag, string? LangIso, string JobStatus);

public record LibrarySubtitleInfoDto(long SubtitleId, bool Deleted, List<LibrarySubtitleJobDto> Jobs);

public record LibraryBlacklistDto(long Id, string? Reason, DateTime CreatedAt);

public record LibraryItemDto(
    long Id, long LibraryPathId, long? MediaItemId, string Status, int? Season, int? Episode,
    bool IsExtra, string Path, string ExtractFileName, List<LibraryCandidateDto> Candidates,
    LibraryMediaItemDto? MediaItem, LibrarySubtitleInfoDto? SubtitleInfo, LibraryBlacklistDto? Blacklist);

public record LibraryGroupDto(long? MediaItemId, LibraryMediaItemDto? MediaItem, List<LibraryItemDto> Items);

public record LibraryPathViewDto(
    long Id, string Name, string Path, string Type, bool Enabled, bool AutoTranslate, bool AutoExtract,
    string State, DateTime? LastRunAt, long SourceLanguageId, string? SourceLangName,
    long? InitialScanDurationMs, int PostInitialScanCount, long PostInitialScanTotalMs, long? LastScanDurationMs,
    string ScanMode, int ScanRepeatInterval, string ScanRepeatUnit, int ScanDayOfWeek,
    int ScanStartTimeHour, int ScanStartTimeMinute, int ScanDurationMinutes, DateTime? ScanFirstStartAt,
    bool InitialScanCompleted,
    string Storage, string? SftpHost, int SftpPort, string? SftpUsername, string SftpAuthMode,
    string? SftpHostKeyFingerprint, bool HasSftpPassword, bool HasSftpPrivateKey,
    List<LibraryGroupDto> Groups);

public record LibraryBlacklistRowDto(
    long Id, long LibraryPathItemId, string? Reason, DateTime CreatedAt,
    long LibraryPathId, string? LibraryPathName, string ItemPath, string ExtractFileName,
    int? Season, int? Episode, string? BlacklistedByUsername, string? MediaTitle, int? MediaYear);

public record LibraryPathForm(
    string Name, string Path, long SourceLanguageId, string Type,
    bool Enabled, bool AutoTranslate, bool AutoExtract,
    string? ScanMode, int? ScanRepeatInterval, string? ScanRepeatUnit, int? ScanDayOfWeek,
    int? ScanStartTimeHour, int? ScanStartTimeMinute, int? ScanDurationMinutes, string? ScanFirstStartAt,
    string? Storage = "local",
    string? SftpHost = null, int? SftpPort = null, string? SftpUsername = null,
    string? SftpAuthMode = "password",
    string? SftpPassword = null, string? SftpPrivateKey = null, string? SftpKeyPassphrase = null,
    bool ClearSftpPassword = false, bool ClearSftpPrivateKey = false, bool ClearSftpKeyPassphrase = false,
    string? SftpHostKeyFingerprint = null);

public record LibraryTmdbMatchForm(
    string? Title, string? OriginalTitle, string? Year, string? IsAnime, string? Genres,
    string? TheMovieDbId, string? PosterUrl, string? Type);

public record LibraryMatchResultDto(bool Success, string Msg, long? MediaItemId, int Updated, int Skipped);

public class LibraryPathsService(
    LibraryPathRepository libraryPaths,
    LibraryPathItemRepository items,
    MediaItemRepository mediaItems,
    SubtitleRepository subtitles,
    LanguageRepository languages,
    ApplicationConfigRepository configs,
    UserRepository users,
    PermissionService permissions,
    ApplicationLogRepository logs,
    TheMovieDbService tmdb,
    MediaItemService mediaItemService,
    MediaPhotosService photos,
    SecretsService secrets,
    ILogger<LibraryPathsService> logger)
{
    public const string AddPathPermission = "canAddPathForLibraryPaths";
    public const string EditPathPermission = "canEditLibraryPath";
    public const string DisableDeletePermission = "canDisableAndDeleteALibraryPath";
    public const string BlacklistPermission = "canBlackListALibraryPathItem";
    public const string ChangeMatchPermission = "canChangeMatchForLibraryPaths";


    public async Task<List<LibraryPathViewDto>> GetViewDataAsync(string type, CancellationToken ct = default)
    {
        var pathType = type == "series" ? LibraryPathType.Series : LibraryPathType.Movie;
        var paths = await libraryPaths.GetByTypeAsync(pathType, ct);
        if (paths.Count == 0) return [];

        var pathIds = paths.Select(p => p.Id).ToList();
        var allItems = await items.GetByLibraryPathIdsAsync(pathIds, ct);
        var enriched = await EnrichItemsAsync(allItems, ct);

        var langNames = (await languages.GetAllAsync(ct)).ToDictionary(l => l.Id, l => l.Name);

        var hasPassword = new Dictionary<long, bool>();
        var hasKey = new Dictionary<long, bool>();
        foreach (var lp in paths)
        {
            if (lp.Storage != LibraryStorageKind.Sftp) continue;
            hasPassword[lp.Id] = await secrets.GetAsync(SecretKeys.SftpPassword(lp.Id), ct) != null;
            hasKey[lp.Id] = await secrets.GetAsync(SecretKeys.SftpPrivateKey(lp.Id), ct) != null;
        }

        return paths.Select(lp => new LibraryPathViewDto(
            lp.Id, lp.Name, lp.Path, lp.Type.ToString().ToLowerInvariant(), lp.Enabled,
            lp.AutoTranslate, lp.AutoExtract, lp.State.ToString().ToLowerInvariant(), lp.LastRunAt,
            lp.SourceLanguageId, langNames.GetValueOrDefault(lp.SourceLanguageId),
            lp.InitialScanDurationMs, lp.PostInitialScanCount, lp.PostInitialScanTotalMs, lp.LastScanDurationMs,
            lp.ScanMode.ToString().ToLowerInvariant(),
            lp.ScanRepeatInterval, lp.ScanRepeatUnit.ToString().ToLowerInvariant(),
            LibraryScanSchedule.JsDayOfWeek(lp.ScanDayOfWeek),
            lp.ScanStartTime.Hours, lp.ScanStartTime.Minutes, lp.ScanDurationMinutes, lp.ScanFirstStartAt,
            lp.InitialScanCompleted,
            lp.Storage.ToString().ToLowerInvariant(), lp.SftpHost, lp.SftpPort, lp.SftpUsername,
            lp.SftpAuthMode.ToString().ToLowerInvariant(), lp.SftpHostKeyFingerprint,
            hasPassword.GetValueOrDefault(lp.Id), hasKey.GetValueOrDefault(lp.Id),
            GroupItems(enriched.Values.Where(i => i.LibraryPathId == lp.Id).ToList()))).ToList();
    }

    public async Task<List<LibraryBlacklistRowDto>> GetBlacklistedAsync(CancellationToken ct = default) =>
        (await items.GetAllBlacklistedAsync(ct))
            .Select(b => new LibraryBlacklistRowDto(b.Id, b.LibraryPathItemId, b.Reason, b.CreatedAt,
                b.LibraryPathId, b.LibraryPathName, b.ItemPath, b.ExtractFileName,
                b.Season, b.Episode, b.BlacklistedByUsername, b.MediaTitle, b.MediaYear))
            .ToList();

    public async Task<List<LibraryItemDto>> GetItemsByIdsAsync(List<long> ids, CancellationToken ct = default) =>
        ids.Count == 0 ? [] : (await EnrichItemsAsync(await items.GetByIdsAsync(ids, ct), ct)).Values.ToList();

    public async Task<(List<TmdbSearchItem> Items, string? Error)> SearchTmdbAsync(
        string query, string type, CancellationToken ct = default) =>
        await tmdb.SearchAsync(query, type, null, ct);

    public async Task<(List<TmdbSearchItem> Items, bool Success, string? Msg)> SearchTmdbForItemAsync(
        long itemId, string query, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(query)) return ([], true, null);
        var item = await items.GetAsync(itemId, ct);
        if (item == null) return ([], false, "Item not found");
        var lp = await libraryPaths.GetAsync(item.LibraryPathId, ct);
        var type = lp is { Type: LibraryPathType.Movie } ? "movie" : "series";
        var (result, error) = await tmdb.SearchAsync(query, type, null, ct);
        return (result, error == null, error);
    }


    public async Task<LibraryOperationResult> CreateAsync(long actingUserId, LibraryPathForm form, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, AddPathPermission, ct))
            return new(false, "Permission denied");

        var (error, sched) = await ValidateFormAsync(form, isCreate: true, existingId: null, ct);
        if (error != null) return new(false, error);

        var lp = new LibraryPath
        {
            Name = form.Name.Trim(),
            Path = form.Path.Trim(),
            SourceLanguageId = form.SourceLanguageId,
            Type = form.Type == "series" ? LibraryPathType.Series : LibraryPathType.Movie,
            Enabled = form.Enabled,
            AutoTranslate = form.AutoTranslate,
            AutoExtract = form.AutoExtract,
            Storage = ParseStorage(form.Storage),
            SftpHost = TrimOrNull(form.SftpHost),
            SftpPort = form.SftpPort ?? 22,
            SftpUsername = TrimOrNull(form.SftpUsername),
            SftpAuthMode = ParseAuthMode(form.SftpAuthMode),
            SftpHostKeyFingerprint = TrimOrNull(form.SftpHostKeyFingerprint),
        };
        sched!.Apply(lp);

        try
        {
            await libraryPaths.AddAsync(lp, ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            return new(false, "Path already exists");
        }

        try
        {
            await ApplySftpSecretsAsync(lp.Id, form, ct);
        }
        catch (Exception ex)
        {
            await libraryPaths.DeleteAsync(lp, ct);
            await DeleteSftpSecretsAsync(lp.Id, ct);
            logger.LogWarning(ex, "Failed to store SFTP credentials for library path {Name}", form.Name);
            return new(false, "Could not store the SFTP credentials securely — check the SECRET_ENCRYPTION_KEY configuration");
        }

        await LogAsync(LogLevelKind.Info, "libraryPathCreate", "libraryPath", lp.Id, "Created library path",
            new
            {
                name = form.Name, path = form.Path, type = form.Type, scanMode = sched.Mode,
                storage = lp.Storage.ToString().ToLowerInvariant(), sftpHost = lp.SftpHost,
            }, ct);
        return new(true, null);
    }

    public async Task<LibraryOperationResult> UpdateAsync(long actingUserId, long id, LibraryPathForm form, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, EditPathPermission, ct))
            return new(false, "Permission denied");

        var lp = await libraryPaths.GetAsync(id, ct);
        if (lp == null) return new(false, "Library path not found");

        var (error, sched) = await ValidateFormAsync(form, isCreate: false, existingId: id, ct);
        if (error != null) return new(false, error);

        lp.Name = form.Name.Trim();
        lp.Path = form.Path.Trim();
        lp.SourceLanguageId = form.SourceLanguageId;
        lp.Type = form.Type == "series" ? LibraryPathType.Series : LibraryPathType.Movie;
        lp.Enabled = form.Enabled;
        lp.AutoTranslate = form.AutoTranslate;
        lp.AutoExtract = form.AutoExtract;
        lp.Storage = ParseStorage(form.Storage);
        lp.SftpHost = TrimOrNull(form.SftpHost);
        lp.SftpPort = form.SftpPort ?? 22;
        lp.SftpUsername = TrimOrNull(form.SftpUsername);
        lp.SftpAuthMode = ParseAuthMode(form.SftpAuthMode);
        lp.SftpHostKeyFingerprint = TrimOrNull(form.SftpHostKeyFingerprint);
        sched!.Apply(lp);

        try
        {
            try
            {
                await ApplySftpSecretsAsync(id, form, ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to store SFTP credentials for library path {Name}", form.Name);
                return new(false, "Could not store the SFTP credentials securely — check the SECRET_ENCRYPTION_KEY configuration");
            }

            await libraryPaths.UpdateEditableFieldsAsync(id, lp, ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            return new(false, "Path already exists");
        }

        await LogAsync(LogLevelKind.Info, "libraryPathUpdate", "libraryPath", id, "Updated library path",
            new
            {
                name = form.Name, path = form.Path, scanMode = sched.Mode,
                storage = lp.Storage.ToString().ToLowerInvariant(), sftpHost = lp.SftpHost,
            }, ct);
        return new(true, null);
    }

    public async Task<LibraryOperationResult> ToggleAsync(long actingUserId, long id, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, DisableDeletePermission, ct))
            return new(false, "Permission denied");

        var lp = await libraryPaths.GetAsync(id, ct);
        if (lp == null) return new(false, "Library path not found");

        await libraryPaths.SetEnabledAsync(id, !lp.Enabled, ct);
        return new(true, null);
    }

    public async Task<LibraryOperationResult> RescanAsync(long actingUserId, long id, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, EditPathPermission, ct))
            return new(false, "Permission denied");

        var lp = await libraryPaths.GetAsync(id, ct);
        if (lp == null) return new(false, "Library path not found");

        var previousState = lp.State;
        await libraryPaths.ResetForRescanAsync(id, ct);

        var actor = await users.GetAsync(actingUserId, ct);
        await LogAsync(LogLevelKind.Info, "libraryPathRescan", "libraryPath", id,
            $"Rescan requested for library path \"{lp.Name}\"",
            new
            {
                name = lp.Name,
                previousState = previousState.ToString().ToLowerInvariant(),
                requestedByUserId = actingUserId,
                requestedByUsername = actor?.UserName,
            }, ct);
        return new(true, "Rescan started");
    }

    public async Task<LibraryOperationResult> DeleteAsync(long actingUserId, long id, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, DisableDeletePermission, ct))
            return new(false, "Permission denied");

        var lp = await libraryPaths.GetAsync(id, ct);
        if (lp == null) return new(false, "Library path not found");

        await libraryPaths.DeleteAsync(lp, ct);
        await LogAsync(LogLevelKind.Info, "libraryPathDelete", "libraryPath", id, "Deleted library path",
            new { name = lp.Name }, ct);
        return new(true, null);
    }


    public record SftpTestResult(
        bool Success, string? Error, string? PresentedFingerprint,
        bool NeedsTrust, bool KeyChanged, List<string> Steps);

    public async Task<SftpTestResult> TestSftpConnectionAsync(
        long actingUserId, long? existingId, LibraryPathForm form, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, AddPathPermission, ct) &&
            !await HasPermissionAsync(actingUserId, EditPathPermission, ct))
            return new(false, "Permission denied", null, false, false, []);

        if ((form.Storage ?? "local").Equals("local", StringComparison.OrdinalIgnoreCase))
            return new(false, "Not an SFTP path", null, false, false, []);

        var host = TrimOrNull(form.SftpHost);
        if (host == null) return new(false, "SFTP host is required", null, false, false, []);
        var port = form.SftpPort ?? 22;
        if (port < 1 || port > 65535) return new(false, "SFTP port must be between 1 and 65535", null, false, false, []);
        var username = TrimOrNull(form.SftpUsername);
        if (username == null) return new(false, "SFTP username is required", null, false, false, []);

        var authMode = ParseAuthMode(form.SftpAuthMode);
        var password = string.IsNullOrWhiteSpace(form.SftpPassword)
            ? existingId != null && !form.ClearSftpPassword
                ? await secrets.GetAsync(SecretKeys.SftpPassword(existingId.Value), ct)
                : null
            : form.SftpPassword;
        var keyPem = string.IsNullOrWhiteSpace(form.SftpPrivateKey)
            ? existingId != null && !form.ClearSftpPrivateKey
                ? await secrets.GetAsync(SecretKeys.SftpPrivateKey(existingId.Value), ct)
                : null
            : form.SftpPrivateKey;
        var passphrase = string.IsNullOrWhiteSpace(form.SftpKeyPassphrase)
            ? existingId != null && !form.ClearSftpKeyPassphrase
                ? await secrets.GetAsync(SecretKeys.SftpKeyPassphrase(existingId.Value), ct)
                : null
            : form.SftpKeyPassphrase;

        if (authMode == LibrarySftpAuthMode.Password && password == null)
            return new(false, "No password provided or stored for this path", null, false, false, []);
        if (authMode == LibrarySftpAuthMode.PrivateKey && keyPem == null)
            return new(false, "No private key provided or stored for this path", null, false, false, []);

        string? previouslyTrusted = null;
        if (existingId != null)
        {
            var lp = await libraryPaths.GetAsync(existingId.Value, ct);
            previouslyTrusted = lp?.SftpHostKeyFingerprint;
        }
        var accepted = TrimOrNull(form.SftpHostKeyFingerprint) ?? previouslyTrusted;

        var result = await SftpConnectivityTest.RunAsync(new SftpConnectivityTest.Request(
            host!, port, username!,
            authMode == LibrarySftpAuthMode.Password ? password : null,
            authMode == LibrarySftpAuthMode.PrivateKey ? keyPem : null,
            authMode == LibrarySftpAuthMode.PrivateKey ? passphrase : null,
            TrimOrNull(form.Path),
            accepted, previouslyTrusted), ct);

        return new(result.Success, result.Error, result.PresentedFingerprint,
            result.NeedsTrust, result.KeyChanged, [.. result.Steps]);
    }


    public async Task<LibraryOperationResult> SelectCandidateAsync(
        long actingUserId, long itemId, long? mediaItemId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, ChangeMatchPermission, ct))
            return new(false, "Permission denied");
        if (mediaItemId == null) return new(false, "Invalid media item");

        var item = await items.GetAsync(itemId, ct);
        if (item == null) return new(false, "Item not found");

        await ApplyMediaMatchAsync(itemId, mediaItemId.Value, item.Status, ct);
        return new(true, "Media match selected");
    }

    public async Task<LibraryMatchResultDto> SelectTmdbResultAsync(
        long actingUserId, long itemId, LibraryTmdbMatchForm form, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, ChangeMatchPermission, ct))
            return new(false, "Permission denied", null, 0, 0);
        if (string.IsNullOrWhiteSpace(form.Title))
            return new(false, "Title is required", null, 0, 0);

        var item = await items.GetAsync(itemId, ct);
        if (item == null) return new(false, "Item not found", null, 0, 0);

        var lp = await libraryPaths.GetAsync(item.LibraryPathId, ct);
        var created = await CreateMediaFromTmdbAsync(actingUserId, form,
            form.Type is { Length: > 0 } ? form.Type : lp is { Type: LibraryPathType.Movie } ? "movie" : "series", ct);
        if (!created.Success) return new(false, created.Msg, null, 0, 0);

        await ApplyMediaMatchAsync(itemId, created.MediaItem!.Id, item.Status, ct);
        return new(true, "Match selected", created.MediaItem.Id, 0, 0);
    }

    public async Task<LibraryMatchResultDto> BulkChangeMatchAsync(
        long actingUserId, List<long> itemIds, string type, LibraryTmdbMatchForm form, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, ChangeMatchPermission, ct))
            return new(false, "Permission denied", null, 0, 0);
        if (itemIds.Count == 0) return new(false, "No items selected", null, 0, 0);
        if (string.IsNullOrWhiteSpace(form.Title)) return new(false, "Invalid TMDB result", null, 0, 0);

        var created = await CreateMediaFromTmdbAsync(actingUserId, form,
            type == "series" ? "series" : "movie", ct);
        if (!created.Success) return new(false, created.Msg, null, 0, 0);

        var updated = 0;
        var skipped = 0;
        foreach (var itemId in itemIds)
        {
            var item = await items.GetAsync(itemId, ct);
            if (item == null)
            {
                skipped++;
                continue;
            }
            await ApplyMediaMatchAsync(itemId, created.MediaItem!.Id, item.Status, ct);
            updated++;
        }
        return new(true, $"Updated {updated} item(s){(skipped > 0 ? $", skipped {skipped}" : "")}",
            created.MediaItem!.Id, updated, skipped);
    }

    public async Task<LibraryMatchResultDto> GroupSelectCandidateAsync(
        long actingUserId, List<long> itemIds, long? mediaItemId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, ChangeMatchPermission, ct))
            return new(false, "Permission denied", null, 0, 0);
        if (mediaItemId == null || itemIds.Count == 0) return new(false, "Invalid request", null, 0, 0);

        foreach (var id in itemIds)
        {
            var item = await items.GetAsync(id, ct);
            if (item == null) continue;
            await ApplyMediaMatchAsync(id, mediaItemId.Value, item.Status, ct);
        }
        return new(true, "Match selected", mediaItemId, 0, 0);
    }

    public async Task<LibraryMatchResultDto> GroupSelectTmdbResultAsync(
        long actingUserId, List<long> itemIds, LibraryTmdbMatchForm form, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, ChangeMatchPermission, ct))
            return new(false, "Permission denied", null, 0, 0);
        if (string.IsNullOrWhiteSpace(form.Title) || itemIds.Count == 0)
            return new(false, "Missing required fields", null, 0, 0);

        var created = await CreateMediaFromTmdbAsync(actingUserId, form,
            form.Type == "movie" ? "movie" : "series", ct);
        if (!created.Success) return new(false, created.Msg, null, 0, 0);

        foreach (var id in itemIds)
        {
            var item = await items.GetAsync(id, ct);
            if (item == null) continue;
            await ApplyMediaMatchAsync(id, created.MediaItem!.Id, item.Status, ct);
        }
        return new(true, "Match selected", created.MediaItem!.Id, 0, 0);
    }


    public async Task<LibraryOperationResult> BlacklistAsync(
        long actingUserId, long itemId, string? reason, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, BlacklistPermission, ct))
            return new(false, "Permission denied");

        var item = await items.GetAsync(itemId, ct);
        if (item == null) return new(false, "Library item not found");

        var trimmed = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
        var existing = await items.GetBlacklistByItemIdsAsync([itemId], ct);
        await items.UpsertBlacklistAsync(itemId, actingUserId, trimmed, ct);

        if (existing.Count > 0) return new(true, "Blacklist entry updated");

        var actor = await users.GetAsync(actingUserId, ct);
        await LogAsync(LogLevelKind.Info, "libraryPathBlacklist", "libraryPath", item.LibraryPathId,
            $"Blacklisted library item from translation: {item.Path}",
            new
            {
                libraryPathItemId = itemId,
                libraryPathId = item.LibraryPathId,
                blacklistedByUserId = actingUserId,
                blacklistedByUsername = actor?.UserName,
                reason = trimmed,
            }, ct);
        return new(true, "Item blacklisted");
    }

    public async Task<LibraryOperationResult> UnblacklistAsync(long actingUserId, long itemId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(actingUserId, BlacklistPermission, ct))
            return new(false, "Permission denied");

        var item = await items.GetAsync(itemId, ct);
        if (item == null) return new(false, "Library item not found");

        var removed = await items.DeleteBlacklistAsync(itemId, ct);
        if (removed == 0) return new(false, "Item was not blacklisted");

        var actor = await users.GetAsync(actingUserId, ct);
        await LogAsync(LogLevelKind.Info, "libraryPathBlacklist", "libraryPath", item.LibraryPathId,
            $"Removed library item from blacklist: {item.Path}",
            new
            {
                libraryPathItemId = itemId,
                libraryPathId = item.LibraryPathId,
                removedByUserId = actingUserId,
                removedByUsername = actor?.UserName,
            }, ct);
        return new(true, "Item removed from blacklist");
    }

    public async Task<LibraryOperationResult> GroupBlacklistAsync(
        long actingUserId, List<long> itemIds, string? reason, CancellationToken ct = default)
    {
        if (itemIds.Count == 0) return new(false, "No items specified");

        var failed = 0;
        foreach (var id in itemIds)
        {
            var result = await BlacklistAsync(actingUserId, id, reason, ct);
            if (!result.Success) failed++;
        }
        var successCount = itemIds.Count - failed;
        var msg = failed > 0
            ? $"{successCount} of {itemIds.Count} items blacklisted ({failed} failed)"
            : $"{successCount} item{(successCount != 1 ? "s" : "")} blacklisted";
        return new(true, msg);
    }


    public record BrowseResult(string Path, string? Parent, List<(string Name, string FullPath)> Dirs, string? Error);

    public async Task<BrowseResult> BrowseAsync(string? requestedPath, CancellationToken ct = default)
    {
        var config = await configs.GetAsync(ct);
        var root = string.IsNullOrWhiteSpace(config?.RootLibraryPath) ? null : Path.GetFullPath(config.RootLibraryPath);

        var requested = string.IsNullOrWhiteSpace(requestedPath) ? root ?? "/" : requestedPath;
        var resolved = SafeResolve(requested, root);

        var dirs = new List<(string Name, string FullPath)>();
        string? error = null;
        try
        {
            foreach (var dir in Directory.EnumerateDirectories(resolved))
            {
                var name = Path.GetFileName(dir);
                if (name.StartsWith(".")) continue;
                if (root != null && EscapesRootViaSymlink(Path.GetFullPath(dir), root)) continue;
                dirs.Add((name, Path.Combine(resolved, name)));
            }
            dirs.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.CurrentCulture));
        }
        catch (Exception ex) when (ex is DirectoryNotFoundException or FileNotFoundException)
        {
            error = "Directory not found";
        }
        catch (UnauthorizedAccessException)
        {
            error = "Permission denied";
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        var rawParent = resolved != Path.GetDirectoryName(resolved) ? Path.GetDirectoryName(resolved) : null;
        var parent = root != null && rawParent != null && !IsInsideRoot(rawParent, root) ? null : rawParent;
        return new BrowseResult(resolved, parent, dirs, error);
    }


    public const long MaxPhotoUploadBytes = 5 * 1024 * 1024;

    public record PhotoUploadResult(bool Success, string Msg, string? PhotoPath);

    public async Task<PhotoUploadResult> UploadPhotoAsync(
        long actingUserId, long mediaItemId, Stream content, string? originalName,
        string? contentType, long length, CancellationToken ct = default)
    {
        if (length > MaxPhotoUploadBytes) return new(false, "File too large", null);
        if (string.IsNullOrEmpty(contentType) || !contentType.StartsWith("image/", StringComparison.Ordinal))
            return new(false, "No file uploaded", null);

        var existing = await mediaItems.GetPhotoPathAsync(mediaItemId, ct);
        var filename = await photos.SaveUploadedPhotoAsync(content, originalName, mediaItemId, ct);
        if (filename == null) return new(false, "Upload failed", null);

        MediaPhotosService.TryDeleteCustomPhoto(existing);
        await mediaItems.SetPhotoPathAsync(mediaItemId, filename, ct);
        return new(true, "Photo updated", filename);
    }


    private async Task<(string? Error, NormalizedSchedule? Schedule)> ValidateFormAsync(
        LibraryPathForm form, bool isCreate, long? existingId, CancellationToken ct)
    {
        if (form.Type is not ("movie" or "series")) return ("Type must be movie or series", null);
        if (form.Storage is not (null or "" or "local" or "sftp"))
            return ("Storage must be local or sftp", null);

        var storage = ParseStorage(form.Storage);
        var name = form.Name.Trim();
        if (name.Length == 0) return ("Name is required", null);
        if (form.Path.Trim().Length == 0) return ("Path is required", null);

        if (storage == LibraryStorageKind.Sftp)
        {
            var sftpError = await ValidateSftpFormAsync(form, isCreate, existingId, ct);
            if (sftpError != null) return (sftpError, null);
        }
        else
        {
            var config = await configs.GetAsync(ct);
            if (!string.IsNullOrWhiteSpace(config?.RootLibraryPath))
            {
                var rootError = RootConfinementError(form.Path, config.RootLibraryPath);
                if (rootError != null) return (rootError, null);
            }

            if (!Directory.Exists(form.Path.Trim()))
                return ($"Path \"{form.Path.Trim()}\" is not visible to the application — mount it into the web and worker containers via a volume (see docker-compose.yml / docs).", null);
        }

        var scheduleError = TryNormalizeSchedule(form, out var sched);
        if (scheduleError != null) return (scheduleError, null);

        if (await languages.GetAsync(form.SourceLanguageId, ct) == null)
            return ("Source language not found", null);
        if (await libraryPaths.NameExistsAsync(name, existingId ?? 0, ct))
            return ("A library path with that name already exists", null);

        return (null, sched);
    }

    // SFTP field checks. Credential rules: on create a credential is required;
    // on update an empty field keeps the stored secret (the clear flag removes
    // it and then a new one is required).
    private async Task<string?> ValidateSftpFormAsync(
        LibraryPathForm form, bool isCreate, long? existingId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(form.SftpHost)) return "SFTP host is required";
        var port = form.SftpPort ?? 22;
        if (port < 1 || port > 65535) return "SFTP port must be between 1 and 65535";
        if (string.IsNullOrWhiteSpace(form.SftpUsername)) return "SFTP username is required";
        if (!form.Path.Trim().StartsWith('/'))
            return "The remote root must be an absolute path starting with /";

        var authMode = ParseAuthMode(form.SftpAuthMode);
        if (authMode == LibrarySftpAuthMode.Password)
        {
            var effective = string.IsNullOrWhiteSpace(form.SftpPassword)
                ? form.ClearSftpPassword || isCreate
                    ? null
                    : await secrets.GetAsync(SecretKeys.SftpPassword(existingId!.Value), ct)
                : form.SftpPassword;
            if (effective == null) return "An SFTP password is required";
        }
        else
        {
            var effective = string.IsNullOrWhiteSpace(form.SftpPrivateKey)
                ? form.ClearSftpPrivateKey || isCreate
                    ? null
                    : await secrets.GetAsync(SecretKeys.SftpPrivateKey(existingId!.Value), ct)
                : form.SftpPrivateKey;
            if (effective == null) return "An SSH private key is required";
        }

        if (string.IsNullOrWhiteSpace(form.SftpHostKeyFingerprint))
            return "Run Test Connection and trust the server's host key before saving an SFTP path";
        if (!form.SftpHostKeyFingerprint.Trim().StartsWith("SHA256:", StringComparison.Ordinal))
            return "The host key fingerprint must look like SHA256:...";

        return null;
    }

    // Write-only secret handling: Set when provided, Delete on clear flags,
    // leave the stored value alone otherwise. Never called with secret values
    // in logs or results.
    private async Task ApplySftpSecretsAsync(long id, LibraryPathForm form, CancellationToken ct)
    {
        if (form.ClearSftpPassword)
            await secrets.DeleteAsync(SecretKeys.SftpPassword(id), ct);
        else if (!string.IsNullOrWhiteSpace(form.SftpPassword))
            await secrets.SetAsync(SecretKeys.SftpPassword(id), form.SftpPassword, setByEnv: false, ct);

        if (form.ClearSftpPrivateKey)
            await secrets.DeleteAsync(SecretKeys.SftpPrivateKey(id), ct);
        else if (!string.IsNullOrWhiteSpace(form.SftpPrivateKey))
            await secrets.SetAsync(SecretKeys.SftpPrivateKey(id), form.SftpPrivateKey, setByEnv: false, ct);

        if (form.ClearSftpKeyPassphrase)
            await secrets.DeleteAsync(SecretKeys.SftpKeyPassphrase(id), ct);
        else if (!string.IsNullOrWhiteSpace(form.SftpKeyPassphrase))
            await secrets.SetAsync(SecretKeys.SftpKeyPassphrase(id), form.SftpKeyPassphrase, setByEnv: false, ct);
    }

    private async Task DeleteSftpSecretsAsync(long id, CancellationToken ct)
    {
        await secrets.DeleteAsync(SecretKeys.SftpPassword(id), ct);
        await secrets.DeleteAsync(SecretKeys.SftpPrivateKey(id), ct);
        await secrets.DeleteAsync(SecretKeys.SftpKeyPassphrase(id), ct);
    }

    private static string? TrimOrNull(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static LibraryStorageKind ParseStorage(string? storage) =>
        string.Equals(storage, "sftp", StringComparison.OrdinalIgnoreCase)
            ? LibraryStorageKind.Sftp : LibraryStorageKind.Local;

    private static LibrarySftpAuthMode ParseAuthMode(string? mode) =>
        string.Equals(mode, "key", StringComparison.OrdinalIgnoreCase)
            ? LibrarySftpAuthMode.PrivateKey : LibrarySftpAuthMode.Password;

    private async Task<bool> HasPermissionAsync(long userId, string permission, CancellationToken ct)
    {
        var perms = await permissions.GetEffectivePermissionsAsync(userId, ct);
        return perms.Contains(permission);
    }

    // NormalizeSchedule: defaults for omitted fields, custom-mode
    // validation only, day-of-week in the JavaScript Monday=0 convention.
    private static string? TryNormalizeSchedule(LibraryPathForm form, out NormalizedSchedule sched)
    {
        sched = null!;
        var mode = form.ScanMode ?? "hourly";
        if (mode is not ("hourly" or "custom" or "never"))
        {
            return "Invalid scan mode";
        }

        if (mode != "custom")
        {
            sched = new NormalizedSchedule(mode, 1, "day", 0, 0, 0, 60, null);
            return null;
        }

        var interval = form.ScanRepeatInterval ?? 1;
        var unit = form.ScanRepeatUnit ?? "day";
        var dow = form.ScanDayOfWeek ?? 0;
        var hour = form.ScanStartTimeHour ?? 0;
        var minute = form.ScanStartTimeMinute ?? 0;
        var duration = form.ScanDurationMinutes ?? 60;

        if (interval < 1) return "Repeat interval must be a whole number of at least 1";
        if (unit is not ("day" or "week" or "month")) return "Invalid repeat unit";
        if (dow < 0 || dow > 6) return "Day of week is required for weekly/monthly scans";
        if (hour < 0 || hour > 23) return "Start hour must be 0-23";
        if (minute < 0 || minute > 59) return "Start minute must be 0-59";
        if (duration < 1) return "Duration must be at least 1 minute";

        DateTime? firstStart = null;
        if (!string.IsNullOrWhiteSpace(form.ScanFirstStartAt) &&
            DateTime.TryParse(form.ScanFirstStartAt, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
        {
            firstStart = parsed;
        }
        sched = new NormalizedSchedule(mode, interval, unit, dow, hour, minute, duration, firstStart);
        return null;
    }

    private sealed record NormalizedSchedule(
        string Mode, int Interval, string Unit, int JsDayOfWeek, int Hour, int Minute,
        int DurationMinutes, DateTime? FirstStartAt)
    {
        public void Apply(LibraryPath lp)
        {
            lp.ScanMode = Mode switch
            {
                "custom" => ScanMode.Custom,
                "never" => ScanMode.Never,
                _ => ScanMode.Hourly,
            };
            lp.ScanRepeatInterval = Interval;
            lp.ScanRepeatUnit = Unit switch
            {
                "week" => RepeatUnit.Week,
                "month" => RepeatUnit.Month,
                _ => RepeatUnit.Day,
            };
            lp.ScanDayOfWeek = (DayOfWeek)((JsDayOfWeek + 1) % 7);
            lp.ScanStartTime = new TimeSpan(Hour, Minute, 0);
            lp.ScanDurationMinutes = DurationMinutes;
            lp.ScanFirstStartAt = FirstStartAt;
        }
    }

    private static string? RootConfinementError(string path, string root)
    {
        var resolved = Path.GetFullPath(path);
        var resolvedRoot = Path.GetFullPath(root);
        if (!IsInsideRoot(resolved, resolvedRoot) || EscapesRootViaSymlink(resolved, resolvedRoot))
        {
            return $"Path must be inside the configured root folder: {root}";
        }
        return null;
    }

    private static string SafeResolve(string requested, string? root)
    {
        var resolved = Path.GetFullPath(requested);
        if (root != null && !IsInsideRoot(resolved, root)) return root;
        return resolved;
    }

    private static bool IsInsideRoot(string candidate, string root) =>
        candidate == root || candidate.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    // Public gate for user-supplied file paths: the target must resolve inside
    // root, including through intermediate symlinks.
    public static bool IsWithinRoot(string? candidate, string? root)
    {
        if (string.IsNullOrWhiteSpace(candidate) || string.IsNullOrWhiteSpace(root)) return false;
        var full = Path.GetFullPath(candidate);
        var rootFull = Path.GetFullPath(root);
        if (!IsInsideRoot(full, rootFull)) return false;
        return !EscapesRootViaSymlink(full, rootFull);
    }

    // Walks each path segment below the root so a symlinked parent cannot carry
    // the target outside either.
    private static bool EscapesRootViaSymlink(string resolved, string root)
    {
        var relative = resolved.Length > root.Length
            ? resolved[(root.Length + 1)..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
            : [];
        var current = root;
        foreach (var segment in relative)
        {
            current = Path.Combine(current, segment);
            var final = ResolveFinalLinkTarget(current);
            if (final != null && !IsInsideRoot(final, root)) return true;
        }
        return false;
    }

    private static string? ResolveFinalLinkTarget(string path)
    {
        try
        {
            FileSystemInfo fs = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);
            return fs.ResolveLinkTarget(returnFinalTarget: true)?.FullName;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private async Task<MediaItemCreateResult> CreateMediaFromTmdbAsync(
        long actingUserId, LibraryTmdbMatchForm form, string type, CancellationToken ct)
    {
        var parsedYear = int.TryParse(form.Year, out var y) ? y : (int?)null;
        return await mediaItemService.CreateAsync(
            actingUserId,
            form.Title!.Trim(),
            string.IsNullOrWhiteSpace(form.OriginalTitle) ? null : form.OriginalTitle.Trim(),
            type == "movie" ? MediaKind.Movie : MediaKind.Series,
            parsedYear,
            form.IsAnime == "1" || string.Equals(form.IsAnime, "true", StringComparison.OrdinalIgnoreCase),
            string.IsNullOrWhiteSpace(form.Genres) ? null : form.Genres.Trim(),
            string.IsNullOrWhiteSpace(form.TheMovieDbId) ? null : form.TheMovieDbId.Trim(),
            string.IsNullOrWhiteSpace(form.PosterUrl) ? null : form.PosterUrl.Trim(),
            ct: ct);
    }

    // Change-match apply: link the media item and reset the status, but
    // leave no_srts_found rows alone (they still have no subtitle to translate).
    // Candidates are intentionally not cleared.
    private async Task ApplyMediaMatchAsync(long itemId, long mediaItemId, LibraryPathItemStatus status, CancellationToken ct)
    {
        await items.SetMediaItemAsync(itemId, mediaItemId, ct);
        if (status != LibraryPathItemStatus.NoSrtsFound)
        {
            await items.SetStatusAsync(itemId, LibraryPathItemStatus.NotStarted, ct);
        }
    }

    /// <summary>
    /// Batched enrichment for a set of items: candidates, media items, latest
    /// subtitle info and blacklist rows.
    /// </summary>
    public async Task<Dictionary<long, LibraryItemDto>> EnrichItemsAsync(
        List<LibraryPathItem> rows, CancellationToken ct)
    {
        if (rows.Count == 0) return [];
        var itemIds = rows.Select(i => i.Id).ToList();

        var candidatesByItem = (await items.GetCandidatesByItemIdsAsync(itemIds, ct))
            .GroupBy(c => c.LibraryPathItemId)
            .ToDictionary(g => g.Key, g => g.ToList());
        var blacklistByItem = (await items.GetBlacklistByItemIdsAsync(itemIds, ct))
            .GroupBy(b => b.LibraryPathItemId)
            .ToDictionary(g => g.Key, g => g.First());

        var mediaIds = rows.Select(i => i.MediaItemId)
            .Where(id => id != null).Select(id => id!.Value).Distinct().ToList();
        var mediaById = (await mediaItems.GetByIdsAsync(mediaIds, ct)).ToDictionary(m => m.Id);
        var subInfoByItem = await subtitles.GetSubtitleInfoByItemIdsAsync(itemIds, ct);

        var result = new Dictionary<long, LibraryItemDto>();
        foreach (var item in rows)
        {
            var mediaItem = item.MediaItemId != null ? mediaById.GetValueOrDefault(item.MediaItemId.Value) : null;
            LibrarySubtitleInfoDto? subInfo = null;
            if (subInfoByItem.TryGetValue(item.Id, out var info))
            {
                subInfo = new LibrarySubtitleInfoDto(info.SubtitleId, info.Deleted,
                    info.Jobs.Select(j => new LibrarySubtitleJobDto(j.JobId, j.TargetLangId, j.LangName,
                        j.LangFlag, j.LangIso, j.Status.ToString().ToLowerInvariant())).ToList());
            }
            LibraryBlacklistDto? blacklist = null;
            if (blacklistByItem.TryGetValue(item.Id, out var bl))
            {
                blacklist = new LibraryBlacklistDto(bl.Id, bl.Reason, bl.CreatedAt);
            }
            result[item.Id] = new LibraryItemDto(
                item.Id, item.LibraryPathId, item.MediaItemId, SnakeCaseStatus(item.Status),
                item.Season, item.Episode, item.IsExtra, item.Path, item.ExtractFileName,
                candidatesByItem.TryGetValue(item.Id, out var cands)
                    ? cands.Select(c => new LibraryCandidateDto(c.LibraryPathItemId, c.MediaItemId, c.Title,
                        c.Year, c.PhotoPath, c.Type?.ToString().ToLowerInvariant())).ToList()
                    : [],
                mediaItem != null ? ToMediaItemDto(mediaItem) : null,
                subInfo, blacklist);
        }
        return result;
    }

    public static LibraryMediaItemDto ToMediaItemDto(MediaItem m) => new(
        m.Id, m.Type.ToString().ToLowerInvariant(), m.Title, m.OriginalTitle, m.Year,
        string.IsNullOrWhiteSpace(m.TheMovieDbId) ? null : m.TheMovieDbId, m.IsAnime,
        m.Genres.Count > 0 ? string.Join(",", m.Genres) : null, m.PhotoPath);

    // "Unmatched" definition: no media item, or one without a
    // TMDB id (a filename placeholder that never matched a real entry).
    public static bool IsMatched(LibraryItemDto item) =>
        item.MediaItem != null && !string.IsNullOrWhiteSpace(item.MediaItem.TheMovieDbId);

    /// <summary>
    /// <summary>
    /// All unmatched items collapse into one "Unmatched" bucket per path; matched
    /// groups follow alphabetically by title.
    /// </summary>
    /// </summary>
    private static List<LibraryGroupDto> GroupItems(List<LibraryItemDto> items)
    {
        var buckets = new List<(long? Key, List<LibraryItemDto> Items)>();
        var byKey = new Dictionary<object, List<LibraryItemDto>>();
        foreach (var item in items)
        {
            var key = IsMatched(item) ? item.MediaItemId : null;
            object box = (object?)key ?? "unmatched";
            if (!byKey.TryGetValue(box, out var bucket))
            {
                bucket = [];
                buckets.Add((key, bucket));
                byKey[box] = bucket;
            }
            bucket.Add(item);
        }

        var groups = buckets.Select(b =>
        {
            var sorted = b.Items.ToList();
            sorted.Sort((a, c) =>
            {
                if (a.Season != null && c.Season != null)
                {
                    if (a.Season != c.Season) return a.Season.Value.CompareTo(c.Season.Value);
                    return (a.Episode ?? 0).CompareTo(c.Episode ?? 0);
                }
                return string.Compare(a.Path, c.Path, StringComparison.CurrentCulture);
            });
            var isUnmatched = b.Key == null;
            return new LibraryGroupDto(
                isUnmatched ? null : b.Key,
                isUnmatched ? null : sorted[0]?.MediaItem,
                sorted);
        }).ToList();

        return groups
            .OrderBy(g => g.MediaItem == null || string.IsNullOrWhiteSpace(g.MediaItem.TheMovieDbId) ? 0 : 1)
            .ThenBy(g => g.MediaItem?.Title ?? "", StringComparer.CurrentCulture)
            .ToList();
    }

    /// <summary>snake_case status strings for the poll/JSON payloads.</summary>
    public static string SnakeCaseStatus(LibraryPathItemStatus status) => status switch
    {
        LibraryPathItemStatus.NotStarted => "not_started",
        LibraryPathItemStatus.Queued => "queued",
        LibraryPathItemStatus.NoSrtsFound => "no_srts_found",
        LibraryPathItemStatus.Completed => "completed",
        LibraryPathItemStatus.Failed => "failed",
        LibraryPathItemStatus.NoMediaItem => "no_media_item",
        _ => status.ToString().ToLowerInvariant(),
    };

    private async Task LogAsync(LogLevelKind level, string type, string entityType, long? entityId,
        string message, object? metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new ApplicationLog
            {
                Level = level,
                Type = type,
                EntityType = entityType,
                EntityId = entityId,
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