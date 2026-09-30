namespace BCookieSubs.Shared.Common;

public enum WorkerEffectiveState
{
    Pending,
    Online,
    Busy,
    Draining,
    Offline,
    Disabled
}

public record WorkerLiveState(
    long WorkerId,
    bool Connected,
    DateTime? ConnectedAt,
    DateTime? LastHeartbeatAt,
    bool Ready,
    int ActiveJobs);

public static class WorkerStateCalculator
{
    public static WorkerEffectiveState Calculate(Database.Entities.WorkerNode node, WorkerLiveState? live)
    {
        if (!node.Enabled)
        {
            return WorkerEffectiveState.Disabled;
        }

        if (live is not { Connected: true })
        {
            return node.LastConnectedAt is null ? WorkerEffectiveState.Pending : WorkerEffectiveState.Offline;
        }

        if (node.Draining)
        {
            return WorkerEffectiveState.Draining;
        }

        return live.ActiveJobs >= node.MaxConcurrency ? WorkerEffectiveState.Busy : WorkerEffectiveState.Online;
    }
}