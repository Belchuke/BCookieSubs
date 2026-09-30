using System.Collections.Concurrent;
using BCookieSubs.Shared.Grpc;

namespace BCookieSubs.Worker.Services;

public class WorkerConnectionRegistry
{
    private readonly ConcurrentDictionary<string, WorkerSession> _sessions = new();

    public void Add(WorkerSession session) => _sessions[session.ConnectionId] = session;

    public void Remove(string connectionId) => _sessions.TryRemove(connectionId, out _);

    public WorkerSession? Get(string connectionId) => _sessions.TryGetValue(connectionId, out var s) ? s : null;

    public List<WorkerSession> ReplaceForWorker(long workerId)
    {
        var replaced = new List<WorkerSession>();
        foreach (var session in _sessions.Values.Where(s => s.WorkerId == workerId).ToList())
        {
            session.Terminate("superseded by a new connection");
            if (_sessions.TryRemove(session.ConnectionId, out var removed))
            {
                replaced.Add(removed);
            }
        }
        return replaced;
    }

    public IReadOnlyList<WorkerSession> Snapshot() => _sessions.Values.ToList();

    public WorkerSession? GetForWorker(long workerId) =>
        _sessions.Values.FirstOrDefault(s => s.WorkerId == workerId);

    public OrchestrationSnapshot BuildSnapshot()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        return new OrchestrationSnapshot
        {
            GeneratedAtUnix = now,
            Workers =
            {
                _sessions.Values.Select(s => new OrchestrationWorker
                {
                    WorkerId = s.WorkerId,
                    Connected = true,
                    ConnectionId = s.ConnectionId,
                    ConnectedAtUnix = new DateTimeOffset(s.ConnectedAt).ToUnixTimeSeconds(),
                    LastHeartbeatAtUnix = new DateTimeOffset(s.LastHeartbeatAt).ToUnixTimeSeconds(),
                    Ready = s.Ready,
                    ActiveJobs = s.ActiveJobs,
                    MaxConcurrency = s.MaxConcurrency
                })
            }
        };
    }
}