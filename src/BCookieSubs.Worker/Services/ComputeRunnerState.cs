namespace BCookieSubs.Worker.Services;

public class ComputeRunnerState
{
    private readonly object _gate = new();
    private bool _whisperPaused;
    private bool _ocrPaused;

    public bool WhisperPaused { get { lock (_gate) return _whisperPaused; } }
    public bool OcrPaused { get { lock (_gate) return _ocrPaused; } }

    public bool SetPaused(bool whisper, bool paused, out bool changed)
    {
        lock (_gate)
        {
            changed = whisper ? _whisperPaused != paused : _ocrPaused != paused;
            if (whisper) _whisperPaused = paused;
            else _ocrPaused = paused;
        }
        return changed;
    }
}