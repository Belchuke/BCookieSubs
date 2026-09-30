using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Seeding;

public static class RecommendedModelSeedData
{
    public sealed record Row(
        string Name, ModelProvider Provider, string? BaseUrl,
        IReadOnlyList<ModelRoleKind> Roles, bool RequireOllamaSubscription, string Score);

    private static readonly ModelRoleKind[] All = [ModelRoleKind.Translation, ModelRoleKind.Judge, ModelRoleKind.NameFormatter];

    public static readonly IReadOnlyList<Row> Rows =
    [
        new("gemma4:31b", ModelProvider.Ollama, null, All, false, "99% accurate · Slow · Handles profanity"),
        new("gemma4:26b", ModelProvider.Ollama, null, All, false, "85% accurate · Medium · Handles profanity"),
        new("granite4.1:3b", ModelProvider.Ollama, null, [ModelRoleKind.NameFormatter], false, "Name detection only · Fast"),
        new("gemma4:31b-cloud", ModelProvider.OllamaCloud, "https://ollama.com", All, true, "99% accurate · Very Fast · Handles profanity"),
    ];
}