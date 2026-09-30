using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class Schedule
{
    public long Id { get; set; }

    public string TaskName { get; set; } = "";
    public bool Enabled { get; set; }

    public DayOfWeek DayOfTheWeek { get; set; }

    /// <summary>UTC wall-clock window start.</summary>
    public TimeSpan StartTime { get; set; }
    public int DurationMinutes { get; set; } = 60;

    public RepeatUnit RepeatUnit { get; set; } = RepeatUnit.Week;
    public int RepeatInterval { get; set; } = 1;

    public DateTime? LastRunAt { get; set; }

    /// <summary>Anchor for interval-based recurrence.</summary>
    public DateTime? FirstStartAt { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}