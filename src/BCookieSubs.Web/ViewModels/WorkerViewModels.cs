using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Database.Entities;

namespace BCookieSubs.Web.ViewModels;

public class WorkersIndexViewModel
{
    public List<WorkerListItemViewModel> Workers { get; set; } = [];
    public List<EnrollmentItemViewModel> Enrollments { get; set; } = [];
    public string? NewEnrollmentToken { get; set; }
    public bool CanManage { get; set; }
}

public class WorkerListItemViewModel
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public WorkerEffectiveState EffectiveState { get; set; }
    public bool Enabled { get; set; }
    public bool Draining { get; set; }
    public bool Connected { get; set; }
    public DateTime? LastSeenAt { get; set; }
    public DateTime? ConnectedSince { get; set; }
    public string? WorkerVersion { get; set; }
    public string? OperatingSystem { get; set; }
    public string? Cpu { get; set; }
    public string? Ram { get; set; }
    public string? Gpu { get; set; }
    public string? Vram { get; set; }
    public List<string> ReportedCapabilities { get; set; } = [];
    public List<string> AllowedCapabilities { get; set; } = [];
    public int MaxConcurrency { get; set; }
    public int ActiveJobs { get; set; }
}

public class EnrollmentItemViewModel
{
    public long Id { get; set; }
    public string CodePrefix { get; set; } = "";
    public string? Label { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public string Status { get; set; } = "";
}

public class WorkerDetailsViewModel
{
    public WorkerListItemViewModel Summary { get; set; } = new();
    public WorkerHardwareInformation? Hardware { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public string? MachineIdentifier { get; set; }
    public bool CanManage { get; set; }
}

public static class Format
{
    public static string Bytes(long? bytes)
    {
        if (bytes is null or <= 0) return "—";
        return bytes switch
        {
            >= 1L << 40 => $"{(double)bytes / (1L << 40):0.#} TB",
            >= 1L << 30 => $"{(double)bytes / (1L << 30):0.#} GB",
            >= 1L << 20 => $"{(double)bytes / (1L << 20):0} MB",
            _ => $"{bytes} B"
        };
    }
}