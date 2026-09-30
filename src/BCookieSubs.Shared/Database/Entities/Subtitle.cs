using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class Subtitle
{
    public long Id { get; set; }

    public long UserId { get; set; }
    public ApplicationUser User { get; set; } = null!;

    public long SourceLanguageId { get; set; }
    public Language SourceLanguage { get; set; } = null!;

    public long? MediaItemId { get; set; }
    public MediaItem? MediaItem { get; set; }

    public long? LibraryPathItemId { get; set; }
    public LibraryPathItem? LibraryPathItem { get; set; }

    public string Name { get; set; } = "";

    /// <summary>SHA-256 of the raw source file; dedupe key for re-uploads.</summary>
    public string OriginalFileHash { get; set; } = "";

    public string OriginalFileName { get; set; } = "";

    /// <summary>Entire source subtitle file text; the translation input.</summary>
    public string OriginalText { get; set; } = "";

    public SubtitleFormat SourceFormat { get; set; } = SubtitleFormat.Srt;

    public SubtitleTextOrigin? TextOrigin { get; set; }
    public OriginalSubtitleFormat? OriginalSourceFormat { get; set; }

    /// <summary>Translation-queue order; lower runs first. Sparse values (gaps of 10) allow insertion.</summary>
    public int Priority { get; set; }
    public int? WhisperPriority { get; set; }

    public bool Hide { get; set; }

    public SubtitleSourceKind? Source { get; set; }
    public string? SourcePath { get; set; }
    public string? MediaPath { get; set; }

    public SubtitleStatus Status { get; set; } = SubtitleStatus.Queued;

    public WhisperTranscriptionState? WhisperTranscriptionState { get; set; }

    // Whisper configuration snapshot taken when the workflow was created.
    public string? WhisperModel { get; set; }
    public int? WhisperTimestampsLength { get; set; }
    public bool? WhisperUseCuda { get; set; }

    public int? Season { get; set; }
    public int? Episode { get; set; }

    public int WhisperProgress { get; set; }
    public long WhisperPositionMs { get; set; }
    public long WhisperDurationMs { get; set; }

    /// <summary>Transcribed-so-far SRT checkpoint used to resume interrupted transcriptions.</summary>
    public string? WhisperResumeSrt { get; set; }
    public long WhisperResumeMs { get; set; }

    public DateTime? FinishedAt { get; set; }
    public DateTime? CancelledAt { get; set; }
    public long? CancelledByUserId { get; set; }
    public ApplicationUser? CancelledByUser { get; set; }

    public DateTime? DeletedAt { get; set; }
    public long? DeletedByUserId { get; set; }
    public ApplicationUser? DeletedByUser { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class SubtitleJob
{
    public long Id { get; set; }

    public long SubtitleId { get; set; }
    public Subtitle Subtitle { get; set; } = null!;

    public long UserId { get; set; }
    public ApplicationUser User { get; set; } = null!;

    public long TargetLanguageId { get; set; }
    public Language TargetLanguage { get; set; } = null!;

    public int ChunkSetting { get; set; } = 10;

    public int TotalChunks { get; set; }
    public int CurrentChunk { get; set; }

    public int? Season { get; set; }
    public int? Episode { get; set; }

    public SubtitleJobStatus Status { get; set; } = SubtitleJobStatus.Queued;

    public int Priority { get; set; }

    public string? TranslatedText { get; set; }
    public string? OutputFilePath { get; set; }
    public string? OutputHash { get; set; }

    public DateTime? FinishedAt { get; set; }
    public DateTime? CancelledAt { get; set; }
    public long? CancelledByUserId { get; set; }
    public ApplicationUser? CancelledByUser { get; set; }

    public DateTime? DeletedAt { get; set; }
    public long? DeletedByUserId { get; set; }
    public ApplicationUser? DeletedByUser { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}