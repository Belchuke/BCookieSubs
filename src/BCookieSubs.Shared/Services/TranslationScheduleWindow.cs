using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public record ScheduleWindowDecision(
    bool ShouldRun,
    Schedule? SelectedSchedule,
    bool ScheduleConfigured,
    string? Reason);

public static class TranslationScheduleWindow
{
    public static async Task<ScheduleWindowDecision> GetShouldRunNowAsync(
        ScheduleRepository schedules, long? currentScheduleId, CancellationToken ct = default)
    {
        var enabled = await schedules.GetEnabledAsync(ct);
        if (enabled.Count == 0)
        {
            return new ScheduleWindowDecision(true, null, false, null);
        }

        var now = DateTime.UtcNow;

        if (currentScheduleId != null)
        {
            var sticky = enabled.FirstOrDefault(s => s.Id == currentScheduleId.Value);
            if (sticky != null && IsWindowActive(sticky, now))
            {
                await schedules.UpdateLastRunAsync(sticky.Id, now, ct);
                return new ScheduleWindowDecision(true, sticky, true, null);
            }
        }

        var active = enabled.Where(s => IsWindowActive(s, now)).ToList();
        if (active.Count == 0)
        {
            return new ScheduleWindowDecision(false, null, true, null);
        }

        var winner = active.Where(s => s.DayOfTheWeek == now.DayOfWeek)
            .OrderBy(s => s.StartTime)
            .FirstOrDefault()
            ?? active.OrderBy(s => s.StartTime).First();

        await schedules.UpdateLastRunAsync(winner.Id, now, ct);
        return new ScheduleWindowDecision(true, winner, true, null);
    }

    public static bool IsWindowActive(Schedule schedule, DateTime now)
    {
        var candidate = now.Date;
        while (candidate.DayOfWeek != schedule.DayOfTheWeek)
        {
            candidate = candidate.AddDays(-1);
        }

        if (schedule.RepeatUnit != Database.Enums.RepeatUnit.Day && schedule.RepeatInterval > 1)
        {
            var anchor = schedule.FirstStartAt?.Date ?? candidate;
            if (!IsOnInterval(candidate, anchor, schedule.RepeatUnit, schedule.RepeatInterval))
            {
                return false;
            }
        }

        var start = candidate.Add(schedule.StartTime);
        var end = start.AddMinutes(schedule.DurationMinutes);
        return now >= start && now < end;
    }

    private static bool IsOnInterval(DateTime candidate, DateTime anchor, Database.Enums.RepeatUnit unit, int interval)
    {
        var diff = unit switch
        {
            Database.Enums.RepeatUnit.Week => (int)((candidate - anchor).TotalDays / 7),
            Database.Enums.RepeatUnit.Month =>
                (candidate.Year - anchor.Year) * 12 + candidate.Month - anchor.Month,
            _ => (int)(candidate - anchor).TotalDays,
        };
        return diff >= 0 && diff % interval == 0;
    }
}