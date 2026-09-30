namespace BCookieSubs.Shared.Services.Storage;

public sealed class LocalLibraryFileSystem : ILibraryFileSystem
{
    public bool IsRemote => false;

    public async IAsyncEnumerable<LibraryDirEntry> EnumerateDirectoryEntriesAsync(
        string dir, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        string[] entries;
        try
        {
            entries = Directory.GetFileSystemEntries(dir);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            yield break;
        }

        foreach (var full in entries)
        {
            bool isDir;
            try
            {
                isDir = File.GetAttributes(full).HasFlag(FileAttributes.Directory);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            ct.ThrowIfCancellationRequested();
            yield return new LibraryDirEntry(full, Path.GetFileName(full), isDir);
        }
        await Task.CompletedTask;
    }

    public Task<bool> ExistsAsync(string path, CancellationToken ct = default) =>
        Task.FromResult(Directory.Exists(path) || File.Exists(path));

    public Task<LibraryFileStat?> StatAsync(string path, CancellationToken ct = default)
    {
        try
        {
            var st = new FileInfo(path);
            return Task.FromResult<LibraryFileStat?>(
                st.Exists ? new LibraryFileStat(st.Length, st.LastWriteTimeUtc) : null);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Task.FromResult<LibraryFileStat?>(null);
        }
    }

    public Task<Stream> OpenReadAsync(string path, CancellationToken ct = default) =>
        Task.FromResult<Stream>(File.OpenRead(path));

    public async Task<string> ReadTextAsync(string path, CancellationToken ct = default) =>
        await File.ReadAllTextAsync(path, ct);

    public async Task WriteTextAsync(string path, string content, CancellationToken ct = default)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        await File.WriteAllTextAsync(path, content, ct);
    }

    public Task<string> StageToWorkAsync(string path, string stageDir, CancellationToken ct = default) =>
        Task.FromResult(path);

    public Task CopyFromLocalAsync(string localPath, string remotePath, CancellationToken ct = default)
    {
        var dir = Path.GetDirectoryName(remotePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        File.Copy(localPath, remotePath, overwrite: true);
        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}