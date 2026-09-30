namespace BCookieSubs.Shared.Database.Entities;

public class Language
{
    public long Id { get; set; }
    public string Name { get; set; } = "";

    /// <summary>ISO 639-1 code, e.g. "en".</summary>
    public string Iso639 { get; set; } = "";

    /// <summary>ISO 639-2/B code, e.g. "eng"; absent for some languages.</summary>
    public string? Iso6392B { get; set; }

    /// <summary>UI locale, e.g. "en-US".</summary>
    public string Locale { get; set; } = "";

    public string? Flag { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}