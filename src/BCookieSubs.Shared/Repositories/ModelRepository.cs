using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class ModelRepository(BCookieSubsDbContext db)
{
    public Task<List<Model>> GetAllAsync(CancellationToken ct = default) =>
        db.Models.AsNoTracking()
            .Include(m => m.ModelRoles)
            .Where(m => m.DeletedAt == null)
            .OrderBy(m => m.Name)
            .ToListAsync(ct);

    public Task<Model?> GetAsync(long id, CancellationToken ct = default) =>
        db.Models.Include(m => m.ModelRoles).FirstOrDefaultAsync(m => m.Id == id, ct);

    public Task<List<RecommendedModel>> GetRecommendedAsync(CancellationToken ct = default) =>
        db.RecommendedModels.AsNoTracking().OrderBy(m => m.Id).ToListAsync(ct);

    public Task<List<Model>> GetActiveByRoleAsync(ModelRoleKind role, CancellationToken ct = default) =>
        db.Models.AsNoTracking()
            .Where(m => m.DeletedAt == null && m.Active &&
                        m.ModelRoles.Any(r => r.Role == role && r.DeletedAt == null))
            .OrderBy(m => m.Name)
            .ToListAsync(ct);

    public Task<bool> IsNameTakenAsync(string modelName, long? excludeId = null, CancellationToken ct = default) =>
        db.Models.AnyAsync(m =>
            m.ModelName == modelName && m.DeletedAt == null && (excludeId == null || m.Id != excludeId), ct);

    public Task<Model?> FindAnyByIdentityAsync(string modelName, string? modelUpdatedAt, CancellationToken ct = default) =>
        db.Models.Include(m => m.ModelRoles).FirstOrDefaultAsync(m =>
            m.ModelName == modelName &&
            (m.ModelUpdatedAt == modelUpdatedAt || (m.ModelUpdatedAt == null && modelUpdatedAt == null)), ct);

    public Task<Model?> FindLiveByNameAsync(string name, long? excludeId = null, CancellationToken ct = default) =>
        db.Models.FirstOrDefaultAsync(m =>
            m.DeletedAt == null && m.Name == name && (excludeId == null || m.Id != excludeId), ct);

    public Task<bool> IsDisplayNameTakenAsync(string name, long? excludeId = null, CancellationToken ct = default) =>
        db.Models.AnyAsync(m =>
            m.Name == name && m.DeletedAt == null && (excludeId == null || m.Id != excludeId), ct);

    public Task<RecommendedModel?> GetRecommendedAsync(long id, CancellationToken ct = default) =>
        db.RecommendedModels.AsNoTracking().FirstOrDefaultAsync(r => r.Id == id, ct);

    public async Task<HashSet<string>> GetLiveModelNamesAsync(CancellationToken ct = default) =>
        (await db.Models.AsNoTracking()
            .Where(m => m.DeletedAt == null)
            .Select(m => m.ModelName)
            .ToListAsync(ct)).ToHashSet();

    public Task<List<ModelRole>> GetRolesForModelAsync(long modelId, CancellationToken ct = default) =>
        db.ModelRoles.Where(r => r.ModelId == modelId).ToListAsync(ct);

    public async Task ApplyRolesAsync(long modelId, IReadOnlySet<ModelRoleKind> wanted, CancellationToken ct = default)
    {
        var existing = await db.ModelRoles.Where(r => r.ModelId == modelId).ToListAsync(ct);
        var now = DateTime.UtcNow;

        foreach (var role in existing.Where(r => r.DeletedAt == null && !wanted.Contains(r.Role)))
        {
            role.DeletedAt = now;
        }

        foreach (var role in existing.Where(r => r.DeletedAt != null && wanted.Contains(r.Role)))
        {
            role.DeletedAt = null;
        }

        foreach (var role in wanted.Where(r => existing.All(e => e.Role != r)))
        {
            db.ModelRoles.Add(new ModelRole { ModelId = modelId, Role = role, CreatedAt = now });
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task AddAsync(Model model, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        model.CreatedAt = now;
        model.UpdatedAt = now;
        db.Models.Add(model);
        await db.SaveChangesAsync(ct);
    }

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);

    public async Task SoftDeleteAsync(Model model, CancellationToken ct = default)
    {
        model.DeletedAt = DateTime.UtcNow;
        model.Active = false;
        await db.SaveChangesAsync(ct);
    }
}