using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class Prompt
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public PromptKind Kind { get; set; } = PromptKind.Translation;
    public bool Active { get; set; } = true;

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class PromptVersion
{
    public long Id { get; set; }
    public long PromptId { get; set; }
    public Prompt Prompt { get; set; } = null!;

    public int Version { get; set; }

    public string PromptText { get; set; } = "";

    public bool Active { get; set; } = true;

    public DateTime? DeletedAt { get; set; }
    public DateTime CreatedAt { get; set; }
}