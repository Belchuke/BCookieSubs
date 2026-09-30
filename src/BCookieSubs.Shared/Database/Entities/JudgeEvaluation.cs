namespace BCookieSubs.Shared.Database.Entities;

public class JudgeEvaluation
{
    public long Id { get; set; }
    public long SubtitleChunkId { get; set; }
    public SubtitleChunk SubtitleChunk { get; set; } = null!;

    public long? ModelId { get; set; }
    public Model? Model { get; set; }

    public string? JudgeInput { get; set; }
    public string? JudgeReason { get; set; }

    public long? SelectedCandidateId { get; set; }
    public SubtitleChunkCandidate? SelectedCandidate { get; set; }

    public DateTime CreatedAt { get; set; }
}