namespace BCookieSubs.Shared.Database.Entities;

public class ApplicationConfig
{
    public const int SingletonId = 1;

    public long Id { get; set; }

    public int DefaultChunkSize { get; set; } = 12;
    public int MaxRetriesPerChunk { get; set; } = 5;
    public bool FinishSingleSubtitleFirst { get; set; } = true;
    public bool DeleteNotCancel { get; set; }

    public bool ShowPosters { get; set; }
    public bool NameDetectionActive { get; set; }
    public bool TheMovieDbActive { get; set; }
    public bool ScanLibraryPaths { get; set; }
    public string? RootLibraryPath { get; set; }

    public bool ScheduleConfigured { get; set; }

    public bool ClearLogs { get; set; }
    public int ClearLogsOlderThanDays { get; set; } = 30;

    public long? SelectedThemeId { get; set; }
    public Theme? SelectedTheme { get; set; }

    public string DefaultLanguage { get; set; } = "en";
    public string ThaiAssFont { get; set; } = "Garuda";
    public int SessionTimeoutMinutes { get; set; } = 400;

    public string WhisperModel { get; set; } = "large-v3-turbo";
    public int WhisperTimestampsLength { get; set; } = 60;
    public bool WhisperUseCuda { get; set; }
    public bool WhisperEnabled { get; set; } = true;
    public bool WhisperRunAsSeparateTask { get; set; }
    public string? WhisperModelRootPath { get; set; }

    public bool LogRetentionEnabled { get; set; }
    public int LogRetentionDays { get; set; } = 30;

    public bool SetupCompleted { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }

    public uint Version { get; set; }
}