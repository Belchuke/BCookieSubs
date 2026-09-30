namespace BCookieSubs.Shared.Services.Storage;

public interface ILibraryFileSystem : IAsyncDisposable
{
    bool IsRemote { get; }

    IAsyncEnumerable<LibraryDirEntry> EnumerateDirectoryEntriesAsync(string dir, CancellationToken ct = default);

    Task<bool> ExistsAsync(string path, CancellationToken ct = default);

    Task<LibraryFileStat?> StatAsync(string path, CancellationToken ct = default);

    Task<Stream> OpenReadAsync(string path, CancellationToken ct = default);

    Task<string> ReadTextAsync(string path, CancellationToken ct = default);

    Task WriteTextAsync(string path, string content, CancellationToken ct = default);

    Task<string> StageToWorkAsync(string path, string stageDir, CancellationToken ct = default);

    Task CopyFromLocalAsync(string localPath, string remotePath, CancellationToken ct = default);
}

public sealed record LibraryDirEntry(string FullPath, string Name, bool IsDirectory);

public sealed record LibraryFileStat(long Size, DateTime LastWriteTimeUtc);