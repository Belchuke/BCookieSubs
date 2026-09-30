using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class LibraryPath
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public bool Enabled { get; set; } = true;

    /// <summary>Filesystem root this path scans; the remote root for SFTP paths.</summary>
    public string Path { get; set; } = "";

    // SFTP connection settings; credentials live encrypted in app_secrets,
    // keyed sftp:<id>:password / :privateKey / :keyPassphrase.
    public LibraryStorageKind Storage { get; set; } = LibraryStorageKind.Local;
    public string? SftpHost { get; set; }
    public int SftpPort { get; set; } = 22;
    public string? SftpUsername { get; set; }
    public LibrarySftpAuthMode SftpAuthMode { get; set; } = LibrarySftpAuthMode.Password;

    /// <summary>Pinned SSH host-key fingerprint (SHA256:...); empty means untrusted.</summary>
    public string? SftpHostKeyFingerprint { get; set; }

    public bool AutoTranslate { get; set; }
    public bool AutoExtract { get; set; }

    public long SourceLanguageId { get; set; }
    public Language SourceLanguage { get; set; } = null!;

    /// <summary>Last scan completion; NULL also means "due for initial scan".</summary>
    public DateTime? LastRunAt { get; set; }
    public LibraryPathState State { get; set; } = LibraryPathState.Idle;
    public LibraryPathType Type { get; set; }
    public bool InitialScanCompleted { get; set; }

    public ScanMode ScanMode { get; set; } = ScanMode.Hourly;
    public int ScanRepeatInterval { get; set; } = 1;
    public RepeatUnit ScanRepeatUnit { get; set; } = RepeatUnit.Day;
    public DayOfWeek ScanDayOfWeek { get; set; } = DayOfWeek.Sunday;
    public TimeSpan ScanStartTime { get; set; }
    public int ScanDurationMinutes { get; set; } = 60;

    /// <summary>Anchor for custom-mode interval recurrence.</summary>
    public DateTime? ScanFirstStartAt { get; set; }

    // Scan performance statistics.
    public long? InitialScanDurationMs { get; set; }
    public int PostInitialScanCount { get; set; }
    public long PostInitialScanTotalMs { get; set; }
    public long? LastScanDurationMs { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}