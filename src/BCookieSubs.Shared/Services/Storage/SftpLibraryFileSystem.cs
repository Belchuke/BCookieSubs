using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace BCookieSubs.Shared.Services.Storage;

public sealed class SftpLibraryFileSystem(SftpCredentials creds, ILogger? logger = null) : ILibraryFileSystem
{
    private SftpClient? _client;
    private ILogger Logger => logger ?? NullLogger.Instance;

    public bool IsRemote => true;

    private async Task<SftpClient> ClientAsync(CancellationToken ct)
    {
        if (_client is { IsConnected: true }) return _client;
        _client?.Dispose();
        _client = null;

        var client = new SftpClient(BuildConnectionInfo())
        {
            OperationTimeout = TimeSpan.FromSeconds(30),
            KeepAliveInterval = TimeSpan.FromSeconds(30),
        };
        client.HostKeyReceived += (s, e) =>
        {
            e.CanTrust = SftpHostKey.FingerprintMatches(creds.PinnedFingerprint, e.HostKey);
        };
        try
        {
            await client.ConnectAsync(ct);
        }
        catch (Exception ex)
        {
            client.Dispose();
            throw new LibraryConnectionException(SftpErrors.Describe(creds.Host, creds.Port, ex), ex);
        }
        _client = client;
        return client;
    }

    private ConnectionInfo BuildConnectionInfo()
    {
        AuthenticationMethod auth = creds.PrivateKeyPem is { Length: > 0 } pem
            ? new PrivateKeyAuthenticationMethod(creds.Username,
                new PrivateKeyFile(new MemoryStream(Encoding.UTF8.GetBytes(pem)), creds.KeyPassphrase))
            : new PasswordAuthenticationMethod(creds.Username, creds.Password ?? "");
        return new ConnectionInfo(creds.Host, creds.Port, creds.Username, auth)
        {
            Timeout = TimeSpan.FromSeconds(15),
        };
    }

    public async IAsyncEnumerable<LibraryDirEntry> EnumerateDirectoryEntriesAsync(
        string dir, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        var client = await ClientAsync(ct);
        var entries = new List<LibraryDirEntry>();
        try
        {
            await foreach (var entry in client.ListDirectoryAsync(dir, ct))
            {
                if (entry.Name is "." or "..") continue;
                entries.Add(new LibraryDirEntry(entry.FullName, entry.Name, entry.IsDirectory));
            }
        }
        catch (SftpPathNotFoundException)
        {
        }
        foreach (var e in entries)
        {
            ct.ThrowIfCancellationRequested();
            yield return e;
        }
    }

    public async Task<bool> ExistsAsync(string path, CancellationToken ct = default) =>
        (await StatAsync(path, ct)) != null;

    public async Task<LibraryFileStat?> StatAsync(string path, CancellationToken ct = default)
    {
        var client = await ClientAsync(ct);
        try
        {
            var attrs = await client.GetAttributesAsync(path, ct);
            return new LibraryFileStat(attrs.Size, attrs.LastWriteTimeUtc);
        }
        catch (SftpPathNotFoundException)
        {
            return null;
        }
    }

    public async Task<Stream> OpenReadAsync(string path, CancellationToken ct = default)
    {
        var client = await ClientAsync(ct);
        try
        {
            return client.OpenRead(path);
        }
        catch (SftpPathNotFoundException)
        {
            throw new FileNotFoundException($"SFTP file not found: {path}");
        }
    }

    public async Task<string> ReadTextAsync(string path, CancellationToken ct = default)
    {
        await using var stream = await OpenReadAsync(path, ct);
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, ct);
        var bytes = buffer.ToArray();
        var start = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        return Encoding.UTF8.GetString(bytes, start, bytes.Length - start);
    }

    public async Task WriteTextAsync(string path, string content, CancellationToken ct = default)
    {
        var client = await ClientAsync(ct);
        try
        {
            if (await client.ExistsAsync(path, ct)) await client.DeleteAsync(path, ct);
        }
        catch (SftpPathNotFoundException)
        {
        }
        await using var input = new MemoryStream(Encoding.UTF8.GetBytes(content));
        try
        {
            await client.UploadFileAsync(input, path, null, ct);
        }
        catch (SftpPathNotFoundException)
        {
            throw new DirectoryNotFoundException($"SFTP directory not found: {Dir(path)}");
        }
    }

    public async Task CopyFromLocalAsync(string localPath, string remotePath, CancellationToken ct = default)
    {
        var client = await ClientAsync(ct);
        await using var input = File.OpenRead(localPath);
        try
        {
            await client.UploadFileAsync(input, remotePath, null, ct);
        }
        catch (SftpPathNotFoundException)
        {
            throw new DirectoryNotFoundException($"SFTP directory not found: {Dir(remotePath)}");
        }
    }

    public async Task<string> StageToWorkAsync(string path, string stageDir, CancellationToken ct = default)
    {
        var client = await ClientAsync(ct);
        Directory.CreateDirectory(stageDir);
        var target = Path.Combine(stageDir, Path.GetFileName(path));
        await using var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
        try
        {
            await client.DownloadFileAsync(path, output, null, ct);
        }
        catch (SftpPathNotFoundException)
        {
            throw new FileNotFoundException($"SFTP file not found: {path}");
        }
        return target;
    }

    private static string Dir(string path) => Path.GetDirectoryName(path) ?? path;

    public async ValueTask DisposeAsync()
    {
        var client = _client;
        _client = null;
        if (client == null) return;
        try
        {
            if (client.IsConnected) client.Disconnect();
        }
        catch (Exception ex)
        {
            Logger.LogDebug(ex, "SFTP disconnect failed");
        }
        client.Dispose();
        await Task.CompletedTask;
    }
}

// Credentials resolved from the encrypted secret store; plaintext never leaves
// this type except into the SSH client.
public sealed record SftpCredentials(
    string Host, int Port, string Username,
    string? Password, string? PrivateKeyPem, string? KeyPassphrase,
    string PinnedFingerprint);

public class LibraryConnectionException(string message, Exception? inner = null)
    : Exception(message, inner);

// SHA256 fingerprints in the OpenSSH "SHA256:<base64 unpadded>" format.
public static class SftpHostKey
{
    public static string Fingerprint(byte[] hostKey) =>
        "SHA256:" + Convert.ToBase64String(SHA256.HashData(hostKey)).TrimEnd('=');

    public static bool FingerprintMatches(string? pinned, byte[] hostKey)
    {
        if (string.IsNullOrWhiteSpace(pinned)) return false;
        return string.Equals(Normalize(pinned), Normalize(Fingerprint(hostKey)), StringComparison.Ordinal);
    }

    private static string Normalize(string fingerprint) => fingerprint.Trim().TrimEnd('=');
}

// Safe, credential-free error text for connection failures.
public static class SftpErrors
{
    public static string Describe(string host, int port, Exception ex) => ex switch
    {
        SshAuthenticationException =>
            "SFTP authentication failed — check the username and the configured password or key.",
        _ => ex.Message,
    };
}