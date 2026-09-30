using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;

namespace BCookieSubs.Shared.Services;

public class ScheduleService(
    ScheduleRepository schedules,
    PermissionService permissions,
    ApplicationLogRepository logs)
{
    public Task<List<Schedule>> GetAllAsync(CancellationToken ct = default) =>
        schedules.GetAllAsync(ct);

    public async Task<SubtitleTaskResult> CreateAsync(
        long userId, string taskName, bool enabled, DayOfWeek dayOfTheWeek,
        int startHour, int startMinute, int durationMinutes, RepeatUnit repeatUnit,
        int repeatInterval, DateTime? firstStartAt, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanManageSchedules, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage schedules");

        var schedule = new Schedule
        {
            TaskName = taskName,
            Enabled = enabled,
            DayOfTheWeek = dayOfTheWeek,
            StartTime = new TimeSpan(startHour, startMinute, 0),
            DurationMinutes = durationMinutes,
            RepeatUnit = repeatUnit,
            RepeatInterval = repeatInterval,
            FirstStartAt = firstStartAt,
        };
        await schedules.AddAsync(schedule, ct);
        await LogAsync("scheduleCreate", null, "Created new schedule", new { taskName }, ct);
        return new SubtitleTaskResult(true, null, schedule.Id);
    }

    public async Task<SubtitleTaskResult> UpdateAsync(
        long userId, long scheduleId, string taskName, bool enabled, DayOfWeek dayOfTheWeek,
        int startHour, int startMinute, int durationMinutes, RepeatUnit repeatUnit,
        int repeatInterval, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanManageSchedules, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage schedules");

        var schedule = await schedules.GetAsync(scheduleId, ct);
        if (schedule == null) return new SubtitleTaskResult(false, "Schedule not found");

        schedule.TaskName = taskName;
        schedule.Enabled = enabled;
        schedule.DayOfTheWeek = dayOfTheWeek;
        schedule.StartTime = new TimeSpan(startHour, startMinute, 0);
        schedule.DurationMinutes = durationMinutes;
        schedule.RepeatUnit = repeatUnit;
        schedule.RepeatInterval = repeatInterval;
        await schedules.UpdateAsync(schedule, ct);
        await LogAsync("scheduleUpdate", scheduleId, "Updated schedule", new { taskName }, ct);
        return new SubtitleTaskResult(true, null);
    }

    public async Task<SubtitleTaskResult> DeleteAsync(long userId, long scheduleId, CancellationToken ct = default)
    {
        if (!await HasPermissionAsync(userId, Permissions.CanManageSchedules, ct))
            return new SubtitleTaskResult(false, "User does not have permission to manage schedules");

        var schedule = await schedules.GetAsync(scheduleId, ct);
        if (schedule == null) return new SubtitleTaskResult(false, "Schedule not found");

        await schedules.DeleteAsync(schedule, ct);
        await LogAsync("scheduleDelete", null, "Deleted schedule", new { scheduleId }, ct);
        return new SubtitleTaskResult(true, null);
    }

    private async Task<bool> HasPermissionAsync(long userId, string permission, CancellationToken ct) =>
        (await permissions.GetEffectivePermissionsAsync(userId, ct)).Contains(permission);

    private async Task LogAsync(string type, long? entityId, string message, object metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new ApplicationLog
            {
                Level = LogLevelKind.Info,
                Type = type,
                EntityType = "schedule",
                EntityId = entityId,
                Message = message,
                Metadata = System.Text.Json.JsonSerializer.Serialize(metadata),
            }, ct);
        }
        catch
        {
        }
    }
}