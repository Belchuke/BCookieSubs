using System.Text.Json;
using BCookieSubs.Shared.Configuration;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services.Storage;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace BCookieSubs.Shared.Services;

public sealed record ValidCandidate(
    long CandidateId, long ModelId, long PromptId, long PromptVersionId, List<ParsedChunkRow> Rows);

public class TranslationRunnerService(
    IServiceScopeFactory scopeFactory,
    IDashboardEventPublisher? dashboardEvents = null,
    ILogger<TranslationRunnerService> logger = null!)
{
    private readonly IDashboardEventPublisher _dashboardEvents = dashboardEvents ?? new NoopDashboardEventPublisher();
    private static readonly TimeSpan TaskInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan IdleInterval = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan ModelRequestTimeout = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan LogCleanupInterval = TimeSpan.FromHours(1);
    private const int JudgeFormatRetriesDefault = 3;

    private readonly object _gate = new();
    private bool _paused;
    private long? _currentScheduleId;
    private long? _runningChunkId;
    private DateTime _lastLogCleanup = DateTime.MinValue;

    private CancellationTokenSource? _abortCts;

    public bool IsPaused { get { lock (_gate) return _paused; } }

    public async Task PauseAsync(long userId, string? username, CancellationToken ct = default)
    {
        CancellationTokenSource? abort;
        long? running;
        lock (_gate)
        {
            _paused = true;
            abort = _abortCts;
            running = _runningChunkId;
        }
        abort?.Cancel();

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
        if (running != null)
            await new SubtitlePipelineRepository(db).ReleaseRunningChunksAsync([running.Value], ct);
        await LogWorkerStateAsync(db, LogLevelKind.Info, $"Worker paused by user: {username ?? "unknown user"}",
            new { username }, ct);
    }

    public async Task ResumeAsync(string? username, CancellationToken ct = default)
    {
        lock (_gate) _paused = false;
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
        await LogWorkerStateAsync(db, LogLevelKind.Info, $"Worker resumed by user: {username ?? "unknown user"}",
            new { username }, ct);
    }

    public async Task RunAsync(CancellationToken stoppingToken)
    {
        await using (var scope = scopeFactory.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
            var pipeline = new SubtitlePipelineRepository(db);

            var staleBefore = DateTime.UtcNow - (ModelRequestTimeout + TimeSpan.FromSeconds(60));
            var staleReset = await pipeline.ResetStaleRunningChunksAsync(staleBefore, stoppingToken);
            if (staleReset > 0)
                await LogWorkerStateAsync(db, LogLevelKind.Warning,
                    $"Reset {staleReset} stale running chunk(s) back to queued on worker startup",
                    new { staleSeconds = (int)(ModelRequestTimeout + TimeSpan.FromSeconds(60)).TotalSeconds }, stoppingToken);
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                if (stoppingToken.IsCancellationRequested) break;
            }
            catch (Exception e)
            {
                await ReleaseRunningChunkAsync(CancellationToken.None);
                await using var scope = scopeFactory.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
                await LogWorkerStateAsync(db, LogLevelKind.Error,
                    $"Translation worker loop crashed: {Summarize(e)}", new { error = e.ToString() }, CancellationToken.None);
            }

            try
            {
                await Task.Delay(TaskInterval, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        await ReleaseRunningChunkAsync(CancellationToken.None);
    }

    private async Task RunOnceAsync(CancellationToken ct)
    {
        if (IsPaused) return;

        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
        var pipeline = new SubtitlePipelineRepository(db);
        var configRepo = new ApplicationConfigRepository(db);
        var config = await configRepo.GetAsync(ct);
        if (config == null) return;

        var scheduleRepo = new ScheduleRepository(db);
        long? currentScheduleId;
        lock (_gate) currentScheduleId = _currentScheduleId;
        var decision = await TranslationScheduleWindow.GetShouldRunNowAsync(scheduleRepo, currentScheduleId, ct);
        lock (_gate) _currentScheduleId = decision.SelectedSchedule?.Id;

        if (!decision.ShouldRun)
        {
            await LogWorkerStateAsync(db, LogLevelKind.Info,
                "Worker paused automatically: outside configured schedule window",
                new { scheduleId = decision.SelectedSchedule?.Id }, ct);
            await Task.Delay(IdleInterval - TaskInterval, ct);
            return;
        }

        await MaybeDeleteExpiredLogsAsync(db, config, ct);

        if (!config.WhisperRunAsSeparateTask)
        {
        }

        var chunk = await pipeline.ClaimNextChunkAsync(config.FinishSingleSubtitleFirst, ct);
        if (chunk == null) return;

        var llm = new TranslationLlmClient(new LlmChatService(
            scope.ServiceProvider.GetRequiredService<IHttpClientFactory>(),
            scope.ServiceProvider.GetRequiredService<SecretsService>()));

        using var chunkCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        lock (_gate) { _abortCts = chunkCts; _runningChunkId = chunk.Id; }
        try
        {
            await ProcessChunkAsync(db, pipeline, config, llm, chunk, chunkCts.Token);
        }
        finally
        {
            lock (_gate) { _abortCts = null; _runningChunkId = null; }
            _dashboardEvents.TranslationChanged(chunk.SubtitleId);
        }
    }

    private async Task ProcessChunkAsync(
        BCookieSubsDbContext db, SubtitlePipelineRepository pipeline, ApplicationConfig config,
        TranslationLlmClient llm, SubtitleChunk chunk, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var job = await db.SubtitleJobs.FirstOrDefaultAsync(j => j.Id == chunk.SubtitleJobId, ct);
        if (job == null)
        {
            await pipeline.MarkChunkFailedAsync(chunk.Id, "subtitleJob not found", ct);
            return;
        }
        if (job.Status == SubtitleJobStatus.Queued)
            await pipeline.UpdateJobStatusAsync(job.Id, SubtitleJobStatus.Running, ct);

        var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == chunk.SubtitleId && s.DeletedAt == null, ct);
        if (subtitle == null)
        {
            await pipeline.MarkChunkFailedAsync(chunk.Id, "subtitle not found", ct);
            return;
        }
        if (subtitle.Status == SubtitleStatus.Queued)
            await pipeline.UpdateSubtitleStatusAsync(subtitle.Id, SubtitleStatus.Running, ct);
        _dashboardEvents.TranslationChanged(subtitle.Id);

        var sourceLang = await db.Languages.FirstOrDefaultAsync(l => l.Id == subtitle.SourceLanguageId, ct);
        var targetLang = await db.Languages.FirstOrDefaultAsync(l => l.Id == chunk.TargetLanguageId, ct);
        if (sourceLang == null || targetLang == null)
        {
            await pipeline.MarkChunkFailedAsync(chunk.Id, "Source or target language not found", ct);
            await LogAsync(db, LogLevelKind.Error, "chunkFailed", "chunk", chunk.Id,
                $"Chunk {chunk.ChunkIndex} failed: source or target language missing in database",
                new { subtitleId = chunk.SubtitleId, sourceLangId = subtitle.SourceLanguageId, targetLanguageId = chunk.TargetLanguageId }, ct);
            return;
        }

        MediaItem? mediaItem = null;
        if (subtitle.MediaItemId != null)
            mediaItem = await db.MediaItems.FirstOrDefaultAsync(m => m.Id == subtitle.MediaItemId.Value, ct);
        var mediaName = mediaItem?.Title ?? subtitle.Name;
        var mediaType = mediaItem?.IsAnime == true ? "anime"
            : mediaItem?.Type == MediaKind.Series ? "series"
            : mediaItem?.Type == MediaKind.Movie ? "movie"
            : "unknown";

        var allRows = SubtitleAdapter.ParseSubtitleRows(subtitle.OriginalText, subtitle.SourceFormat);
        var chunkRows = allRows.Where(l =>
        {
            var id = int.Parse(l.Id);
            return id >= chunk.SrtIdFrom && id <= chunk.SrtIdTo;
        }).ToList();

        if (chunkRows.Count == 0)
        {
            await pipeline.MarkChunkFailedAsync(chunk.Id, "No subtitle lines found for this chunk range", ct);
            return;
        }

        var isAss = subtitle.SourceFormat is SubtitleFormat.Ass or SubtitleFormat.Ssa;
        var assRunsById = new Dictionary<string, List<string>>();
        var sourceRows = new List<ParsedChunkRow>();
        foreach (var row in chunkRows)
        {
            if (!isAss)
            {
                if (string.IsNullOrWhiteSpace(row.Text)) continue;
                sourceRows.Add(new ParsedChunkRow(row.Id, row.Text));
                continue;
            }
            var extracted = AssTextExtractor.ExtractAssTranslatable(row.Text);
            if (!extracted.HasTranslatable) continue;
            assRunsById[row.Id] = extracted.Runs;
            sourceRows.Add(new ParsedChunkRow(row.Id, extracted.ModelText));
        }

        if (sourceRows.Count == 0)
        {
            await pipeline.MarkChunkCompletedNoCandidateAsync(chunk.Id,
                "No translatable text — lines copied verbatim", ct);
            await LogAsync(db, LogLevelKind.Info, "chunkCompleted", "chunk", chunk.Id,
                $"Chunk {chunk.ChunkIndex + 1} completed with no translation — no translatable text (lines copied verbatim)",
                new { jobId = job.Id, chunkIndex = chunk.ChunkIndex }, ct);
            await pipeline.UpdateJobProgressAsync(job.Id,
                await pipeline.CountCompletedChunksAsync(job.Id, ct), ct);
            await FinalizeAsync(db, pipeline, job, subtitle, ct);
            return;
        }

        var sourceRowsById = new Dictionary<string, string>();
        foreach (var r in sourceRows)
        {
            if (!sourceRowsById.TryAdd(r.Id, r.Text))
            {
                await pipeline.MarkChunkFailedAsync(chunk.Id, $"Duplicate subtitle id {r.Id} in chunk range", ct);
                return;
            }
        }
        var preamble = Trcnk.FormatAwareChunkPreamble(subtitle.SourceFormat);
        var formattedSource = Trcnk.SrtFormatterForModel(sourceRows);
        var chunkXml = preamble.Length > 0 ? $"{preamble}\n{formattedSource}" : formattedSource;

        var modelRepo = new ModelRepository(db);
        var promptRepo = new PromptRepository(db);

        var translationModels = await modelRepo.GetActiveByRoleAsync(ModelRoleKind.Translation, ct);
        var promptVersions = await promptRepo.GetActiveVersionsByKindAsync(PromptKind.Translation, ct);

        if (translationModels.Count == 0)
        {
            await pipeline.MarkChunkFailedAsync(chunk.Id, "No active translation models configured", ct);
            await LogAsync(db, LogLevelKind.Error, "chunkFailed", "chunk", chunk.Id,
                "Chunk " + chunk.ChunkIndex + " failed: no active translation models configured — add one in the Models page",
                new { subtitleId = chunk.SubtitleId, jobId = chunk.SubtitleJobId }, ct);
            return;
        }
        if (promptVersions.Count == 0)
        {
            await pipeline.MarkChunkFailedAsync(chunk.Id, "No active translation prompt versions configured", ct);
            await LogAsync(db, LogLevelKind.Error, "chunkFailed", "chunk", chunk.Id,
                "Chunk " + chunk.ChunkIndex + " failed: no active translation prompt versions — activate at least one in the Prompts page",
                new { subtitleId = chunk.SubtitleId, jobId = chunk.SubtitleJobId }, ct);
            return;
        }

        var startTime = DateTime.UtcNow;
        logger.LogInformation("Processing chunk {ChunkIndex} of job {JobId} ({Name} → {Lang}) retry={Retry}",
            chunk.ChunkIndex, job.Id, subtitle.Name, targetLang.Name, chunk.RetryCount);

        var validCandidates = new List<ValidCandidate>();

        foreach (var model in translationModels)
        {
            if (IsPaused) return;
            if (await db.Models.AnyAsync(m => m.Id == model.Id && m.DeletedAt == null, ct) == false)
            {
                await LogAsync(db, LogLevelKind.Warning, "chunkCandidate", "chunk", chunk.Id,
                    $"Translation candidate skipped because model was deleted during processing: modelId={model.Id}, chunkId={chunk.Id}",
                    new { modelId = model.Id, modelName = model.Name, chunkId = chunk.Id, jobId = chunk.SubtitleJobId }, ct);
                continue;
            }

            foreach (var promptVersion in promptVersions)
            {
                var attempts = 0;

                while (attempts < config.MaxRetriesPerChunk)
                {
                    if (IsPaused) return;
                    var startMs = DateTime.UtcNow;
                    var promptText = PromptFormatter.FormatTranslationPrompt(
                        promptVersion.PromptText, sourceLang, targetLang, mediaName,
                        mediaItem?.Genres.Count > 0 ? string.Join(", ", mediaItem.Genres) : null,
                        mediaType, chunkXml);

                    try
                    {
                        await promptRepo.CreateOrUpdatePromptStatAsync(promptVersion.PromptId, promptVersion.Id,
                            model.Id, targetLang.Id, requestUp: true, failedUp: false, successUp: false, selectedUp: false, ct);

                        var response = await llm.SendAsync(model, promptText, ct);
                        var content = response.Content;
                        var durationMs = (long)(DateTime.UtcNow - startMs).TotalMilliseconds;

                        var parsed = Trcnk.ParseLLMResponse(content);
                        var placeholderOk = !isAss || (parsed != null && parsed.Rows.All(r =>
                            sourceRowsById.TryGetValue(r.Id, out var src) &&
                            AssTextExtractor.AssPlaceholdersIntact(src, r.Text)));

                        if (parsed != null && Trcnk.ValidateChunkIntegrity(sourceRows, parsed.Rows) && placeholderOk)
                        {
                            var storedRows = isAss
                                ? parsed.Rows.Select(r => new ParsedChunkRow(r.Id,
                                      AssTextExtractor.RestoreAssPlaceholders(r.Text, assRunsById.GetValueOrDefault(r.Id) ?? []))).ToList()
                                : parsed.Rows;

                            var candidateId = await pipeline.CreateOrUpdateCandidateAsync(chunk.Id, model.Id,
                                promptVersion.PromptId, promptVersion.Id,
                                JsonSerializer.Serialize(storedRows.Select(r => new { id = r.Id, text = r.Text })),
                                validationPassed: true, SubtitleChunkCandidateStatus.Completed, durationMs, null, ct);

                            validCandidates.Add(new ValidCandidate(candidateId, model.Id,
                                promptVersion.PromptId, promptVersion.Id, parsed.Rows));

                            await promptRepo.CreateOrUpdatePromptStatAsync(promptVersion.PromptId, promptVersion.Id,
                                model.Id, targetLang.Id, requestUp: false, failedUp: false, successUp: true, selectedUp: false, ct);
                            break;
                        }

                        attempts++;
                        var reason = parsed == null ? "Could not parse XML response"
                            : !placeholderOk ? "ASS placeholder tokens not preserved"
                            : "Chunk integrity validation failed";

                        if (attempts >= config.MaxRetriesPerChunk)
                        {
                            await pipeline.CreateOrUpdateCandidateAsync(chunk.Id, model.Id,
                                promptVersion.PromptId, promptVersion.Id, null, validationPassed: false,
                                SubtitleChunkCandidateStatus.ValidationFailed, durationMs, reason, ct);
                            await promptRepo.CreateOrUpdatePromptStatAsync(promptVersion.PromptId, promptVersion.Id,
                                model.Id, targetLang.Id, requestUp: false, failedUp: true, successUp: false, selectedUp: false, ct);
                            logger.LogInformation(
                                "Candidate (model={Model}, prompt={Prompt}) validation failed after {Attempts} attempts: {Reason}",
                                model.Name, promptVersion.Id, attempts, reason);
                            break;
                        }
                        logger.LogInformation(
                            "Retrying candidate (model={Model}, prompt={Prompt}) attempt {Next}/{Max}: {Reason}",
                            model.Name, promptVersion.Id, attempts + 1, config.MaxRetriesPerChunk, reason);
                    }
                    catch (Exception e)
                    {
                        if (IsPaused || ct.IsCancellationRequested) return;
                        var durationMs = (long)(DateTime.UtcNow - startMs).TotalMilliseconds;
                        var errorSummary = Summarize(e);

                        if (e is RateLimitedException)
                        {
                            await pipeline.CreateOrUpdateCandidateAsync(chunk.Id, model.Id,
                                promptVersion.PromptId, promptVersion.Id, null, validationPassed: false,
                                SubtitleChunkCandidateStatus.Failed, durationMs, $"rate_limited: {errorSummary}", ct);
                            await promptRepo.CreateOrUpdatePromptStatAsync(promptVersion.PromptId, promptVersion.Id,
                                model.Id, targetLang.Id, requestUp: false, failedUp: true, successUp: false, selectedUp: false, ct);
                            logger.LogInformation("Rate limited on model {Model} with prompt {Prompt}: {Error}",
                                model.Name, promptVersion.Id, errorSummary);
                            await LogAsync(db, LogLevelKind.Warning, "rateLimit", "model", model.Id,
                                $"Rate limited during translation using model {model.Name}",
                                new { modelName = model.Name, provider = model.Provider, chunkId = chunk.Id,
                                    subtitleId = chunk.SubtitleId, jobId = chunk.SubtitleJobId,
                                    promptId = promptVersion.PromptId, promptVersionId = promptVersion.Id,
                                    error = errorSummary }, ct);
                            break;
                        }

                        attempts++;
                        if (attempts >= config.MaxRetriesPerChunk)
                        {
                            await pipeline.CreateOrUpdateCandidateAsync(chunk.Id, model.Id,
                                promptVersion.PromptId, promptVersion.Id, null, validationPassed: false,
                                SubtitleChunkCandidateStatus.Failed, durationMs, errorSummary, ct);
                            await promptRepo.CreateOrUpdatePromptStatAsync(promptVersion.PromptId, promptVersion.Id,
                                model.Id, targetLang.Id, requestUp: false, failedUp: true, successUp: false, selectedUp: false, ct);
                            logger.LogError(
                                "Candidate (model={Model}, prompt={Prompt}) failed after {Attempts} attempts: {Error}",
                                model.Name, promptVersion.Id, attempts, errorSummary);
                            await LogAsync(db, LogLevelKind.Error, "chunkFailed", "chunk", chunk.Id,
                                $"Translation candidate failed after {attempts} retries (model {model.Name}, prompt v{promptVersion.Id}): {errorSummary}",
                                new { modelName = model.Name, provider = model.Provider, modelId = model.Id,
                                    chunkId = chunk.Id, subtitleId = chunk.SubtitleId, jobId = chunk.SubtitleJobId,
                                    promptId = promptVersion.PromptId, promptVersionId = promptVersion.Id,
                                    attempts, failureCategory = "model_error", error = errorSummary }, ct);
                            break;
                        }

                        logger.LogInformation(
                            "Retrying candidate (model={Model}, prompt={Prompt}) attempt {Next}/{Max}: {Error}",
                            model.Name, promptVersion.Id, attempts + 1, config.MaxRetriesPerChunk, errorSummary);

                        var backoffMs = Math.Min(30000, 2000 * attempts);
                        logger.LogInformation("Backing off {Seconds}s after model error", backoffMs / 1000);
                        try { await Task.Delay(backoffMs, ct); }
                        catch (OperationCanceledException) { return; }
                        if (IsPaused) return;
                        await LogAsync(db, LogLevelKind.Warning, "chunkCandidate", "chunk", chunk.Id,
                            $"Retrying translation candidate (model_error) — model {model.Name}, attempt {attempts + 1}/{config.MaxRetriesPerChunk}: {errorSummary}",
                            new { modelName = model.Name, provider = model.Provider, modelId = model.Id,
                                chunkId = chunk.Id, subtitleId = chunk.SubtitleId, jobId = chunk.SubtitleJobId,
                                promptId = promptVersion.PromptId, promptVersionId = promptVersion.Id,
                                attempt = attempts + 1, failureCategory = "model_error", error = errorSummary }, ct);
                    }
                }

                if (IsPaused) return;
            }
        }

        if (IsPaused) return;

        if (validCandidates.Count == 0)
        {
            await pipeline.MarkChunkFailedAsync(chunk.Id, "No valid candidates after all retries exhausted", ct);
            await LogAsync(db, LogLevelKind.Error, "chunkFailed", "chunk", chunk.Id,
                $"Chunk {chunk.ChunkIndex} failed: no valid translation candidates produced after {config.MaxRetriesPerChunk} retries per model+prompt",
                new { subtitleId = chunk.SubtitleId, jobId = chunk.SubtitleJobId, chunkIndex = chunk.ChunkIndex,
                    maxRetries = config.MaxRetriesPerChunk }, ct);
            await FinalizeAsync(db, pipeline, job, subtitle, ct);
            return;
        }

        var winner = await JudgeAndSelectAsync(db, pipeline, promptRepo, llm, validCandidates,
            sourceRows, sourceLang, targetLang, mediaName,
            mediaItem?.Genres.Count > 0 ? string.Join(", ", mediaItem.Genres) : null, mediaType,
            config.MaxRetriesPerChunk, chunk, job.Id, ct);
        if (IsPaused) return;

        if (winner == null)
        {
            if (chunk.RetryCount + 1 >= config.MaxRetriesPerChunk)
            {
                await pipeline.MarkChunkFailedAsync(chunk.Id, "Judge failed to select a candidate after max retries", ct);
                await LogAsync(db, LogLevelKind.Error, "chunkFailed", "chunk", chunk.Id,
                    $"Chunk {chunk.ChunkIndex} failed — judge could not select after {config.MaxRetriesPerChunk} retries",
                    new { chunkIndex = chunk.ChunkIndex, jobId = job.Id, subtitleId = chunk.SubtitleId }, ct);
                await FinalizeAsync(db, pipeline, job, subtitle, ct);
            }
            else
            {
                await pipeline.IncrementChunkRetryAsync(chunk.Id, "Judge failed to select a candidate", ct);
            }
            return;
        }

        var chunkDurationMs = (long)(DateTime.UtcNow - startTime).TotalMilliseconds;
        try
        {
            await pipeline.MarkCandidateSelectedAsync(winner.CandidateId, ct);
            await pipeline.SetSelectedCandidateForChunkAsync(chunk.Id, winner.CandidateId,
                winner.JudgeModelId, winner.JudgeReason, chunkDurationMs, ct);
            if (!string.IsNullOrEmpty(winner.JudgePromptText))
            {
                db.JudgeEvaluations.Add(new JudgeEvaluation
                {
                    SubtitleChunkId = chunk.Id,
                    ModelId = winner.JudgeModelId,
                    JudgeInput = winner.JudgePromptText,
                    SelectedCandidateId = winner.CandidateId,
                    JudgeReason = winner.JudgeReason,
                    CreatedAt = DateTime.UtcNow,
                });
                await db.SaveChangesAsync(ct);
            }
            await pipeline.DeleteUnneededCandidatesAsync(chunk.Id, ct);

            var winnerCandidate = validCandidates.FirstOrDefault(c => c.CandidateId == winner.CandidateId);
            if (winnerCandidate != null && await db.Models.AnyAsync(m => m.Id == winnerCandidate.ModelId && m.DeletedAt == null, ct))
            {
                await promptRepo.CreateOrUpdatePromptStatAsync(winnerCandidate.PromptId, winnerCandidate.PromptVersionId,
                    winnerCandidate.ModelId, targetLang.Id, requestUp: false, failedUp: false, successUp: false, selectedUp: true, ct);
            }
        }
        catch (Exception e)
        {
            await LogAsync(db, LogLevelKind.Warning, "chunkFailed", "chunk", chunk.Id,
                $"Chunk {chunk.ChunkIndex + 1} finalization skipped due to error (likely deleted model): {Summarize(e)}",
                new { chunkId = chunk.Id, jobId = job.Id, error = e.ToString() }, ct);
        }

        await LogAsync(db, LogLevelKind.Info, "chunkCompleted", "chunk", chunk.Id,
            $"Chunk {chunk.ChunkIndex + 1} completed for {mediaName}{(mediaType == "series" ? $" S{job.Season}E{job.Episode}" : "")}",
            new { chunkIndex = chunk.ChunkIndex, jobId = job.Id, judgeReason = winner.JudgeReason }, ct);

        if (IsPaused) return;

        await pipeline.UpdateJobProgressAsync(job.Id,
            await pipeline.CountCompletedChunksAsync(job.Id, ct), ct);

        await FinalizeAsync(db, pipeline, job, subtitle, ct);
    }


    private record JudgeRunResult(
        string Status, long? CandidateId, long? JudgeModelId, string? Reason);

    private async Task<JudgeRunResult> RunJudgeModelAsync(
        BCookieSubsDbContext db, TranslationLlmClient llm, Model judgeModel, string judgePromptText,
        int maxRetries, List<ValidCandidate> candidates, long chunkId, long jobId, CancellationToken ct)
    {
        var formatRetries = JudgeFormatRetryBudget();
        var attempts = 0;
        var formatFailures = 0;
        for (;;)
        {
            if (attempts >= maxRetries) return new JudgeRunResult("failed", null, null, null);

            var prompt = formatFailures > 0 ? JudgeResponseParser.JudgeRepairPrompt(judgePromptText, formatFailures) : judgePromptText;
            attempts++;

            try
            {
                var response = await llm.SendAsync(judgeModel, prompt, ct);
                var parsed = JudgeResponseParser.ParseJudgeResponse(response.Content);

                if (!parsed.Ok)
                {
                    formatFailures++;
                    await LogAsync(db, LogLevelKind.Warning, "chunkJudge", "chunk", chunkId,
                        $"Judge returned invalid JSON (model {judgeModel.Name}, attempt {attempts}/{maxRetries}): {parsed.Error}",
                        new { judgeModel = judgeModel.Name, judgeModelId = judgeModel.Id, chunkId, jobId,
                            attempt = attempts, failureCategory = "invalid_response",
                            responseSample = response.Content.Length > 200 ? response.Content[..200] : response.Content }, ct);
                    if (formatFailures > formatRetries) return new JudgeRunResult("failed", null, null, null);
                    continue;
                }

                if (parsed.WinnerIndex == -1)
                {
                    await LogAsync(db, LogLevelKind.Warning, "chunkJudge", "chunk", chunkId,
                        $"Judge rejected all candidates (model {judgeModel.Name})",
                        new { judgeModel = judgeModel.Name, judgeModelId = judgeModel.Id, chunkId, jobId,
                            reason = parsed.Reason }, ct);
                    return new JudgeRunResult("rejected", null, null, parsed.Reason);
                }

                if (parsed.WinnerIndex < 0 || parsed.WinnerIndex >= candidates.Count)
                {
                    formatFailures++;
                    await LogAsync(db, LogLevelKind.Warning, "chunkJudge", "chunk", chunkId,
                        $"Judge returned out-of-range index {parsed.WinnerIndex} (model {judgeModel.Name}, {candidates.Count} candidates)",
                        new { judgeModel = judgeModel.Name, judgeModelId = judgeModel.Id, chunkId, jobId,
                            winnerIndex = parsed.WinnerIndex, total = candidates.Count,
                            failureCategory = "out_of_range_index" }, ct);
                    if (formatFailures > formatRetries) return new JudgeRunResult("failed", null, null, null);
                    continue;
                }

                return new JudgeRunResult("selected", candidates[parsed.WinnerIndex].CandidateId, judgeModel.Id,
                    parsed.Reason ?? $"Selected candidate {parsed.WinnerIndex}");
            }
            catch (Exception e)
            {
                var errorSummary = Summarize(e);
                if (ct.IsCancellationRequested) return new JudgeRunResult("failed", null, null, null);
                await LogAsync(db, LogLevelKind.Error, "chunkFailed", "chunk", chunkId,
                    $"Judge call failed (model {judgeModel.Name}, attempt {attempts}/{maxRetries}, model_error): {errorSummary}",
                    new { judgeModel = judgeModel.Name, judgeModelId = judgeModel.Id, provider = judgeModel.Provider,
                        chunkId, jobId, attempt = attempts, failureCategory = "model_error", error = errorSummary }, ct);
                if (attempts >= maxRetries) return new JudgeRunResult("failed", null, null, null);
            }
        }
    }

    private sealed record JudgeWinner(
        long CandidateId, long? JudgeModelId, string JudgeReason, string JudgePromptText);

    private async Task<JudgeWinner?> JudgeAndSelectAsync(
        BCookieSubsDbContext db, SubtitlePipelineRepository pipeline, PromptRepository promptRepo,
        TranslationLlmClient llm, List<ValidCandidate> candidates, List<ParsedChunkRow> sourceRows,
        Language sourceLang, Language targetLang, string mediaName, string? genres, string mediaType,
        int maxRetries, SubtitleChunk chunk, long jobId, CancellationToken ct)
    {
        if (candidates.Count == 1)
        {
            return new JudgeWinner(candidates[0].CandidateId, null, "Only candidate", "");
        }

        var judgePromptVersion = await promptRepo.GetActiveVersionByKindAsync(PromptKind.Judge, ct);
        var judgeModels = await new ModelRepository(db).GetActiveByRoleAsync(ModelRoleKind.Judge, ct);

        if (judgePromptVersion == null || judgeModels.Count == 0)
        {
            await LogAsync(db, LogLevelKind.Info, "chunkJudge", "chunk", chunk.Id,
                "No judge configured — using first valid candidate", new { jobId }, ct);
            return new JudgeWinner(candidates[0].CandidateId, null, "No judge configured", "");
        }

        var judgeModel = judgeModels[0];
        var sourceChunkXml = Trcnk.SrtFormatterForModel(sourceRows);
        var judgePromptText = PromptFormatter.FormatJudgePrompt(
            judgePromptVersion.PromptText, sourceLang, targetLang, mediaName, sourceChunkXml,
            genres, mediaType,
            candidates.Select((c, i) => (i, c.Rows)).ToList());

        var runResult = await RunJudgeModelAsync(db, llm, judgeModel, judgePromptText, maxRetries,
            candidates, chunk.Id, jobId, ct);

        if (runResult.Status == "selected")
        {
            return new JudgeWinner(runResult.CandidateId!.Value, runResult.JudgeModelId!.Value,
                runResult.Reason ?? "", judgePromptText);
        }

        var fallbackModels = await new ModelRepository(db).GetActiveByRoleAsync(ModelRoleKind.FallbackJudge, ct);
        if (fallbackModels.Count > 0)
        {
            var why = runResult.Status == "rejected" ? "rejected all candidates" : "failed";
            await LogAsync(db, LogLevelKind.Info, "chunkJudge", "chunk", chunk.Id,
                $"Primary judge {why} (model {judgeModel.Name}) — falling back to {fallbackModels[0].Name}",
                new { primaryJudgeModel = judgeModel.Name, primaryJudgeModelId = judgeModel.Id,
                    fallbackJudgeModel = fallbackModels[0].Name, fallbackJudgeModelId = fallbackModels[0].Id, jobId }, ct);

            var fallbackResult = await RunJudgeModelAsync(db, llm, fallbackModels[0], judgePromptText,
                maxRetries, candidates, chunk.Id, jobId, ct);
            if (fallbackResult.Status == "selected")
            {
                await LogAsync(db, LogLevelKind.Info, "chunkJudge", "chunk", chunk.Id,
                    $"Fallback judge selected candidate (model {fallbackModels[0].Name})",
                    new { fallbackJudgeModel = fallbackModels[0].Name, fallbackJudgeModelId = fallbackModels[0].Id, jobId }, ct);
                return new JudgeWinner(fallbackResult.CandidateId!.Value, fallbackResult.JudgeModelId!.Value,
                    $"[fallback judge] {fallbackResult.Reason}", judgePromptText);
            }
            await LogAsync(db, LogLevelKind.Warning, "chunkFailed", "chunk", chunk.Id,
                $"Fallback judge also failed (model {fallbackModels[0].Name})",
                new { fallbackJudgeModel = fallbackModels[0].Name, fallbackJudgeModelId = fallbackModels[0].Id, jobId }, ct);
        }

        // The judge could not pick a winner: fall back to the first structurally
        // valid candidate so the chunk completes; the fallback stays visible in
        // the chunk's judgeReason.
        var judgeDetail = runResult.Status == "rejected"
            ? string.IsNullOrEmpty(runResult.Reason)
                ? "judge rejected all candidates"
                : $"judge rejected all candidates: {runResult.Reason}"
            : "judge failed after its retry budget";
        await LogAsync(db, LogLevelKind.Warning, "chunkJudge", "chunk", chunk.Id,
            $"No judge selection — using first valid candidate ({judgeDetail})", new { jobId }, ct);
        return new JudgeWinner(candidates[0].CandidateId, null,
            $"Fallback: {judgeDetail} — using first valid candidate", judgePromptText);
    }

    // ── Finalization + infrastructure ───────────────────────────────────────

    private async Task FinalizeAsync(
        BCookieSubsDbContext db, SubtitlePipelineRepository pipeline, SubtitleJob job,
        Subtitle subtitle, CancellationToken ct)
    {
        var assembly = new TranslationAssemblyService(db, pipeline,
            new ApplicationLogRepository(db), new LibrarySubtitleExportService(db,
                new ApplicationConfigRepository(db), new ExportedSubtitleFileRepository(db),
                new LibraryFileSystemFactory(new SecretsService(db,
                    Options.Create(new SecretEncryptionOptions()),
                    Microsoft.Extensions.Logging.Abstractions.NullLogger<SecretsService>.Instance)),
                new ApplicationLogRepository(db)), _dashboardEvents);
        await assembly.CheckAndFinalizeJobAsync(job, subtitle, ct);
    }

    private async Task ReleaseRunningChunkAsync(CancellationToken ct)
    {
        long? running;
        lock (_gate) running = _runningChunkId;
        if (running == null) return;
        lock (_gate) _runningChunkId = null;

        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
            await new SubtitlePipelineRepository(db).ReleaseRunningChunksAsync([running.Value], ct);
            var released = await db.SubtitleChunks.FirstOrDefaultAsync(c => c.Id == running.Value, ct);
            if (released != null) _dashboardEvents.TranslationChanged(released.SubtitleId);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Failed to release running chunk {ChunkId}", running.Value);
        }
    }

    private async Task MaybeDeleteExpiredLogsAsync(BCookieSubsDbContext db, ApplicationConfig config, CancellationToken ct)
    {
        if (DateTime.UtcNow - _lastLogCleanup < LogCleanupInterval) return;
        _lastLogCleanup = DateTime.UtcNow;
        try
        {
            if (!config.LogRetentionEnabled) return;
            await new ApplicationLogRepository(db)
                .PurgeOlderThanAsync(DateTime.UtcNow.AddDays(-config.LogRetentionDays), ct);
        }
        catch (Exception)
        {
        }
    }

    private static int JudgeFormatRetryBudget()
    {
        var raw = Environment.GetEnvironmentVariable("JUDGE_FORMAT_RETRIES");
        if (raw != null && int.TryParse(raw, out var n) && n >= 0) return n;
        return JudgeFormatRetriesDefault;
    }

    private static string Summarize(Exception e) =>
        e.Message.Length > 200 ? e.Message[..200] : e.Message;

    private async Task LogWorkerStateAsync(BCookieSubsDbContext db, LogLevelKind level, string message,
        object? metadata, CancellationToken ct)
    {
        try
        {
            var log = new ApplicationLog
            {
                Level = level,
                Type = "workerState",
                EntityType = "worker",
                Message = message,
                Metadata = metadata is null ? null : JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            };
            await new ApplicationLogRepository(db).AddAsync(log, ct);
            _dashboardEvents.LogAdded(log.Id);
        }
        catch (Exception)
        {
        }
    }

    private async Task LogAsync(BCookieSubsDbContext db, LogLevelKind level, string type, string entityType,
        long entityId, string message, object? metadata, CancellationToken ct)
    {
        try
        {
            var log = new ApplicationLog
            {
                Level = level,
                Type = type,
                EntityType = entityType,
                EntityId = entityId,
                Message = message,
                Metadata = metadata is null ? null : JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            };
            await new ApplicationLogRepository(db).AddAsync(log, ct);
            _dashboardEvents.LogAdded(log.Id);
        }
        catch (Exception)
        {
        }
    }
}