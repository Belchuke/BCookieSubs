using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class WorkerJobRepository(BCookieSubsDbContext db)
{
    public Task<WorkerJob?> GetAsync(long id, CancellationToken ct = default) =>
        db.WorkerJobs.FirstOrDefaultAsync(j => j.Id == id, ct);

    public Task<List<WorkerJob>> GetBySubjectAsync(string subjectType, long subjectId, CancellationToken ct = default) =>
        db.WorkerJobs.AsNoTracking()
            .Where(j => j.SubjectType == subjectType && j.SubjectId == subjectId)
            .OrderBy(j => j.CreatedAt)
            .ToListAsync(ct);

    public Task<WorkerJob?> GetNextQueuedAsync(string jobType, CancellationToken ct = default) =>
        db.WorkerJobs.AsNoTracking()
            .Where(j => j.Status == WorkerJobStatus.Queued && j.JobType == jobType)
            .OrderBy(j => j.Priority).ThenBy(j => j.CreatedAt)
            .FirstOrDefaultAsync(ct);

    public Task<bool> HasActiveForSubjectAsync(string subjectType, long subjectId, string jobType, CancellationToken ct = default) =>
        db.WorkerJobs.AsNoTracking().AnyAsync(j =>
            j.SubjectType == subjectType && j.SubjectId == subjectId &&
            j.JobType == jobType &&
            (j.Status == WorkerJobStatus.Queued || j.Status == WorkerJobStatus.Running), ct);

    public Task DeleteAsync(long id, CancellationToken ct = default) =>
        db.WorkerJobs.Where(j => j.Id == id).ExecuteDeleteAsync(ct);

    public Task<List<WorkerJob>> GetActiveAsync(CancellationToken ct = default) =>
        db.WorkerJobs.AsNoTracking()
            .Where(j => j.Status == WorkerJobStatus.Queued || j.Status == WorkerJobStatus.Running)
            .OrderBy(j => j.Priority).ThenBy(j => j.CreatedAt)
            .ToListAsync(ct);

    public async Task AddAsync(WorkerJob job, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        job.CreatedAt = now;
        job.UpdatedAt = now;
        db.WorkerJobs.Add(job);
        await db.SaveChangesAsync(ct);
    }

    public async Task<WorkerJob?> ClaimNextAsync(
        string jobType, string? requiredCapability, long workerId, TimeSpan lease, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;

        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var job = await db.WorkerJobs.FromSql($"""
            SELECT * FROM worker_jobs
            WHERE "Status" = 'Queued'
              AND "JobType" = {jobType}
              AND ({requiredCapability}::text IS NULL OR "RequiredCapability" = {requiredCapability})
              AND ("NextRetryAt" IS NULL OR "NextRetryAt" <= {now})
            ORDER BY "Priority", "CreatedAt"
            FOR UPDATE SKIP LOCKED
            LIMIT 1
            """).FirstOrDefaultAsync(ct);
        if (job is null)
        {
            return null;
        }

        var leaseEnds = now + lease;
        job.Status = WorkerJobStatus.Running;
        job.ClaimedByWorkerId = workerId;
        job.ClaimedAt = now;
        job.HeartbeatAt = now;
        job.LeaseExpiresAt = leaseEnds;
        job.StartedAt ??= now;
        job.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return job;
    }

    public Task UpdateHeartbeatAsync(long id, long workerId, TimeSpan lease, CancellationToken ct = default) =>
        db.WorkerJobs.Where(j => j.Id == id && j.ClaimedByWorkerId == workerId && j.Status == WorkerJobStatus.Running)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.HeartbeatAt, DateTime.UtcNow)
                .SetProperty(j => j.LeaseExpiresAt, DateTime.UtcNow + lease)
                .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);

    public Task UpdateProgressAsync(long id, long workerId, int progress, CancellationToken ct = default) =>
        db.WorkerJobs.Where(j => j.Id == id && j.ClaimedByWorkerId == workerId && j.Status == WorkerJobStatus.Running)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Progress, progress)
                .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);

    public async Task<bool> DeleteClaimedByWorkerAsync(long id, long workerId, CancellationToken ct = default)
    {
        var rows = await db.WorkerJobs
            .Where(j => j.Id == id && j.ClaimedByWorkerId == workerId)
            .ExecuteDeleteAsync(ct);
        return rows != 0;
    }

    public Task CompleteAsync(long id, string? result, CancellationToken ct = default) =>
        db.WorkerJobs.Where(j => j.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(j => j.Status, WorkerJobStatus.Completed)
            .SetProperty(j => j.Result, result)
            .SetProperty(j => j.Progress, 100)
            .SetProperty(j => j.FinishedAt, DateTime.UtcNow)
            .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);

    public Task FailAsync(long id, string? errorCode, string? errorMessage, CancellationToken ct = default) =>
        db.WorkerJobs.Where(j => j.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(j => j.Status, WorkerJobStatus.Failed)
            .SetProperty(j => j.ErrorCode, errorCode)
            .SetProperty(j => j.ErrorMessage, errorMessage)
            .SetProperty(j => j.FinishedAt, DateTime.UtcNow)
            .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);

    public Task<int> ReleaseExpiredLeasesAsync(DateTime cutoff, CancellationToken ct = default) =>
        db.WorkerJobs
            .Where(j => j.Status == WorkerJobStatus.Running && j.LeaseExpiresAt != null && j.LeaseExpiresAt < cutoff)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Status, j => j.RetryCount + 1 > j.MaxRetries
                    ? WorkerJobStatus.Failed
                    : WorkerJobStatus.Queued)
                .SetProperty(j => j.RetryCount, j => j.RetryCount + 1)
                .SetProperty(j => j.ClaimedByWorkerId, (long?)null)
                .SetProperty(j => j.ClaimedAt, (DateTime?)null)
                .SetProperty(j => j.HeartbeatAt, (DateTime?)null)
                .SetProperty(j => j.LeaseExpiresAt, (DateTime?)null)
                .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);

    public Task RequeueAsync(long id, CancellationToken ct = default) =>
        db.WorkerJobs
            .Where(j => j.Id == id && j.Status == WorkerJobStatus.Running)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Status, WorkerJobStatus.Queued)
                .SetProperty(j => j.ClaimedByWorkerId, (long?)null)
                .SetProperty(j => j.ClaimedAt, (DateTime?)null)
                .SetProperty(j => j.HeartbeatAt, (DateTime?)null)
                .SetProperty(j => j.LeaseExpiresAt, (DateTime?)null)
                .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);

    public Task RequeueUntilAsync(long id, DateTime nextRetryAt, CancellationToken ct = default) =>
        db.WorkerJobs
            .Where(j => j.Id == id && j.Status == WorkerJobStatus.Running)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Status, WorkerJobStatus.Queued)
                .SetProperty(j => j.ClaimedByWorkerId, (long?)null)
                .SetProperty(j => j.ClaimedAt, (DateTime?)null)
                .SetProperty(j => j.HeartbeatAt, (DateTime?)null)
                .SetProperty(j => j.LeaseExpiresAt, (DateTime?)null)
                .SetProperty(j => j.NextRetryAt, nextRetryAt)
                .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);


    public sealed record OcrDashboardRow(
        long Id, long LibraryPathItemId, string? Name, WorkerJobStatus Status, int Progress,
        string? ErrorMessage, int Priority, DateTime CreatedAt, DateTime? StartedAt,
        long? MediaItemId, string? MediaItemTitle, string? MediaItemPhotoPath, string? MediaItemType,
        int? Season, int? Episode);

    public Task<List<OcrDashboardRow>> GetOcrDashboardRowsAsync(CancellationToken ct = default) =>
        (from j in db.WorkerJobs.AsNoTracking().Where(j => j.JobType == WorkerJobTypes.Ocr)
         join i in db.LibraryPathItems.AsNoTracking() on j.SubjectId equals i.Id into items
         from i in items.DefaultIfEmpty()
         join m in db.MediaItems.AsNoTracking() on i.MediaItemId equals m.Id into media
         from m in media.DefaultIfEmpty()
         orderby j.Status == WorkerJobStatus.Running ? 0 : 1, j.Priority, j.Id
         select new OcrDashboardRow(
             j.Id, j.SubjectId!.Value, j.DisplayName, j.Status, j.Progress,
             j.ErrorMessage, j.Priority, j.CreatedAt, j.StartedAt,
             (long?)m!.Id, m!.Title, m.PhotoPath, m.Type.ToString(),
             (int?)i!.Season, (int?)i.Episode))
            .ToListAsync(ct);

    public async Task<OcrDashboardRow?> GetOcrDashboardRowAsync(long id, CancellationToken ct = default)
    {
        var rows = await GetOcrDashboardRowsAsync(ct);
        return rows.FirstOrDefault(r => r.Id == id);
    }

    public Task<List<WorkerJob>> GetQueuedOcrJobsAsync(CancellationToken ct = default) =>
        db.WorkerJobs.AsNoTracking()
            .Where(j => j.JobType == WorkerJobTypes.Ocr && j.Status == WorkerJobStatus.Queued)
            .OrderBy(j => j.Priority).ThenBy(j => j.Id)
            .ToListAsync(ct);

    public async Task SetOcrPrioritiesAsync(
        IReadOnlyCollection<(long Id, int Priority)> updates, CancellationToken ct = default)
    {
        if (updates.Count == 0) return;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        foreach (var (id, priority) in updates.OrderBy(u => u.Id))
            await db.WorkerJobs.Where(j => j.Id == id)
                .ExecuteUpdateAsync(s => s.SetProperty(j => j.Priority, priority), ct);
        await tx.CommitAsync(ct);
    }

    public Task ResetOcrForRetryAsync(long id, CancellationToken ct = default) =>
        db.WorkerJobs
            .Where(j => j.Id == id && j.Status == WorkerJobStatus.Failed)
            .ExecuteUpdateAsync(s => s
                .SetProperty(j => j.Status, WorkerJobStatus.Queued)
                .SetProperty(j => j.ErrorMessage, (string?)null)
                .SetProperty(j => j.ErrorCode, (string?)null)
                .SetProperty(j => j.Progress, 0)
                .SetProperty(j => j.FinishedAt, (DateTime?)null)
                .SetProperty(j => j.NextRetryAt, (DateTime?)null)
                .SetProperty(j => j.UpdatedAt, DateTime.UtcNow), ct);
}