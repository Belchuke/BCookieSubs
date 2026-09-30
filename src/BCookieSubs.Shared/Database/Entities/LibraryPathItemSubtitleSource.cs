namespace BCookieSubs.Shared.Database.Entities;

public class LibraryPathItemSubtitleSource
{
    public long LibraryPathItemId { get; set; }
    public LibraryPathItem LibraryPathItem { get; set; } = null!;

    public List<SubtitleSourceCandidate> Sources { get; set; } = [];

    public long FileMtimeMs { get; set; }
    public long FileSize { get; set; }
    public DateTime ScannedAt { get; set; }
}

public class SubtitleSourceCandidate
{
    public string Type { get; set; } = "";
    public string Path { get; set; } = "";
    public bool IsTemp { get; set; }
    public string? Label { get; set; }
    public string? Language { get; set; }
    public string? Codec { get; set; }
    public string? Filename { get; set; }
    public string? FilenameOnly { get; set; }
    public bool? ImageBased { get; set; }
    public bool? RequiresOcr { get; set; }
    public string? OcrLang { get; set; }
    public int? TrackId { get; set; }
    public string? Title { get; set; }
    public bool? Unsupported { get; set; }

    /// <summary>"vobsub", "pgs" or "text".</summary>
    public string? SubKind { get; set; }
    public int? NumIndexEntries { get; set; }
    public int? PictureCount { get; set; }
}