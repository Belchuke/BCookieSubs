using System.Globalization;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize]
[Route("schedules")]
public class SchedulesController(ScheduleService schedules, CurrentUserContext currentUser) : Controller
{
    [HttpGet]
    [Authorize(Policy = Policies.Prefix + Permissions.CanViewSchedules)]
    public async Task<IActionResult> Index()
    {
        var all = await schedules.GetAllAsync();
        ViewBag.Schedules = all.OrderBy(s => s.CreatedAt).ToList();
        return View();
    }

    [HttpPost("add")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanManageSchedules)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Add(
        string? taskName, string? enabled, string? dayOfTheWeek, string? startTimeHour,
        string? startTimeMinute, string? durationMinutes, string? repeatUnit,
        string? repeatInterval, string? firstStartAt)
    {
        var result = await schedules.CreateAsync(
            currentUser.Id, taskName ?? "translation", enabled == "1" || enabled == "on",
            ParseDay(dayOfTheWeek), ParseInt(startTimeHour), ParseInt(startTimeMinute, 0),
            ParsePositive(durationMinutes, 60), ParseUnit(repeatUnit),
            ParsePositive(repeatInterval, 1), ParseDate(firstStartAt));
        if (!result.Success)
            return Back("error", result.Msg ?? "Failed to create schedule");
        return Back("success", "Schedule created");
    }

    [HttpPost("update/{id:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanManageSchedules)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Update(long id,
        string? taskName, string? enabled, string? dayOfTheWeek, string? startTimeHour,
        string? startTimeMinute, string? durationMinutes, string? repeatUnit, string? repeatInterval)
    {
        var result = await schedules.UpdateAsync(
            currentUser.Id, id, taskName ?? "translation", enabled == "1" || enabled == "on",
            ParseDay(dayOfTheWeek), ParseInt(startTimeHour), ParseInt(startTimeMinute, 0),
            ParsePositive(durationMinutes, 60), ParseUnit(repeatUnit), ParsePositive(repeatInterval, 1));
        if (!result.Success)
            return Back("error", result.Msg ?? "Failed to update schedule");
        return Back("success", "Schedule updated");
    }

    [HttpPost("delete/{id:long}")]
    [Authorize(Policy = Policies.Prefix + Permissions.CanManageSchedules)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(long id)
    {
        var result = await schedules.DeleteAsync(currentUser.Id, id);
        if (!result.Success)
            return Back("error", result.Msg ?? "Failed to delete schedule");
        return Back("success", "Schedule deleted");
    }

    private static int ParseInt(string? value, int fallback = 0) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : fallback;

    private static int ParsePositive(string? value, int fallback) =>
        Math.Max(1, ParseInt(value, fallback));

    private static DayOfWeek ParseDay(string? value) =>
        int.TryParse(value, out var n) && n is >= 0 and <= 6 ? (DayOfWeek)n : DayOfWeek.Sunday;

    private static RepeatUnit ParseUnit(string? value) =>
        value switch
        {
            "day" => RepeatUnit.Day,
            "month" => RepeatUnit.Month,
            _ => RepeatUnit.Week,
        };

    private static DateTime? ParseDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var d))
        {
            return DateTime.SpecifyKind(d.ToDateTime(TimeOnly.MinValue), DateTimeKind.Utc);
        }
        return null;
    }

    private IActionResult Back(string toast, string msg) =>
        RedirectToAction("Index", new { toast, msg });
}