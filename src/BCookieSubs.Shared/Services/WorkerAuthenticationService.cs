using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace BCookieSubs.Shared.Services;

public class WorkerAuthenticationException : Exception
{
    public WorkerAuthenticationException(string message) : base(message) { }
}

public class WorkerAuthenticationService(
    WorkerEnrollmentRepository enrollments,
    WorkerNodeRepository nodes,
    WorkerCredentialRepository credentials,
    IOptions<WorkerJwtOptions> jwtOptions,
    ILogger<WorkerAuthenticationService> logger)
{
    public async Task<(WorkerNode Worker, string Secret, string Token)> EnrollAsync(
        string enrollmentToken,
        string requestedName,
        string? machineIdentifier,
        string? workerVersion,
        IReadOnlyList<string> capabilities,
        int maxConcurrency,
        WorkerHardwareInformation? hardware,
        CancellationToken ct = default)
    {
        var hash = TokenGenerator.Sha256Hex(enrollmentToken);
        var enrollment = await enrollments.GetByCodeHashAsync(hash, ct);
        if (enrollment is null && !IsBootstrapToken(enrollmentToken))
        {
            throw new WorkerAuthenticationException("Enrollment code is invalid or expired.");
        }

        var bootstrap = enrollment is null;
        var name = await ResolveUniqueNameAsync(requestedName, ct);
        var secret = TokenGenerator.NewWorkerSecret();

        var node = new WorkerNode
        {
            Name = name,
            MachineIdentifier = machineIdentifier?[..Math.Min(100, machineIdentifier.Length)],
            Enabled = true,
            Draining = false,
            WorkerVersion = workerVersion is null ? null : workerVersion[..Math.Min(32, workerVersion.Length)],
            ReportedCapabilities = CapabilityNames.Normalize(capabilities).ToList(),
            AllowedCapabilities = CapabilityNames.Normalize(capabilities).ToList(),
            Hardware = hardware,
            MaxConcurrency = Math.Clamp(maxConcurrency, 1, 64),
            LastSeenAt = DateTime.UtcNow
        };

        await using var transaction = await nodes.BeginTransactionAsync(ct);
        await nodes.AddAsync(node, ct);
        await credentials.AddAsync(new WorkerCredential { WorkerId = node.Id, SecretHash = TokenGenerator.Sha256Hex(secret) }, ct);
        if (!bootstrap)
        {
            var consumed = await enrollments.MarkConsumedAsync(enrollment!.Id, node.Id, ct);
            if (consumed == 0)
            {
                await transaction.RollbackAsync(ct);
                throw new WorkerAuthenticationException("Enrollment code is invalid or expired.");
            }
        }
        await transaction.CommitAsync(ct);

        if (bootstrap)
        {
            logger.LogInformation("Worker enrolled via bootstrap token: {WorkerId} ({Name})", node.Id, node.Name);
        }
        else
        {
            logger.LogInformation("Worker enrolled: {WorkerId} ({Name})", node.Id, node.Name);
        }
        return (node, secret, CreateToken(node));
    }

    private bool IsBootstrapToken(string token)
    {
        var configured = jwtOptions.Value.BootstrapToken;
        if (string.IsNullOrWhiteSpace(configured) || token.Length < 32)
        {
            return false;
        }

        var presented = Encoding.UTF8.GetBytes(TokenGenerator.Sha256Hex(token));
        var expected = Encoding.UTF8.GetBytes(TokenGenerator.Sha256Hex(configured));
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(presented, expected);
    }

    public async Task<WorkerNode> AuthenticateAsync(long workerId, string secret, CancellationToken ct = default)
    {
        var credential = await credentials.GetActiveBySecretHashAsync(TokenGenerator.Sha256Hex(secret), ct);
        if (credential is null || credential.WorkerId != workerId)
        {
            throw new WorkerAuthenticationException("Authentication failed.");
        }

        var node = await nodes.GetAsync(workerId, ct);
        if (node is null || !node.Enabled)
        {
            throw new WorkerAuthenticationException("Authentication failed.");
        }

        return node;
    }

    public string CreateToken(WorkerNode worker)
    {
        var options = jwtOptions.Value;
        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(options.SigningKey));
        var handler = new JwtSecurityTokenHandler();
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = options.Issuer,
            Audience = options.Audience,
            Expires = DateTime.UtcNow.AddMinutes(options.LifetimeMinutes),
            SigningCredentials = new SigningCredentials(key, SecurityAlgorithms.HmacSha256),
            Claims = new Dictionary<string, object>
            {
                ["worker_id"] = worker.Id.ToString(),
                ["worker_name"] = worker.Name
            }
        };
        return handler.CreateToken(descriptor) is JwtSecurityToken token ? handler.WriteToken(token) : "";
    }

    private async Task<string> ResolveUniqueNameAsync(string requestedName, CancellationToken ct)
    {
        var baseName = string.IsNullOrWhiteSpace(requestedName) ? "python-worker" : requestedName.Trim();
        baseName = baseName[..Math.Min(100, baseName.Length)];
        var name = baseName;
        var suffix = 2;
        while (await nodes.NameExistsAsync(name, ct))
        {
            name = $"{baseName}-{suffix++}";
        }
        return name;
    }
}