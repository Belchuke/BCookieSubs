using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class WorkerCredentialRepository(BCookieSubsDbContext db)
{
    public async Task AddAsync(WorkerCredential credential, CancellationToken ct = default)
    {
        credential.CreatedAt = DateTime.UtcNow;
        db.WorkerCredentials.Add(credential);
        await db.SaveChangesAsync(ct);
    }

    public Task<WorkerCredential?> GetActiveBySecretHashAsync(string secretHash, CancellationToken ct = default) =>
        db.WorkerCredentials.FirstOrDefaultAsync(
            c => c.SecretHash == secretHash && c.RevokedAt == null, ct);

    public Task RevokeAllForWorkerAsync(long workerId, CancellationToken ct = default) =>
        db.WorkerCredentials.Where(c => c.WorkerId == workerId && c.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(c => c.RevokedAt, DateTime.UtcNow), ct);
}