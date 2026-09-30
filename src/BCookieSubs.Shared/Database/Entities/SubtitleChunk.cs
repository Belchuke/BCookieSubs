using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class SubtitleChunk
{
    public long Id { get; set; }

    public long SubtitleId { get; set; }
    public Subtitle Subtitle { get; set; } = null!;

    public long SubtitleJobId { get; set; }
    public SubtitleJob SubtitleJob { get; set; } = null!;

    public long TargetLanguageId { get; set; }
    public Language TargetLanguage { get; set; } = null!;

    public int ChunkIndex { get; set; }

    public int SrtIdFrom { get; set; }
    public int SrtIdTo { get; set; }

    public SubtitleChunkStatus Status { get; set; } = SubtitleChunkStatus.Queued;

    public long? JudgeModelId { get; set; }
    public Model? JudgeModel { get; set; }

    public string? JudgeReason { get; set; }

    public long? SelectedCandidateId { get; set; }
    public SubtitleChunkCandidate? SelectedCandidate { get; set; }

    public long? DurationMs { get; set; }
    public int RetryCount { get; set; }
    public string? ErrorMessage { get; set; }

    public DateTime? StartedAt { get; set; }
    public DateTime? FinishedAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class SubtitleChunkCandidate
{
    public long Id { get; set; }

    public long SubtitleChunkId { get; set; }
    public SubtitleChunk SubtitleChunk { get; set; } = null!;

    public long? ModelId { get; set; }
    public Model? Model { get; set; }

    public long? PromptId { get; set; }
    public Prompt? Prompt { get; set; }

    public long? PromptVersionId { get; set; }
    public PromptVersion? PromptVersion { get; set; }

    public string? TranslatedText { get; set; }

    public SubtitleChunkCandidateStatus Status { get; set; } = SubtitleChunkCandidateStatus.Queued;

    public bool? ValidationPassed { get; set; }
    public bool Selected { get; set; }
    public int RetryCount { get; set; }
    public long? DurationMs { get; set; }
    public string? ErrorMessage { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}