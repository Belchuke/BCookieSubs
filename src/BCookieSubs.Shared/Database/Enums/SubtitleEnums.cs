namespace BCookieSubs.Shared.Database.Enums;

public enum SubtitleFormat
{
    Srt,
    Ass,
    Ssa
}

public enum SubtitleTextOrigin
{
    Ocr,
    Parsed
}

public enum SubtitleSourceKind
{
    Upload,
    Library,
    Whisper
}

public enum OriginalSubtitleFormat
{
    Sub,
    Sup
}

public enum WhisperTranscriptionState
{
    QueuedForTranscription,
    Transcribing,
    TranscriptionFailed,
    TranscriptionCompleted,
    QueuedForTranslation,
    Translating
}

public enum SubtitleStatus
{
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Paused
}

public enum SubtitleJobStatus
{
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Paused
}

public enum SubtitleChunkStatus
{
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Retrying,
    WaitingForJudge
}

public enum SubtitleChunkCandidateStatus
{
    Queued,
    Running,
    Completed,
    Failed,
    ValidationFailed
}