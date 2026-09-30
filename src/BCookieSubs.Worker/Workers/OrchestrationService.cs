using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Worker.Services;
using Grpc.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System.Text.Json;

namespace BCookieSubs.Worker.Workers;

public class OrchestrationService(
    WorkerConnectionRegistry registry,
    OrchestrationEventBus events,
    WorkerGatewayOrchestrator orchestrator,
    TranslationRunnerService translationRunner,
    ComputeRunnerState computeState,
    IServiceScopeFactory scopeFactory,
    IOptions<OrchestrationOptions> options) : Orchestration.OrchestrationBase
{
    private bool Authorized(ServerCallContext context) =>
        context.RequestHeaders.GetValue("x-api-key") is string key &&
        options.Value.ApiKey.Length > 0 &&
        TokenGenerator.FixedTimeEquals(TokenGenerator.Sha256Hex(key), TokenGenerator.Sha256Hex(options.Value.ApiKey));

    public override Task<OrchestrationSnapshot> GetSnapshot(GetSnapshotRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        return Task.FromResult(registry.BuildSnapshot());
    }

    public override async Task WatchEvents(WatchEventsRequest request, IServerStreamWriter<OrchestrationEvent> responseStream, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        using var subscription = events.Subscribe(out var reader);
        await foreach (var evt in reader.ReadAllAsync(context.CancellationToken))
        {
            await responseStream.WriteAsync(evt, context.CancellationToken);
        }
    }

    public override async Task<NotifyWorkerChangedResponse> NotifyWorkerChanged(NotifyWorkerChangedRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        await orchestrator.ApplyDurableChangeAsync(request.WorkerId, "durable worker change from Web");
        return new NotifyWorkerChangedResponse { Delivered = true };
    }


    public override async Task<PrepareTranslationResponse> PrepareTranslation(
        PrepareTranslationRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        var (success, msg) = await RunPrepareTranslationAsync(
            request.ItemId, request.ResetStatus, request.UserId,
            request.SourceOverrideJson, request.SourceLanguageHint, context.CancellationToken);
        return new PrepareTranslationResponse { Success = success, Msg = msg ?? "" };
    }

    public override async Task<PrepareTranslationBatchResponse> PrepareTranslationBatch(
        PrepareTranslationBatchRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        var response = new PrepareTranslationBatchResponse();
        foreach (var item in request.Items)
        {
            var (success, msg) = await RunPrepareTranslationAsync(
                item.ItemId, item.ResetStatus, request.UserId,
                item.SourceOverrideJson, item.SourceLanguageHint, context.CancellationToken);
            response.Results.Add(new PrepareTranslationBatchResult
            {
                ItemId = item.ItemId,
                Success = success,
                Msg = msg ?? "",
            });
        }
        return response;
    }

    public override async Task<ListSubtitleSourcesResponse> ListSubtitleSources(
        ListSubtitleSourcesRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        using var scope = scopeFactory.CreateScope();
        var requests = scope.ServiceProvider.GetRequiredService<LibraryRequestsService>();
        var (success, msg, sources) =
            await requests.RecomputeSubtitleSourcesAsync(request.ItemId, context.CancellationToken);
        return new ListSubtitleSourcesResponse
        {
            Success = success,
            Msg = msg ?? "",
            SourcesJson = JsonSerializer.Serialize(sources),
        };
    }

    public override Task<SetTranslationRunnerPausedResponse> SetTranslationRunnerPaused(
        SetTranslationRunnerPausedRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        return SetTranslationRunnerPausedCoreAsync(request);
    }

    private async Task<SetTranslationRunnerPausedResponse> SetTranslationRunnerPausedCoreAsync(
        SetTranslationRunnerPausedRequest request)
    {
        try
        {
            if (request.Paused)
            {
                await translationRunner.PauseAsync(userId: 0, request.ActingUsername, CancellationToken.None);
            }
            else
            {
                await translationRunner.ResumeAsync(request.ActingUsername, CancellationToken.None);
            }
            return new SetTranslationRunnerPausedResponse
            {
                Success = true,
                Paused = translationRunner.IsPaused,
            };
        }
        catch (Exception)
        {
            return new SetTranslationRunnerPausedResponse { Success = false, Paused = translationRunner.IsPaused };
        }
    }

    // ── Compute-worker pause (V7 dashboard) ────────────────────────────────

    public override async Task<SetComputeRunnerPausedResponse> SetComputeRunnerPaused(
        SetComputeRunnerPausedRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        if (request.Kind != ComputeRunnerKind.Whisper && request.Kind != ComputeRunnerKind.Ocr)
        {
            return new SetComputeRunnerPausedResponse { Success = false, Msg = "Unknown runner" };
        }

        var whisper = request.Kind == ComputeRunnerKind.Whisper;
        computeState.SetPaused(whisper, request.Paused, out var changed);
        if (changed)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var logs = scope.ServiceProvider.GetRequiredService<ApplicationLogRepository>();
                var who = string.IsNullOrEmpty(request.ActingUsername) ? "unknown user" : request.ActingUsername;
                var what = whisper ? "Whisper" : "OCR";
                await logs.AddAsync(new ApplicationLog
                {
                    Level = LogLevelKind.Info,
                    Type = "workerState",
                    EntityType = "worker",
                    Message = $"{what} runner {(request.Paused ? "paused" : "resumed")} by user: {who}",
                    Metadata = JsonSerializer.Serialize(new { username = who }),
                    CreatedAt = DateTime.UtcNow,
                });
            }
            catch (Exception)
            {
            }
        }
        return new SetComputeRunnerPausedResponse
        {
            Success = true,
            Paused = whisper ? computeState.WhisperPaused : computeState.OcrPaused,
        };
    }

    public override Task<GetComputeRunnerStatesResponse> GetComputeRunnerStates(
        GetComputeRunnerStatesRequest request, ServerCallContext context)
    {
        if (!Authorized(context))
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "invalid orchestration key"));
        }

        return Task.FromResult(new GetComputeRunnerStatesResponse
        {
            TranslationPaused = translationRunner.IsPaused,
            WhisperPaused = computeState.WhisperPaused,
            OcrPaused = computeState.OcrPaused,
        });
    }

    private async Task<(bool Success, string? Msg)> RunPrepareTranslationAsync(
        long itemId, bool resetStatus, long userId, string sourceOverrideJson, string sourceLanguageHint,
        CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var autoTranslate = scope.ServiceProvider.GetRequiredService<LibraryAutoTranslateService>();
        var overrideJson = string.IsNullOrWhiteSpace(sourceOverrideJson) ? null : sourceOverrideJson;
        LibraryAutoTranslateService.SubtitleSourceOverride? sourceOverride = null;
        if (overrideJson != null)
        {
            try
            {
                sourceOverride = JsonSerializer.Deserialize<LibraryAutoTranslateService.SubtitleSourceOverride>(overrideJson);
            }
            catch (JsonException)
            {
                return (false, "Invalid source override");
            }
        }

        var result = await autoTranslate.PrepareTranslationForItemAsync(
            itemId, resetStatus, userId, sourceOverride,
            string.IsNullOrEmpty(sourceLanguageHint) ? null : sourceLanguageHint, ct: ct);
        return (result.Success, result.Msg);
    }
}