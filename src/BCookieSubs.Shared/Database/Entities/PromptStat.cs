namespace BCookieSubs.Shared.Database.Entities;

public class PromptStat
{
    public long Id { get; set; }
    public long PromptId { get; set; }
    public Prompt Prompt { get; set; } = null!;
    public long PromptVersionId { get; set; }
    public PromptVersion PromptVersion { get; set; } = null!;
    public long ModelId { get; set; }
    public Model Model { get; set; } = null!;

    public long? LanguageId { get; set; }
    public Language? Language { get; set; }

    public int RequestCount { get; set; }
    public int FailedCount { get; set; }
    public int SuccessCount { get; set; }
    public int SelectedCount { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}