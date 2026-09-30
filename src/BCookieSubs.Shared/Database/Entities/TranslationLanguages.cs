namespace BCookieSubs.Shared.Database.Entities;

public class ConfigTranslationLanguage
{
    public long Id { get; set; }
    public long LanguageId { get; set; }
    public Language Language { get; set; } = null!;

    public int Position { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class UserConfigTranslationLanguage
{
    public long Id { get; set; }
    public long UserId { get; set; }
    public ApplicationUser User { get; set; } = null!;

    public long LanguageId { get; set; }
    public Language Language { get; set; } = null!;

    public int Position { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}