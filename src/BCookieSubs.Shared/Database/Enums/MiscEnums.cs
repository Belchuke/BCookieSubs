namespace BCookieSubs.Shared.Database.Enums;

public enum LogLevelKind
{
    Debug,
    Info,
    Warning,
    Error
}

public enum WorkerJobStatus
{
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled
}