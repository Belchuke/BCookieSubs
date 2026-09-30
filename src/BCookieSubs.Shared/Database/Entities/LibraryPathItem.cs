using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class LibraryPathItem
{
    public long Id { get; set; }
    public long LibraryPathId { get; set; }
    public LibraryPath LibraryPath { get; set; } = null!;

    public long? MediaItemId { get; set; }
    public MediaItem? MediaItem { get; set; }

    public LibraryPathItemStatus Status { get; set; } = LibraryPathItemStatus.NotStarted;

    public int? Season { get; set; }
    public int? Episode { get; set; }

    public bool IsExtra { get; set; }

    public string Path { get; set; } = "";

    /// <summary>Filename used when exporting translated subtitles back to the library.</summary>
    public string ExtractFileName { get; set; } = "";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}