namespace BCookieSubs.Shared.Services.Media;

public static class ExtractTemp
{
    public static string Dir { get; } =
        Path.Combine(Path.GetTempPath(), $"bcookiesubs-extract-{Environment.ProcessId}");

    private static int _counter;

    public static bool EnsureDir()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            return true;
        }
        catch (IOException)
        {
            return false;
        }
    }

    public static string MakePath(string stem, string tag, string ext = ".srt")
    {
        var counter = Interlocked.Increment(ref _counter);
        var safeStem = MkvToolNixService.SanitizeStem(stem);
        var safeExt = ext.StartsWith('.') ? ext : $".{ext}";
        return Path.Combine(Dir, $"{safeStem}.{tag}.{Environment.ProcessId}-{counter}{safeExt}");
    }

    public static void SafeDeleteTempExtract(string filePath)
    {
        if (!filePath.StartsWith(Dir, StringComparison.Ordinal)) return;
        try
        {
            if (File.Exists(filePath)) File.Delete(filePath);
            var idxSibling = Path.ChangeExtension(filePath, ".idx");
            if (File.Exists(idxSibling)) File.Delete(idxSibling);
        }
        catch (IOException)
        {
        }
    }
}