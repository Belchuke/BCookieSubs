using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services;

namespace BCookieSubs.Web.Services;

public static class DashboardPayloads
{
    public static object Log(ApplicationLog l) => new
    {
        l.Id, l.CreatedAt, Level = l.Level.ToString(), l.Type, l.EntityType, l.EntityId, l.Message,
    };

    public static object OcrJob(WorkerJobRepository.OcrDashboardRow o) => new
    {
        o.Id,
        Name = o.Name ?? "",
        Status = o.Status == WorkerJobStatus.Running ? "processing" : o.Status.ToString().ToLowerInvariant(),
        o.Progress,
        o.ErrorMessage,
        o.Priority,
        o.CreatedAt,
        o.MediaItemId,
        MediaItemTitle = o.MediaItemTitle ?? "",
        o.MediaItemPhotoPath,
        o.MediaItemType,
        o.Season,
        o.Episode,
    };

    public static object QueueCounts(SubtitleRepository.DashboardQueueCounts c) => new
    {
        c.Queued, c.Running, c.Completed, c.Failed, c.Cancelled, c.Paused, c.Total,
    };

    public static object RequestCounts(LibraryRequestCounts c) => new
    {
        c.Movie, c.Series, c.Unmatched,
    };
}