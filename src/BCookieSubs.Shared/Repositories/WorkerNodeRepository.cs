using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class WorkerNodeRepository(BCookieSubsDbContext db)
{
    public Task<List<WorkerNode>> GetAllAsync(CancellationToken ct = default) =>
        db.WorkerNodes.AsNoTracking().OrderBy(w => w.Name).ToListAsync(ct);

    public Task<WorkerNode?> GetAsync(long id, CancellationToken ct = default) =>
        db.WorkerNodes.FirstOrDefaultAsync(w => w.Id == id, ct);

    public Task<bool> NameExistsAsync(string name, CancellationToken ct = default) =>
        db.WorkerNodes.AnyAsync(w => w.Name == name, ct);

    public async Task AddAsync(WorkerNode node, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        node.CreatedAt = now;
        node.UpdatedAt = now;
        db.WorkerNodes.Add(node);
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateRegistrationAsync(WorkerNode node, CancellationToken ct = default)
    {
        node.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public Task SetEnabledAsync(long id, bool enabled, CancellationToken ct = default) =>
        db.WorkerNodes.Where(w => w.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(w => w.Enabled, enabled)
            .SetProperty(w => w.UpdatedAt, DateTime.UtcNow), ct);

    public Task SetDrainingAsync(long id, bool draining, CancellationToken ct = default) =>
        db.WorkerNodes.Where(w => w.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(w => w.Draining, draining)
            .SetProperty(w => w.UpdatedAt, DateTime.UtcNow), ct);

    public Task UpdateLastSeenAsync(long id, DateTime seen, CancellationToken ct = default) =>
        db.WorkerNodes.Where(w => w.Id == id)
            .ExecuteUpdateAsync(s => s.SetProperty(w => w.LastSeenAt, seen), ct);

    public Task SetLastConnectedAsync(long id, DateTime when, CancellationToken ct = default) =>
        db.WorkerNodes.Where(w => w.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(w => w.LastConnectedAt, when)
            .SetProperty(w => w.LastSeenAt, when)
            .SetProperty(w => w.UpdatedAt, DateTime.UtcNow), ct);

    public Task SetLastDisconnectedAsync(long id, DateTime when, CancellationToken ct = default) =>
        db.WorkerNodes.Where(w => w.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(w => w.LastDisconnectedAt, when)
            .SetProperty(w => w.LastSeenAt, when)
            .SetProperty(w => w.UpdatedAt, DateTime.UtcNow), ct);

    public async Task DeleteAsync(WorkerNode node, CancellationToken ct = default)
    {
        db.WorkerNodes.Remove(node);
        await db.SaveChangesAsync(ct);
    }

    public Task<Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction> BeginTransactionAsync(CancellationToken ct = default) =>
        db.Database.BeginTransactionAsync(ct);
}