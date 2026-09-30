namespace BCookieSubs.Shared.Database.Entities;

public class WorkerNode
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string? MachineIdentifier { get; set; }

    /// <summary>Disabled workers keep their registration but can never receive work.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Draining workers stay connected but receive no new tasks.</summary>
    public bool Draining { get; set; }

    public string? WorkerVersion { get; set; }
    public List<string> ReportedCapabilities { get; set; } = [];
    public List<string> AllowedCapabilities { get; set; } = [];
    public WorkerHardwareInformation? Hardware { get; set; }
    public int MaxConcurrency { get; set; } = 1;

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
    public DateTime? LastSeenAt { get; set; }
    public DateTime? LastConnectedAt { get; set; }
    public DateTime? LastDisconnectedAt { get; set; }
}

/// <summary>Best-effort hardware facts as reported by the worker; optional fields may be absent.</summary>
public class WorkerHardwareInformation
{
    public string? OperatingSystem { get; set; }
    public string? Architecture { get; set; }
    public string? CpuModel { get; set; }
    public int CpuCores { get; set; }
    public long RamBytes { get; set; }
    public string? GpuVendor { get; set; }
    public string? GpuModel { get; set; }
    public long? GpuVramBytes { get; set; }
    public bool CudaAvailable { get; set; }
    public string? PythonVersion { get; set; }
}