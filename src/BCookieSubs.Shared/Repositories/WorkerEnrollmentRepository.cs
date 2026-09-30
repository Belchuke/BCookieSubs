using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class WorkerEnrollmentRepository(BCookieSubsDbContext db)
{
    public async Task AddAsync(WorkerEnrollment enrollment, CancellationToken ct = default)
    {
        db.WorkerEnrollments.Add(enrollment);
        await db.SaveChangesAsync(ct);
    }

    public Task<WorkerEnrollment?> GetByCodeHashAsync(string codeHash, CancellationToken ct = default) =>
        db.WorkerEnrollments.FirstOrDefaultAsync(e => e.CodeHash == codeHash, ct);

    public Task<List<WorkerEnrollment>> GetRecentAsync(CancellationToken ct = default) =>
        db.WorkerEnrollments.AsNoTracking()
            .OrderByDescending(e => e.CreatedAt)
            .Take(50)
            .ToListAsync(ct);

    public Task<int> MarkConsumedAsync(long id, long workerId, CancellationToken ct = default) =>
        db.WorkerEnrollments.Where(e => e.Id == id
                && e.ConsumedAt == null
                && e.RevokedAt == null
                && e.ExpiresAt > DateTime.UtcNow)
            .ExecuteUpdateAsync(s => s
                .SetProperty(e => e.ConsumedAt, DateTime.UtcNow)
                .SetProperty(e => e.ConsumedByWorkerId, workerId), ct);

    public Task<int> RevokeAsync(long id, CancellationToken ct = default) =>
        db.WorkerEnrollments.Where(e => e.Id == id && e.ConsumedAt == null && e.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(e => e.RevokedAt, DateTime.UtcNow), ct);
}