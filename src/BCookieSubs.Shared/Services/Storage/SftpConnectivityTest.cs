using System.Net;
using System.Net.Sockets;
using System.Text;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace BCookieSubs.Shared.Services.Storage;

public static class SftpConnectivityTest
{
    public sealed record Request(
        string Host, int Port, string Username,
        string? Password, string? PrivateKeyPem, string? KeyPassphrase,
        string? RootPath,
        string? AcceptedFingerprint,
        string? PreviouslyTrustedFingerprint);

    public sealed record Result(
        bool Success,
        string? Error,
        string? PresentedFingerprint,
        bool NeedsTrust,
        bool KeyChanged,
        IReadOnlyList<string> Steps);

    public static async Task<Result> RunAsync(Request req, CancellationToken ct = default)
    {
        var steps = new List<string>();
        var presented = default(string?);
        var trustedThisRun = false;

        IPAddress[] addresses;
        try
        {
            addresses = await Dns.GetHostAddressesAsync(req.Host, ct);
            if (addresses.Length == 0)
                return HostKeyResult($"Could not resolve the SFTP host '{req.Host}'.", steps, req, presented);
            steps.Add("Host resolved.");
        }
        catch (SocketException)
        {
            return HostKeyResult($"Could not resolve the SFTP host '{req.Host}'.", steps, req, presented);
        }

        try
        {
            using var tcp = new TcpClient();
            await tcp.ConnectAsync(addresses[0], req.Port, ct);
            steps.Add($"Connected to {req.Host}:{req.Port}.");
        }
        catch (SocketException)
        {
            return HostKeyResult(
                $"Could not reach {req.Host}:{req.Port} — the port is closed or the host is unreachable.",
                steps, req, presented);
        }

        AuthenticationMethod auth;
        try
        {
            auth = req.PrivateKeyPem is { Length: > 0 } pem
                ? new PrivateKeyAuthenticationMethod(req.Username,
                    new PrivateKeyFile(new MemoryStream(Encoding.UTF8.GetBytes(pem)), req.KeyPassphrase))
                : new PasswordAuthenticationMethod(req.Username, req.Password ?? "");
        }
        catch (Exception ex) when (ex is SshException or ArgumentException
            or System.Security.Cryptography.CryptographicException)
        {
            return HostKeyResult(
                "The private key could not be used — check the key format and its passphrase.",
                steps, req, presented);
        }

        var client = new SftpClient(new ConnectionInfo(req.Host, req.Port, req.Username, auth)
        {
            Timeout = TimeSpan.FromSeconds(15),
        })
        {
            OperationTimeout = TimeSpan.FromSeconds(15),
        };
        try
        {
            client.HostKeyReceived += (s, e) =>
            {
                presented = SftpHostKey.Fingerprint(e.HostKey);
                trustedThisRun = SftpHostKey.FingerprintMatches(req.AcceptedFingerprint, e.HostKey);
                e.CanTrust = trustedThisRun;
            };

            await client.ConnectAsync(ct);
        }
        catch (Exception ex)
        {
            client.Dispose();
            var keyChanged = presented != null
                && req.PreviouslyTrustedFingerprint != null
                && !string.Equals(req.PreviouslyTrustedFingerprint.Trim(), presented.Trim(), StringComparison.Ordinal);
            if (presented != null && !trustedThisRun)
            {
                return new Result(
                    Success: false,
                    Error: keyChanged
                        ? "The server's host key changed since it was last trusted. Verify this is expected before trusting the new key."
                        : "The server's host key is not trusted yet. Review the fingerprint below before trusting it.",
                    PresentedFingerprint: presented,
                    NeedsTrust: !keyChanged,
                    KeyChanged: keyChanged,
                    Steps: steps);
            }
            if (ex is SshAuthenticationException)
                return HostKeyResult(
                    "SFTP authentication failed — check the username and the configured password or key.",
                    steps, req, presented);
            if (ex is SshConnectionException)
                return HostKeyResult($"SSH handshake with {req.Host}:{req.Port} failed.", steps, req, presented);
            return HostKeyResult(SftpErrors.Describe(req.Host, req.Port, ex), steps, req, presented);
        }

        using (client)
        {
            steps.Add("SSH handshake and authentication succeeded.");

            var root = string.IsNullOrWhiteSpace(req.RootPath) ? "." : req.RootPath;
            try
            {
                var attrs = await client.GetAttributesAsync(root, ct);
                if (!attrs.IsDirectory)
                    return HostKeyResult($"The remote root '{root}' is not a directory.", steps, req, presented);
                steps.Add($"Remote root '{root}' exists.");
            }
            catch (SftpPathNotFoundException)
            {
                return HostKeyResult($"The remote root '{root}' does not exist on the server.", steps, req, presented);
            }
            catch (SshException ex)
            {
                return HostKeyResult($"Could not inspect the remote root '{root}'. {ex.Message}", steps, req, presented);
            }

            try
            {
                var listing = await client.ListDirectoryAsync(root, ct).ToListAsync(ct);
                steps.Add($"Read access verified ({listing.Count} entries in '{root}').");
            }
            catch (SshException ex)
            {
                return HostKeyResult($"The SFTP account cannot read '{root}'. {ex.Message}", steps, req, presented);
            }
        }

        return new Result(true, null, presented, false, false, steps);
    }

    // Success/failed-but-no-host-key outcomes: NeedsTrust/KeyChanged can still
    // be true when a host key was captured before an auth or IO failure.
    private static Result HostKeyResult(string error, List<string> steps, Request req, string? presented)
    {
        var keyChanged = presented != null
            && req.PreviouslyTrustedFingerprint != null
            && !string.Equals(req.PreviouslyTrustedFingerprint.Trim(), presented.Trim(), StringComparison.Ordinal);
        return new Result(
            Success: false,
            Error: error,
            PresentedFingerprint: presented,
            NeedsTrust: presented != null && !keyChanged,
            KeyChanged: keyChanged,
            Steps: steps);
    }
}