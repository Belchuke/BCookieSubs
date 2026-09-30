using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public class WorkerNodeService(WorkerNodeRepository nodes, WorkerCredentialRepository credentials)
{
    public Task<List<WorkerNode>> GetAllAsync(CancellationToken ct = default) => nodes.GetAllAsync(ct);

    public Task<WorkerNode?> GetAsync(long id, CancellationToken ct = default) => nodes.GetAsync(id, ct);

    public Task SetEnabledAsync(long id, bool enabled, CancellationToken ct = default) =>
        nodes.SetEnabledAsync(id, enabled, ct);

    public Task SetDrainingAsync(long id, bool draining, CancellationToken ct = default) =>
        nodes.SetDrainingAsync(id, draining, ct);

    public async Task UpdateAllowedCapabilitiesAsync(long id, IReadOnlyList<string> allowed, CancellationToken ct = default)
    {
        var node = await nodes.GetAsync(id, ct) ?? throw new InvalidOperationException($"Worker {id} not found");
        node.AllowedCapabilities = allowed.Where(c => CapabilityNames.All.Contains(c)).Distinct().ToList();
        await nodes.UpdateRegistrationAsync(node, ct);
    }

    public async Task<bool> RemoveAsync(long id, CancellationToken ct = default)
    {
        var node = await nodes.GetAsync(id, ct);
        if (node is null)
        {
            return false;
        }

        await credentials.RevokeAllForWorkerAsync(id, ct);
        await nodes.DeleteAsync(node, ct);
        return true;
    }
}