using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services.Media;

namespace BCookieSubs.Shared.Services;

public record MediaItemCreateResult(bool Success, string Msg, MediaItem? MediaItem);

public class MediaItemService(
    MediaItemRepository mediaItems,
    PermissionService permissions,
    MediaPhotosService photos)
{
    public const string AddFromLibraryPermission = "canAddSubtitleToTranslateFromLibrary";

    public async Task<MediaItemCreateResult> CreateAsync(
        long? actingUserId,
        string title,
        string? originalTitle,
        MediaKind type,
        int? year,
        bool isAnime,
        string? genres,
        string? theMovieDbId = null,
        string? posterUrl = null,
        string? localPosterPath = null,
        CancellationToken ct = default)
    {
        if (actingUserId is { } userId)
        {
            var perms = await permissions.GetEffectivePermissionsAsync(userId, ct);
            if (!perms.Contains(AddFromLibraryPermission))
            {
                return new MediaItemCreateResult(false, "Permission denied", null);
            }
        }

        var existing = await mediaItems.GetByKeysAsync(theMovieDbId, title, type, year, ct);
        if (existing != null)
        {
            if (!string.IsNullOrWhiteSpace(theMovieDbId) && string.IsNullOrWhiteSpace(existing.TheMovieDbId))
            {
                existing.TheMovieDbId = theMovieDbId;
                if (string.IsNullOrEmpty(existing.OriginalTitle)) existing.OriginalTitle = originalTitle;
                existing.Year ??= year;
                existing.IsAnime = isAnime;
                if (existing.Genres.Count == 0) existing.Genres = ParseGenres(genres);
            }

            if (string.IsNullOrWhiteSpace(existing.PhotoPath))
            {
                var uniqueId = !string.IsNullOrWhiteSpace(theMovieDbId) ? $"tmdb_{theMovieDbId}" : $"media_{existing.Id}";
                var photoPath = localPosterPath != null ? photos.CopyLocalPoster(localPosterPath, uniqueId) : null;
                photoPath ??= posterUrl != null ? await photos.DownloadPosterAsync(posterUrl, uniqueId, ct) : null;
                if (photoPath != null) existing.PhotoPath = photoPath;
            }

            await mediaItems.SaveAsync(ct);
            return new MediaItemCreateResult(true, "Media item already exists", existing);
        }

        var newUniqueId = !string.IsNullOrWhiteSpace(theMovieDbId) ? $"tmdb_{theMovieDbId}" : $"media_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        var newPhotoPath = localPosterPath != null ? photos.CopyLocalPoster(localPosterPath, newUniqueId) : null;
        newPhotoPath ??= posterUrl != null ? await photos.DownloadPosterAsync(posterUrl, newUniqueId, ct) : null;

        var now = DateTime.UtcNow;
        var item = new MediaItem
        {
            Title = title,
            OriginalTitle = originalTitle,
            Type = type,
            Year = year,
            IsAnime = isAnime,
            Genres = ParseGenres(genres),
            TheMovieDbId = theMovieDbId,
            PhotoPath = newPhotoPath,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await mediaItems.AddAsync(item, ct);
        return new MediaItemCreateResult(true, "Media item created successfully", item);
    }

    private static List<string> ParseGenres(string? genres) =>
        string.IsNullOrWhiteSpace(genres)
            ? []
            : genres.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .ToList();
}