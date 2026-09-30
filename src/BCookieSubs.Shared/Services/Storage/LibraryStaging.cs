namespace BCookieSubs.Shared.Services.Storage;

public static class LibraryStaging
{
    private static readonly string _dir =
        Environment.GetEnvironmentVariable("BCOOKIESUBS_STAGING_DIR") is { Length: > 0 } v
            ? v : "/work/staging";

    private static readonly string _workRoot =
        Path.GetDirectoryName(_dir) is { Length: > 0 } parent ? parent : "/work";

    public static string Dir => _dir;

    public static string ScanDir(long libraryPathId) => Path.Combine(_dir, "scan", libraryPathId.ToString());

    public static string WhisperDir(long jobId) => Path.Combine(_workRoot, "whisper", jobId.ToString());

    public static void SafeDeleteFile(string? path)
    {
        if (path == null || !IsInsideStage(path)) return;
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException)
        {
        }
    }

    public static void SafeDeleteDir(string dir)
    {
        if (!IsInsideStage(dir)) return;
        try
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private static bool IsInsideStage(string path) =>
        IsUnder(path, _dir) || IsUnder(path, _workRoot);

    private static bool IsUnder(string path, string root) =>
        path.Length > root.Length
        && path.StartsWith(root, StringComparison.Ordinal)
        && path[root.Length] == Path.DirectorySeparatorChar;
}