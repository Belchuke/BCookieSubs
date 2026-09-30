using System.Security.Cryptography;
using System.Text;
using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BCookieSubs.Shared.Services;

public class SecretsService(
    BCookieSubsDbContext db,
    IOptions<SecretEncryptionOptions> encryptionOptions,
    ILogger<SecretsService> logger)
{
    private const int NonceSize = 12;
    private const int TagSize = 16;
    public const string Algorithm = "aes-256-gcm";

    public async Task<List<ApplicationSecret>> GetAllAsync(CancellationToken ct = default) =>
        await db.ApplicationSecrets.AsNoTracking().OrderBy(s => s.Key).ToListAsync(ct);

    public async Task<string?> GetAsync(string key, CancellationToken ct = default)
    {
        var secret = await db.ApplicationSecrets.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (secret is null)
        {
            return null;
        }

        return Decrypt(secret);
    }

    public async Task SetAsync(string key, string value, bool setByEnv, CancellationToken ct = default)
    {
        var (ciphertext, nonce, tag) = Encrypt(value);

        var secret = await db.ApplicationSecrets.FirstOrDefaultAsync(s => s.Key == key, ct);
        if (secret is null)
        {
            secret = new ApplicationSecret { Key = key, CreatedAt = DateTime.UtcNow };
            db.ApplicationSecrets.Add(secret);
        }
        else
        {
            secret.UpdatedAt = DateTime.UtcNow;
        }

        secret.Ciphertext = ciphertext;
        secret.Nonce = nonce;
        secret.Tag = tag;
        secret.Algorithm = Algorithm;
        secret.SetByEnv = setByEnv;
        await db.SaveChangesAsync(ct);
    }

    public async Task DeleteAsync(string key, CancellationToken ct = default)
    {
        await db.ApplicationSecrets.Where(s => s.Key == key).ExecuteDeleteAsync(ct);
    }

    public async Task<int> SyncFromEnvironmentAsync(CancellationToken ct = default)
    {
        var inserted = 0;
        var updated = 0;

        foreach (var (envName, secretKey) in SecretKeys.EnvironmentVariables)
        {
            var value = Environment.GetEnvironmentVariable(envName);
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            var existing = await db.ApplicationSecrets.FirstOrDefaultAsync(s => s.Key == secretKey, ct);
            try
            {
                if (existing is null)
                {
                    await SetAsync(secretKey, value, setByEnv: true, ct);
                    inserted++;
                }
                else if (existing.SetByEnv)
                {
                    var currentPlaintext = await GetAsync(secretKey, ct);
                    if (currentPlaintext != value)
                    {
                        await SetAsync(secretKey, value, setByEnv: true, ct);
                        updated++;
                    }
                }
            }
            catch (InvalidOperationException ex)
            {
                logger.LogWarning("Skipping secret {Key} from {Env}: {Message}", secretKey, envName, ex.Message);
                continue;
            }
        }

        if (inserted + updated > 0)
        {
            logger.LogInformation("Environment secret sync: {Inserted} inserted, {Updated} updated", inserted, updated);
        }

        return inserted + updated;
    }

    public (byte[] Ciphertext, byte[] Nonce, byte[] Tag) EncryptToParts(string plaintext) =>
        Encrypt(plaintext);

    private (byte[] Ciphertext, byte[] Nonce, byte[] Tag) Encrypt(string plaintext)
    {
        using var aes = CreateAes();

        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var plaintextBytes = Encoding.UTF8.GetBytes(plaintext);
        var ciphertext = new byte[plaintextBytes.Length];
        var tag = new byte[TagSize];

        aes.Encrypt(nonce, plaintextBytes, ciphertext, tag);
        return (ciphertext, nonce, tag);
    }

    private string Decrypt(ApplicationSecret secret)
    {
        using var aes = CreateAes();

        var plaintextBytes = new byte[secret.Ciphertext.Length];
        aes.Decrypt(secret.Nonce, secret.Ciphertext, secret.Tag, plaintextBytes);
        return Encoding.UTF8.GetString(plaintextBytes);
    }

    private AesGcm CreateAes()
    {
        var masterKey = encryptionOptions.Value.MasterKey;
        if (string.IsNullOrWhiteSpace(masterKey))
        {
            throw new InvalidOperationException(
                "SECRET_ENCRYPTION_KEY is not set; application-managed secrets cannot be encrypted or read.");
        }

        return new AesGcm(SHA256.HashData(Encoding.UTF8.GetBytes(masterKey)), TagSize);
    }
}