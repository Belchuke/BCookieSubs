namespace BCookieSubs.Shared.Database.Entities;

public class ExportedSubtitleFile
{
    public long Id { get; set; }

    public long LibraryPathId { get; set; }
    public LibraryPath LibraryPath { get; set; } = null!;

    public string Path { get; set; } = "";

    public long? SubtitleId { get; set; }
    public Subtitle? Subtitle { get; set; }

    public bool IsWhisper { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>Tracks that a library item already has a BCookieSubs-translated file on disk, per language.</summary>
public class TranslatedLibraryItem
{
    public long Id { get; set; }

    public long LibraryPathItemId { get; set; }
    public LibraryPathItem LibraryPathItem { get; set; } = null!;

    public long LanguageId { get; set; }
    public Language Language { get; set; } = null!;

    public string DetectedAtPath { get; set; } = "";
    public long? FileMtimeMs { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}