using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class ScheduleRepository(BCookieSubsDbContext db)
{
    public Task<List<Schedule>> GetAllAsync(CancellationToken ct = default) =>
        db.Schedules.AsNoTracking().OrderBy(s => s.TaskName).ToListAsync(ct);

    public Task<List<Schedule>> GetEnabledAsync(CancellationToken ct = default) =>
        db.Schedules.AsNoTracking().Where(s => s.Enabled).ToListAsync(ct);

    public Task<Schedule?> GetAsync(long id, CancellationToken ct = default) =>
        db.Schedules.FirstOrDefaultAsync(s => s.Id == id, ct);

    public async Task AddAsync(Schedule schedule, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        schedule.CreatedAt = now;
        schedule.UpdatedAt = now;
        db.Schedules.Add(schedule);
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateAsync(Schedule schedule, CancellationToken ct = default)
    {
        schedule.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public Task SetEnabledAsync(long id, bool enabled, CancellationToken ct = default) =>
        db.Schedules.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.Enabled, enabled)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public Task UpdateLastRunAsync(long id, DateTime lastRunAt, CancellationToken ct = default) =>
        db.Schedules.Where(s => s.Id == id).ExecuteUpdateAsync(s => s
            .SetProperty(x => x.LastRunAt, lastRunAt)
            .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);

    public async Task DeleteAsync(Schedule schedule, CancellationToken ct = default)
    {
        db.Schedules.Remove(schedule);
        await db.SaveChangesAsync(ct);
    }
}