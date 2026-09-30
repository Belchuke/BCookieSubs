using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class Model
{
    public long Id { get; set; }

    public string Name { get; set; } = "";

    /// <summary>Provider model identifier, e.g. "gemma4:31b".</summary>
    public string ModelName { get; set; } = "";

    public string? Size { get; set; }
    public string? ParameterSize { get; set; }

    /// <summary>Provider-reported last-modified stamp; part of the uniqueness key.</summary>
    public string? ModelUpdatedAt { get; set; }

    public bool CloseAfterUse { get; set; } = true;
    public bool Active { get; set; } = true;
    public ModelProvider Provider { get; set; } = ModelProvider.Ollama;
    public string? BaseUrl { get; set; }

    public long? RecommendedModelId { get; set; }
    public RecommendedModel? RecommendedModel { get; set; }

    public List<ModelRole> ModelRoles { get; set; } = [];

    public DateTime? DeletedAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}