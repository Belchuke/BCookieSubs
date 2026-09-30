namespace BCookieSubs.Shared.Database.Enums;

public enum MediaKind
{
    Movie,
    Series,
    Unknown
}

public enum LibraryPathType
{
    Movie,
    Series
}

public enum LibraryStorageKind
{
    Local,
    Sftp
}

public enum LibrarySftpAuthMode
{
    Password,
    PrivateKey
}

public enum LibraryPathState
{
    Idle,
    Scanning,
    Error
}

public enum ScanMode
{
    Hourly,
    Custom,
    Never
}

public enum RepeatUnit
{
    Day,
    Week,
    Month
}

public enum LibraryPathItemStatus
{
    NotStarted,
    Queued,
    NoSrtsFound,
    Completed,
    Failed,
    NoMediaItem
}