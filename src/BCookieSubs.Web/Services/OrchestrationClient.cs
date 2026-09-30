using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Services;
using Grpc.Core;
using Grpc.Net.Client;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Text.Json;

namespace BCookieSubs.Web.Services;

public class OrchestrationClient(IOptions<OrchestrationOptions> options, ILogger<OrchestrationClient> logger)
{
    private readonly object _lock = new();
    private Orchestration.OrchestrationClient? _client;

    private Metadata Headers => new() { { "x-api-key", options.Value.ApiKey } };

    private Orchestration.OrchestrationClient Client
    {
        get
        {
            lock (_lock)
            {
                _client ??= new Orchestration.OrchestrationClient(GrpcChannel.ForAddress(options.Value.Url));
                return _client;
            }
        }
    }

    public async Task<OrchestrationSnapshot?> GetSnapshotAsync(CancellationToken ct = default)
    {
        try
        {
            return await Client.GetSnapshotAsync(
                new GetSnapshotRequest(),
                headers: Headers,
                deadline: DateTime.UtcNow.AddSeconds(3),
                cancellationToken: ct);
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Orchestration snapshot unavailable: {Status}", ex.Status.StatusCode);
            return null;
        }
    }

    public async Task<bool> ProbeAsync(CancellationToken ct)
    {
        try
        {
            await Client.GetSnapshotAsync(new GetSnapshotRequest(), headers: Headers, deadline: DateTime.UtcNow.AddSeconds(3), cancellationToken: ct);
            return true;
        }
        catch (RpcException)
        {
            return false;
        }
    }

    public Grpc.Core.AsyncServerStreamingCall<OrchestrationEvent> WatchEvents(WatchEventsRequest request, CancellationToken ct = default) =>
        Client.WatchEvents(request, headers: Headers, cancellationToken: ct);

    public async Task NotifyWorkerChangedAsync(long workerId)
    {
        try
        {
            await Client.NotifyWorkerChangedAsync(
                new NotifyWorkerChangedRequest { WorkerId = workerId },
                headers: Headers,
                deadline: DateTime.UtcNow.AddSeconds(3));
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Could not notify orchestration of worker {WorkerId} change: {Status}", workerId, ex.Status.StatusCode);
        }
    }


    public async Task<(bool Success, string Msg)> PrepareTranslationAsync(
        long itemId, bool resetStatus, long userId,
        LibraryAutoTranslateService.SubtitleSourceOverride? sourceOverride,
        string? sourceLanguageHint = null, CancellationToken ct = default)
    {
        try
        {
            var response = await Client.PrepareTranslationAsync(new PrepareTranslationRequest
            {
                ItemId = itemId,
                ResetStatus = resetStatus,
                UserId = userId,
                SourceOverrideJson = sourceOverride == null
                    ? ""
                    : JsonSerializer.Serialize(sourceOverride),
                SourceLanguageHint = sourceLanguageHint ?? "",
            }, headers: Headers, deadline: DateTime.UtcNow.AddSeconds(180), cancellationToken: ct);
            return (response.Success, response.Msg);
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Translate prep unavailable for item {ItemId}: {Status}", itemId, ex.Status.StatusCode);
            return (false, "Worker unavailable — translation could not be queued");
        }
    }

    public sealed record BatchItem(
        long ItemId, bool ResetStatus,
        LibraryAutoTranslateService.SubtitleSourceOverride? SourceOverride, string? SourceLanguageHint);

    public async Task<List<(long ItemId, bool Success, string Msg)>> PrepareTranslationBatchAsync(
        long userId, List<BatchItem> items, CancellationToken ct = default)
    {
        try
        {
            var request = new PrepareTranslationBatchRequest { UserId = userId };
            foreach (var item in items)
            {
                request.Items.Add(new PrepareTranslationBatchItem
                {
                    ItemId = item.ItemId,
                    ResetStatus = item.ResetStatus,
                    SourceOverrideJson = item.SourceOverride == null
                        ? ""
                        : JsonSerializer.Serialize(item.SourceOverride),
                    SourceLanguageHint = item.SourceLanguageHint ?? "",
                });
            }
            var response = await Client.PrepareTranslationBatchAsync(
                request, headers: Headers, deadline: DateTime.UtcNow.AddSeconds(600), cancellationToken: ct);
            return response.Results.Select(r => (r.ItemId, r.Success, r.Msg)).ToList();
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Batch translate prep unavailable: {Status}", ex.Status.StatusCode);
            return items.Select(i => (i.ItemId, false, "Worker unavailable — translation could not be queued")).ToList();
        }
    }

    public async Task<(bool Success, string? Msg, List<SubtitleSourceCandidate> Sources)> ListSubtitleSourcesAsync(
        long itemId, CancellationToken ct = default)
    {
        try
        {
            var response = await Client.ListSubtitleSourcesAsync(
                new ListSubtitleSourcesRequest { ItemId = itemId },
                headers: Headers, deadline: DateTime.UtcNow.AddSeconds(120), cancellationToken: ct);
            var sources = string.IsNullOrEmpty(response.SourcesJson)
                ? []
                : JsonSerializer.Deserialize<List<SubtitleSourceCandidate>>(response.SourcesJson) ?? [];
            return (response.Success, string.IsNullOrEmpty(response.Msg) ? null : response.Msg, sources);
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Subtitle-source recompute unavailable for item {ItemId}: {Status}", itemId, ex.Status.StatusCode);
            return (false, null, []);
        }
    }

    public async Task<(bool Success, bool Paused)> SetTranslationRunnerPausedAsync(
        bool paused, string? actingUsername, CancellationToken ct = default)
    {
        try
        {
            var response = await Client.SetTranslationRunnerPausedAsync(new SetTranslationRunnerPausedRequest
            {
                Paused = paused,
                ActingUsername = actingUsername ?? "",
            }, headers: Headers, deadline: DateTime.UtcNow.AddSeconds(10), cancellationToken: ct);
            return (response.Success, response.Paused);
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Translation runner pause/resume unavailable: {Status}", ex.Status.StatusCode);
            return (false, false);
        }
    }

    // ── Compute-worker pause (V7) ──────────────────────────────────────────

    public async Task<(bool Success, bool Paused)> SetComputeRunnerPausedAsync(
        ComputeRunnerKind kind, bool paused, string? actingUsername, CancellationToken ct = default)
    {
        try
        {
            var response = await Client.SetComputeRunnerPausedAsync(new SetComputeRunnerPausedRequest
            {
                Kind = kind,
                Paused = paused,
                ActingUsername = actingUsername ?? "",
            }, headers: Headers, deadline: DateTime.UtcNow.AddSeconds(10), cancellationToken: ct);
            return (response.Success, response.Paused);
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Compute runner pause/resume unavailable: {Status}", ex.Status.StatusCode);
            return (false, false);
        }
    }

    public sealed record RunnerStates(bool TranslationPaused, bool WhisperPaused, bool OcrPaused);

    public async Task<RunnerStates?> GetComputeRunnerStatesAsync(CancellationToken ct = default)
    {
        try
        {
            var response = await Client.GetComputeRunnerStatesAsync(
                new GetComputeRunnerStatesRequest(),
                headers: Headers, deadline: DateTime.UtcNow.AddSeconds(5), cancellationToken: ct);
            return new RunnerStates(response.TranslationPaused, response.WhisperPaused, response.OcrPaused);
        }
        catch (RpcException ex)
        {
            logger.LogWarning("Compute runner states unavailable: {Status}", ex.Status.StatusCode);
            return null;
        }
    }
}