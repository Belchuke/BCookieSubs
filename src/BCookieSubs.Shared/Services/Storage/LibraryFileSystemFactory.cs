using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Security;

namespace BCookieSubs.Shared.Services.Storage;

public interface ILibraryFileSystemFactory
{
    Task<ILibraryFileSystem> CreateAsync(LibraryPath lp, CancellationToken ct = default);
}

public class LibraryFileSystemFactory(SecretsService secrets) : ILibraryFileSystemFactory
{
    public async Task<ILibraryFileSystem> CreateAsync(LibraryPath lp, CancellationToken ct = default)
    {
        if (lp.Storage != LibraryStorageKind.Sftp)
            return new LocalLibraryFileSystem();

        if (string.IsNullOrWhiteSpace(lp.SftpHost) || string.IsNullOrWhiteSpace(lp.SftpUsername))
            throw new LibraryConnectionException("SFTP host and username are not configured for this library path");

        var password = await secrets.GetAsync(SecretKeys.SftpPassword(lp.Id), ct);
        var key = await secrets.GetAsync(SecretKeys.SftpPrivateKey(lp.Id), ct);
        var passphrase = await secrets.GetAsync(SecretKeys.SftpKeyPassphrase(lp.Id), ct);

        if (lp.SftpAuthMode == LibrarySftpAuthMode.Password && string.IsNullOrEmpty(password))
            throw new LibraryConnectionException("No SFTP password is configured for this library path");
        if (lp.SftpAuthMode == LibrarySftpAuthMode.PrivateKey && string.IsNullOrEmpty(key))
            throw new LibraryConnectionException("No SFTP private key is configured for this library path");
        if (string.IsNullOrWhiteSpace(lp.SftpHostKeyFingerprint))
            throw new LibraryConnectionException(
                "The SFTP server's host key is not trusted yet — use Test Connection to verify and trust it");

        return new SftpLibraryFileSystem(new SftpCredentials(
            lp.SftpHost, lp.SftpPort, lp.SftpUsername, password, key, passphrase,
            lp.SftpHostKeyFingerprint));
    }
}