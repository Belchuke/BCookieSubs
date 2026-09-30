using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Services;

public static class LibraryScanSchedule
{
    public const int HourlyIntervalMinutes = 60;
    public static readonly TimeSpan StuckScanThreshold = TimeSpan.FromMinutes(10);

    public record Recurrence(
        int RepeatInterval,
        RepeatUnit RepeatUnit,
        int JsDayOfTheWeek,
        int StartTimeHour,
        int StartTimeMinute,
        int DurationMinutes,
        DateTime? FirstStartAt,
        DateTime? LastRunAt);

    public static int JsDayOfWeek(DayOfWeek day) => ((int)day + 6) % 7;

    public static Recurrence FromLibraryPath(LibraryPath lp) => new(
        lp.ScanRepeatInterval,
        lp.ScanRepeatUnit,
        JsDayOfWeek(lp.ScanDayOfWeek),
        lp.ScanStartTime.Hours,
        lp.ScanStartTime.Minutes,
        lp.ScanDurationMinutes,
        lp.ScanFirstStartAt,
        lp.LastRunAt);

    public static (bool Active, DateTime? OccurrenceStart) EvaluateRecurrence(Recurrence f, DateTime nowUtc)
    {
        var currentTotalMinutes = nowUtc.Hour * 60 + nowUtc.Minute;

        var today = JsDayOfWeek(nowUtc.DayOfWeek);
        var yesterday = today == 0 ? 6 : today - 1;

        var treatAsYesterday = f.RepeatUnit != RepeatUnit.Day && f.JsDayOfTheWeek == yesterday;

        if (f.RepeatUnit != RepeatUnit.Day &&
            f.JsDayOfTheWeek != today && f.JsDayOfTheWeek != yesterday)
        {
            return (false, null);
        }

        var startMinutes = f.StartTimeHour * 60 + f.StartTimeMinute;
        var endMinutes = startMinutes + f.DurationMinutes;

        var target = treatAsYesterday ? nowUtc.Date.AddDays(-1) : nowUtc.Date;
        var occurrenceStart = target.AddHours(f.StartTimeHour).AddMinutes(f.StartTimeMinute);

        bool inWindow;
        if (endMinutes <= 1440)
        {
            inWindow = !treatAsYesterday && currentTotalMinutes >= startMinutes && currentTotalMinutes < endMinutes;
        }
        else
        {
            var overflowEnd = endMinutes - 1440;
            inWindow = treatAsYesterday
                ? currentTotalMinutes < overflowEnd
                : currentTotalMinutes >= startMinutes;
        }
        if (!inWindow) return (false, occurrenceStart);

        if (f.FirstStartAt is not { } anchor) return (false, occurrenceStart);

        bool intervalOk;
        if (f.LastRunAt is { } lastRun && IsSameUtcDay(lastRun, target))
        {
            intervalOk = true;
        }
        else if (f.RepeatUnit == RepeatUnit.Day)
        {
            var diffDays = (int)(target.Date - anchor.Date).TotalDays;
            intervalOk = diffDays >= 0 && diffDays % f.RepeatInterval == 0;
        }
        else if (f.RepeatUnit == RepeatUnit.Week)
        {
            var diffDays = (int)(target.Date - anchor.Date).TotalDays;
            var diffWeeks = Math.Floor((double)diffDays / 7);
            intervalOk = diffWeeks >= 0 && (int)diffWeeks % f.RepeatInterval == 0;
        }
        else
        {
            var diffMonths = (target.Year - anchor.Year) * 12 + (target.Month - anchor.Month);
            intervalOk = diffMonths >= 0 && diffMonths % f.RepeatInterval == 0;
        }
        return (intervalOk, occurrenceStart);
    }

    private static bool IsSameUtcDay(DateTime a, DateTime b) =>
        a.Date == b.Date;

    public static bool IsDue(LibraryPath lp, DateTime nowUtc)
    {
        if (lp.LastRunAt == null) return true;

        if (lp.ScanMode == ScanMode.Hourly)
        {
            return nowUtc - lp.LastRunAt.Value >= TimeSpan.FromMinutes(HourlyIntervalMinutes);
        }

        if (lp.ScanMode == ScanMode.Custom)
        {
            var (active, occurrenceStart) = EvaluateRecurrence(FromLibraryPath(lp), nowUtc);
            return active && occurrenceStart != null && lp.LastRunAt.Value < occurrenceStart.Value;
        }

        return false;
    }
}