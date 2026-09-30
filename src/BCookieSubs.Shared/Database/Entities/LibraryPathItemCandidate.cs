namespace BCookieSubs.Shared.Database.Entities;

public class LibraryPathItemCandidate
{
    public long Id { get; set; }
    public long LibraryPathItemId { get; set; }
    public LibraryPathItem LibraryPathItem { get; set; } = null!;

    public string Path { get; set; } = "";

    public long MediaItemId { get; set; }
    public MediaItem MediaItem { get; set; } = null!;

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}