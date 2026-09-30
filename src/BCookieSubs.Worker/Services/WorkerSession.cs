using BCookieSubs.Shared.Grpc;
using Grpc.Core;

namespace BCookieSubs.Worker.Services;

public sealed class WorkerSession
{
    public required string ConnectionId { get; init; }
    public required long WorkerId { get; set; }
    public required IServerStreamWriter<ServerMessage> ResponseStream { get; init; }
    public required CancellationTokenSource Lifetime { get; init; }

    public DateTime ConnectedAt { get; init; } = DateTime.UtcNow;
    public DateTime LastHeartbeatAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastPersistedSeenAt { get; set; }
    public bool Ready { get; set; } = true;
    public int ActiveJobs { get; set; }
    public int MaxConcurrency { get; set; } = 1;
    public string? WorkerVersion { get; set; }
    public string? MachineIdentifier { get; set; }

    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public async Task SendAsync(ServerMessage message, CancellationToken ct = default)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            await ResponseStream.WriteAsync(message);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public bool TrySend(ServerMessage message)
    {
        try
        {
            _writeLock.Wait();
            try
            {
                ResponseStream.WriteAsync(message).GetAwaiter().GetResult();
                return true;
            }
            finally
            {
                _writeLock.Release();
            }
        }
        catch (Exception)
        {
            return false;
        }
    }

    public void Terminate(string reason)
    {
        TrySend(new ServerMessage
        {
            Disconnect = new ServerDisconnect { Reason = reason }
        });
        Lifetime.Cancel();
    }
}