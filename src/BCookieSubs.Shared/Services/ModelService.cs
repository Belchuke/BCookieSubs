using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public record OllamaCatalogEntry(
    string Name, string? Size, string? ParameterSize, string? ModifiedAt, bool AlreadyAdded);

public record OllamaCatalogResult(
    bool Success, bool OllamaRunning, List<OllamaCatalogEntry> Entries, string? Error);

public record RecommendedCatalogEntry(
    long Id, string Name, string? Size, string? ParameterSize, ModelProvider Provider,
    string? BaseUrl, IReadOnlyList<ModelRoleKind> Roles, string Score, bool RequireSubscription);

public class ModelService(ModelRepository models, OllamaService ollama, AuditService audit)
{
    public Task<List<Model>> GetListAsync(CancellationToken ct = default) => models.GetAllAsync(ct);

    public Task<Model?> GetAsync(long id, CancellationToken ct = default) => models.GetAsync(id, ct);

    public Task<List<RecommendedModel>> GetRecommendedAsync(CancellationToken ct = default) =>
        models.GetRecommendedAsync(ct);

    public async Task<List<RecommendedCatalogEntry>> GetUninstalledRecommendedAsync(CancellationToken ct = default)
    {
        var recommended = await models.GetRecommendedAsync(ct);
        var live = await models.GetLiveModelNamesAsync(ct);
        var liveIds = (await models.GetAllAsync(ct)).Where(m => m.RecommendedModelId.HasValue)
            .Select(m => m.RecommendedModelId!.Value)
            .ToHashSet();

        return recommended
            .Where(r => !live.Contains(r.Name) && !liveIds.Contains(r.Id))
            .Select(r => new RecommendedCatalogEntry(
                r.Id, r.Name, r.Size, r.ParameterSize, r.Provider, r.BaseUrl, r.Roles, r.Score,
                r.RequireOllamaSubscription))
            .ToList();
    }

    public async Task<OllamaCatalogResult> GetOllamaCatalogAsync(CancellationToken ct = default)
    {
        var result = await ollama.ListModelsAsync(ct);
        if (!result.Success)
        {
            return new OllamaCatalogResult(false, result.OllamaRunning, [], result.Error);
        }

        var liveNames = await models.GetLiveModelNamesAsync(ct);
        var entries = result.Models
            .Select(m => new OllamaCatalogEntry(m.Name, m.Size, m.ParameterSize, m.ModifiedAt, liveNames.Contains(m.Name)))
            .ToList();
        return new OllamaCatalogResult(true, true, entries, null);
    }

    public async Task<(bool Ok, string? Error, bool Restored)> AddAsync(
        long actorId, string name, string modelName, ModelProvider provider, string? baseUrl,
        bool closeAfterUse, IReadOnlyList<ModelRoleKind> roles, bool active = true,
        string? size = null, string? parameterSize = null, string? modelUpdatedAt = null,
        long? recommendedModelId = null, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(modelName))
        {
            return (false, "Display name and model name are required", false);
        }

        if (!Enum.IsDefined(provider))
        {
            return (false, "Unknown provider", false);
        }

        if (await models.IsDisplayNameTakenAsync(name.Trim(), ct: ct))
        {
            return (false, $"Model with name \"{name.Trim()}\" already exists", false);
        }

        var identical = await models.FindAnyByIdentityAsync(modelName.Trim(), modelUpdatedAt, ct);
        if (identical is not null && identical.DeletedAt is null)
        {
            return (false, $"Model with name {name.Trim()} already exists with identical Ollama details", false);
        }

        if (identical is not null)
        {
            identical.DeletedAt = null;
            identical.Active = active;
            identical.Name = name.Trim();
            identical.Size = size;
            identical.ParameterSize = parameterSize;
            identical.Provider = provider;
            identical.BaseUrl = baseUrl;
            identical.CloseAfterUse = closeAfterUse;
            identical.RecommendedModelId = recommendedModelId ?? identical.RecommendedModelId;
            identical.UpdatedAt = DateTime.UtcNow;
            await models.SaveAsync(ct);
            await models.ApplyRolesAsync(identical.Id, roles.ToHashSet(), ct);

            await audit.AdminActionAsync("modelRestored", "model", identical.Id,
                $"Restored model {identical.Name} ({identical.ModelName})");
            return (true, null, true);
        }

        var model = new Model
        {
            Name = name.Trim(),
            ModelName = modelName.Trim(),
            Size = size,
            ParameterSize = parameterSize,
            ModelUpdatedAt = modelUpdatedAt,
            Provider = provider,
            BaseUrl = baseUrl,
            CloseAfterUse = closeAfterUse,
            Active = active,
            RecommendedModelId = recommendedModelId
        };
        await models.AddAsync(model, ct);
        await models.ApplyRolesAsync(model.Id, roles.ToHashSet(), ct);

        await audit.AdminActionAsync("modelAdded", "model", model.Id, $"Added model {model.Name} ({model.ModelName})");
        return (true, null, false);
    }

    public async Task<(bool Ok, string? Error, bool Restored)> AddRecommendedAsync(
        long actorId, long recommendedModelId, CancellationToken ct = default)
    {
        var rec = await models.GetRecommendedAsync(recommendedModelId, ct);
        if (rec is null)
        {
            return (false, "Recommended model not found", false);
        }

        if (rec.Provider == ModelProvider.Ollama)
        {
            var catalog = await ollama.ListModelsAsync(ct);
            if (!catalog.Success || catalog.Models.All(m => m.Name != rec.Name))
            {
                return (false, $"{rec.Name} is not installed. Use + Add and the pull flow.", false);
            }
        }

        var roles = rec.Roles.Count > 0 ? rec.Roles : [ModelRoleKind.Translation];
        return await AddAsync(actorId, rec.Name, rec.Name, rec.Provider, rec.BaseUrl,
            closeAfterUse: true, roles, size: rec.Size, parameterSize: rec.ParameterSize,
            recommendedModelId: rec.Id, ct: ct);
    }

    public async Task<(bool Ok, string? Error)> UpdateAsync(
        long actorId, long modelId, string name, bool closeAfterUse, bool active,
        ModelProvider provider, string? baseUrl, CancellationToken ct = default)
    {
        var model = await models.GetAsync(modelId, ct);
        if (model is null || model.DeletedAt is not null)
        {
            return (false, "Model not found");
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            return (false, "Display name is required");
        }

        if (await models.IsDisplayNameTakenAsync(name.Trim(), model.Id, ct))
        {
            return (false, $"Model with name {name.Trim()} already exists");
        }

        if (!Enum.IsDefined(provider))
        {
            return (false, "Unknown provider");
        }

        model.Name = name.Trim();
        model.CloseAfterUse = closeAfterUse;
        model.Active = active;
        model.Provider = provider;
        model.BaseUrl = baseUrl;
        model.UpdatedAt = DateTime.UtcNow;
        await models.SaveAsync(ct);

        await audit.AdminActionAsync("modelUpdated", "model", model.Id, $"Updated model {model.Name}");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> SetRolesAsync(
        long actorId, long modelId, IReadOnlyList<ModelRoleKind> roles, CancellationToken ct = default)
    {
        var model = await models.GetAsync(modelId, ct);
        if (model is null || model.DeletedAt is not null)
        {
            return (false, "Model not found");
        }

        await models.ApplyRolesAsync(model.Id, roles.ToHashSet(), ct);
        await audit.AdminActionAsync("modelRolesChanged", "model", model.Id,
            $"Set roles for {model.Name}: {(roles.Count > 0 ? string.Join(", ", roles) : "none")}");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> SoftDeleteAsync(long actorId, long modelId, CancellationToken ct = default)
    {
        var model = await models.GetAsync(modelId, ct);
        if (model is null || model.DeletedAt is not null)
        {
            return (false, "Model not found");
        }

        await models.SoftDeleteAsync(model, ct);
        await models.ApplyRolesAsync(model.Id, new HashSet<ModelRoleKind>(), ct);
        await audit.AdminActionAsync("modelDeleted", "model", model.Id, $"Deleted model {model.Name}");
        return (true, null);
    }
}