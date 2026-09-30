using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public record PromptListItem(long Id, string Name, PromptKind Kind, bool Active, int? ActiveVersion, DateTime UpdatedAt);

public record PromptVersionItem(long Id, int Version, string PromptText, bool Active, DateTime CreatedAt);

public record PromptDetail(
    long Id, string Name, PromptKind Kind, bool Active,
    List<PromptVersionItem> Versions, PromptVersionItem? ActiveVersion,
    List<PromptRepository.PromptStatRow> Stats);

public class PromptService(PromptRepository prompts, AuditService audit)
{
    public const string AnimePlaceholder = "//isAnime//";

    public Task<List<Prompt>> GetListAsync(CancellationToken ct = default) => prompts.GetAllAsync(ct);

    public async Task<List<PromptListItem>> GetListWithVersionsAsync(CancellationToken ct = default)
    {
        var all = await prompts.GetAllAsync(ct);
        var items = new List<PromptListItem>();
        foreach (var prompt in all)
        {
            var active = await prompts.GetActiveVersionAsync(prompt.Id, ct);
            items.Add(new PromptListItem(prompt.Id, prompt.Name, prompt.Kind, prompt.Active,
                active?.Version, prompt.UpdatedAt));
        }

        return items.OrderBy(i => i.Kind).ThenBy(i => i.Name).ToList();
    }

    public async Task<PromptDetail?> GetDetailAsync(long promptId, CancellationToken ct = default)
    {
        var prompt = await prompts.GetNoTrackingAsync(promptId, ct);
        if (prompt is null)
        {
            return null;
        }

        var versions = (await prompts.GetVersionsAsync(promptId, ct))
            .Select(v => new PromptVersionItem(v.Id, v.Version, v.PromptText, v.Active, v.CreatedAt))
            .ToList();
        var active = versions.FirstOrDefault(v => v.Active);
        return new PromptDetail(prompt.Id, prompt.Name, prompt.Kind, prompt.Active, versions, active,
            await prompts.GetStatsAsync(promptId, ct));
    }

    public async Task<List<PromptVersionItem>> GetVersionsAsync(long promptId, CancellationToken ct = default) =>
        (await prompts.GetVersionsAsync(promptId, ct))
            .Select(v => new PromptVersionItem(v.Id, v.Version, v.PromptText, v.Active, v.CreatedAt))
            .ToList();

    public async Task<(bool Ok, string? Error, List<string>? Warnings)> CreateAsync(
        long actorId, string name, string text, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return (false, "Prompt name is required", null);
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            return (false, "Prompt text is required", null);
        }

        if (await prompts.GetByNameAsync(name.Trim(), ct) is not null)
        {
            return (false, "Prompt with the same name already exists", null);
        }

        var prompt = new Prompt { Name = name.Trim(), Kind = PromptKind.Translation, Active = true };
        var version = new PromptVersion { Prompt = prompt, Version = 1, PromptText = text.Trim(), Active = true };
        await prompts.AddAsync(prompt, version, ct);

        var warnings = ValidatePlaceholders(PromptKind.Translation, version.PromptText);
        await audit.AdminActionAsync("promptCreated", "prompt", prompt.Id,
            $"Created prompt {prompt.Name} (version 1)");
        return (true, null, warnings);
    }

    public async Task<(bool Ok, string? Error, List<string>? Warnings)> AddVersionAsync(
        long actorId, long promptId, string text, int? version, CancellationToken ct = default)
    {
        var prompt = await prompts.GetTrackedAsync(promptId, ct);
        if (prompt is null)
        {
            return (false, "Prompt not found", null);
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            return (false, "Prompt text is required", null);
        }

        var targetVersion = version ?? await prompts.GetMaxVersionAsync(promptId, ct) + 1;
        if (targetVersion < 1)
        {
            return (false, "Version must be a positive number", null);
        }

        if (await prompts.GetVersionAsync(promptId, targetVersion, ct) is not null)
        {
            return (false, "Prompt version already exists for this prompt", null);
        }

        await DeactivateActiveVersionsAsync(promptId, ct);

        var created = new PromptVersion { PromptId = promptId, Version = targetVersion, PromptText = text.Trim(), Active = true };
        await prompts.AddVersionAsync(created, ct);
        prompt.UpdatedAt = DateTime.UtcNow;
        await prompts.SaveAsync(ct);

        var warnings = ValidatePlaceholders(prompt.Kind, created.PromptText);
        await audit.AdminActionAsync("promptVersionAdded", "prompt", promptId,
            $"Added version {targetVersion} to prompt {prompt.Name}");
        return (true, null, warnings);
    }

    public async Task<(bool Ok, string? Error)> SetActiveVersionAsync(
        long actorId, long promptId, long versionId, CancellationToken ct = default)
    {
        var prompt = await prompts.GetTrackedAsync(promptId, ct);
        if (prompt is null)
        {
            return (false, "Prompt not found");
        }

        var version = await prompts.GetVersionByIdAsync(promptId, versionId, ct);
        if (version is null || version.DeletedAt is not null)
        {
            return (false, "Prompt version not found");
        }

        if (!version.Active)
        {
            await DeactivateActiveVersionsAsync(promptId, ct);
            version.Active = true;
            prompt.UpdatedAt = DateTime.UtcNow;
            await prompts.SaveAsync(ct);
            await audit.AdminActionAsync("promptVersionActivated", "prompt", promptId,
                $"Set version {version.Version} active for prompt {prompt.Name}");
        }

        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> ToggleActiveAsync(
        long actorId, long promptId, CancellationToken ct = default)
    {
        var prompt = await prompts.GetTrackedAsync(promptId, ct);
        if (prompt is null)
        {
            return (false, "Prompt not found");
        }

        prompt.Active = !prompt.Active;
        prompt.UpdatedAt = DateTime.UtcNow;
        await prompts.SaveAsync(ct);
        await audit.AdminActionAsync(prompt.Active ? "promptActivated" : "promptDeactivated", "prompt", promptId,
            $"{(prompt.Active ? "Activated" : "Deactivated")} prompt {prompt.Name}");
        return (true, null);
    }

    public static List<string> ValidatePlaceholders(PromptKind kind, string text)
    {
        var required = kind switch
        {
            PromptKind.Translation => (IEnumerable<string>)["//targetLang//"],
            PromptKind.Judge => ["//sourceText//", "//candidateList//", "//total//", "//totalMinusOne//"],
            PromptKind.NameFormatter => ["//filename//"],
            _ => Array.Empty<string>()
        };

        return required
            .Where(p => !text.Contains(p, StringComparison.Ordinal))
            .Select(p => $"Missing required placeholder {p}")
            .ToList();
    }

    private async Task DeactivateActiveVersionsAsync(long promptId, CancellationToken ct)
    {
        var active = await prompts.GetActiveVersionsTrackedAsync(promptId, ct);
        foreach (var version in active)
        {
            version.Active = false;
        }
    }
}