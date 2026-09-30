using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class MediaItem
{
    public long Id { get; set; }
    public MediaKind Type { get; set; } = MediaKind.Unknown;
    public string Title { get; set; } = "";
    public string? OriginalTitle { get; set; }
    public int? Year { get; set; }

    /// <summary>TMDB identifier as text (TMDB ids are stable numbers; kept as string for future id types).</summary>
    public string? TheMovieDbId { get; set; }

    /// <summary>Tri-state: null until TMDB matching determines it.</summary>
    public bool? IsAnime { get; set; }

    /// <summary>Genre names from TMDB, e.g. ["Action", "Drama"].</summary>
    public List<string> Genres { get; set; } = [];

    /// <summary>Bare poster filename served from the media photos directory.</summary>
    public string? PhotoPath { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}