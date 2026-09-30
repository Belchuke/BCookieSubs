using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class RecommendedModel
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string? Size { get; set; }
    public string? ParameterSize { get; set; }
    public ModelProvider Provider { get; set; } = ModelProvider.Ollama;
    public string? BaseUrl { get; set; }

    /// <summary>Roles this model is recommended for.</summary>
    public List<ModelRoleKind> Roles { get; set; } = [];

    public bool RequireOllamaSubscription { get; set; }

    /// <summary>Human-readable recommendation blurb, e.g. "99% accurate · Slow".</summary>
    public string Score { get; set; } = "";

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}