using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using BCookieSubs.Shared.Common;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services;
using BCookieSubs.Shared.Services.Media;
using BCookieSubs.Shared.Services.Storage;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Worker.Services;

public class ComputeJobDispatcher(
    IServiceScopeFactory scopeFactory,
    WorkerConnectionRegistry registry,
    ComputeRunnerState runnerState,
    IDashboardEventPublisher dashboardEvents,
    ILogger<ComputeJobDispatcher> logger) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan WhisperLease = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan OcrLease = TimeSpan.FromMinutes(5);

    private long? _currentScheduleId;

    private long? _lastWhisperHeadId;

    private readonly HashSet<long> _stagedWhisperJobs = [];

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Tick);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception e)
            {
                logger.LogWarning(e, "Compute job dispatch tick failed");
            }
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BCookieSubsDbContext>();
        var compute = scope.ServiceProvider.GetRequiredService<ComputeJobService>();
        var jobs = scope.ServiceProvider.GetRequiredService<WorkerJobRepository>();
        var subtitles = scope.ServiceProvider.GetRequiredService<SubtitleRepository>();
        var configRepo = scope.ServiceProvider.GetRequiredService<ApplicationConfigRepository>();

        var config = await configRepo.GetAsync(ct);
        if (config == null) return;
        var probe = scope.ServiceProvider.GetRequiredService<MediaProbeService>();
        var fsFactory = scope.ServiceProvider.GetRequiredService<ILibraryFileSystemFactory>();

        await jobs.ReleaseExpiredLeasesAsync(DateTime.UtcNow, ct);

        await SweepStagedWhisperAsync(db, ct);

        var schedules = new ScheduleRepository(db);
        var decision = await TranslationScheduleWindow.GetShouldRunNowAsync(schedules, _currentScheduleId, ct);
        if (decision.ShouldRun) _currentScheduleId = decision.SelectedSchedule?.Id;

        var whisperAllowed = config.WhisperEnabled && !runnerState.WhisperPaused;
        if (whisperAllowed)
            await ManageWhisperQueueAsync(compute, jobs, db, config.WhisperRunAsSeparateTask, decision.ShouldRun, ct);

        if (decision.ShouldRun && (whisperAllowed || !runnerState.OcrPaused))
            await DispatchToSessionsAsync(db, compute, jobs, subtitles, config, probe, fsFactory, ct);
    }

    private async Task ManageWhisperQueueAsync(
        ComputeJobService compute, WorkerJobRepository jobs, BCookieSubsDbContext db,
        bool separateTask, bool scheduleAllows, CancellationToken ct)
    {
        var head = await compute.GetNextWhisperSubtitleAsync(separateTask, ct);
        if (head == null) return;

        if (head.Id != _lastWhisperHeadId)
        {
            _lastWhisperHeadId = head.Id;
            dashboardEvents.WhisperQueueChanged(head.Id);
        }

        var running = await db.WorkerJobs.AsNoTracking()
            .Where(j => j.JobType == ComputeJobService.WhisperJobType &&
                        j.Status == WorkerJobStatus.Running && j.ClaimedByWorkerId != null)
            .ToListAsync(ct);
        foreach (var job in running.Where(j => j.SubjectId != head.Id))
        {
            var session = registry.GetForWorker(job.ClaimedByWorkerId!.Value);
            if (session != null)
            {
                try
                {
                    await session.SendAsync(new ServerMessage
                    {
                        JobCancel = new JobCancel { JobId = job.Id, Reason = "whisper queue head changed" }
                    }, ct);
                }
                catch (Exception)
                {
                }
            }

            await jobs.RequeueUntilAsync(job.Id, DateTime.UtcNow + WhisperLease, ct);
        }

        if (scheduleAllows)
            await compute.EnsureWhisperJobAsync(head, ct);
    }

    private async Task DispatchToSessionsAsync(
        BCookieSubsDbContext db, ComputeJobService compute, WorkerJobRepository jobs,
        SubtitleRepository subtitles, ApplicationConfig config, MediaProbeService probe,
        ILibraryFileSystemFactory fsFactory, CancellationToken ct)
    {
        foreach (var session in registry.Snapshot())
        {
            if (!session.Ready || session.WorkerId <= 0) continue;

            var node = await db.WorkerNodes.AsNoTracking()
                .FirstOrDefaultAsync(n => n.Id == session.WorkerId, ct);
            if (node is not { Enabled: true } || node.Draining) continue;

            var maxConcurrency = Math.Min(
                session.MaxConcurrency > 0 ? session.MaxConcurrency : node.MaxConcurrency,
                node.MaxConcurrency > 0 ? node.MaxConcurrency : session.MaxConcurrency);
            if (session.ActiveJobs >= maxConcurrency) continue;

            var caps = node.AllowedCapabilities
                .Where(node.ReportedCapabilities.Contains)
                .ToHashSet();

            foreach (var cap in new[] { CapabilityNames.Whisper, CapabilityNames.Ocr })
            {
                if (session.ActiveJobs >= maxConcurrency) break;
                if (!caps.Contains(cap)) continue;
                if (cap == CapabilityNames.Whisper && runnerState.WhisperPaused) continue;
                if (cap == CapabilityNames.Ocr && runnerState.OcrPaused) continue;

                var jobType = cap == CapabilityNames.Whisper
                    ? ComputeJobService.WhisperJobType
                    : ComputeJobService.OcrJobType;
                var lease = cap == CapabilityNames.Whisper ? WhisperLease : OcrLease;

                WorkerJob? claimed;
                try
                {
                    claimed = await jobs.ClaimNextAsync(jobType, cap, node.Id, lease, ct);
                }
                catch (Exception e)
                {
                    logger.LogWarning(e, "Claim failed for {JobType}", jobType);
                    break;
                }
                if (claimed == null) continue;

                if (claimed.JobType == ComputeJobService.WhisperJobType)
                {
                    if (claimed.SubjectId == null ||
                        await subtitles.GetAsync(claimed.SubjectId.Value, ct) is not { } subtitle)
                    {
                        await jobs.DeleteAsync(claimed.Id, ct);
                        continue;
                    }
                    await subtitles.SetWhisperTranscriptionStateAsync(subtitle.Id,
                        WhisperTranscriptionState.Transcribing, ct);
                    dashboardEvents.WhisperQueueChanged(subtitle.Id);
                    claimed.Payload = await compute.BuildWhisperPayloadAsync(subtitle, ct);
                    var stagedMedia = await StageWhisperMediaAsync(db, fsFactory, subtitle, claimed.Id, ct);
                    if (stagedMedia != null)
                    {
                        claimed.Payload = RewriteWhisperMediaPath(claimed.Payload!, stagedMedia);
                        _stagedWhisperJobs.Add(claimed.Id);
                    }
                }
                else
                {
                    var payload = await ResolveOcrSourceAsync(db, compute, jobs, probe, fsFactory, claimed, ct);
                    if (payload == null)
                    {
                        dashboardEvents.OcrQueueChanged(claimed.Id);
                        continue;
                    }
                    claimed.Payload = payload;
                }

                try
                {
                    await session.SendAsync(new ServerMessage
                    {
                        Job = new JobAssignment
                        {
                            JobId = claimed.Id,
                            JobType = claimed.JobType,
                            Payload = claimed.Payload ?? "{}"
                        }
                    }, ct);
                    session.ActiveJobs++;
                    if (claimed.JobType == ComputeJobService.OcrJobType)
                        dashboardEvents.OcrQueueChanged(claimed.Id);
                }
                catch (Exception)
                {
                    await jobs.RequeueAsync(claimed.Id, ct);
                    break;
                }
            }
        }
    }

    private async Task<string?> ResolveOcrSourceAsync(
        BCookieSubsDbContext db, ComputeJobService compute, WorkerJobRepository jobs,
        MediaProbeService probe, ILibraryFileSystemFactory fsFactory, WorkerJob claimed, CancellationToken ct)
    {
        var input = TryDeserialize<OcrJobInput>(claimed.Payload);
        if (input == null || input.ItemId <= 0)
        {
            await compute.FailOcrJobDuringResolutionAsync(claimed, "Stored job input is invalid", ct);
            await jobs.DeleteAsync(claimed.Id, ct);
            return null;
        }

        var item = await db.LibraryPathItems.AsNoTracking()
            .FirstOrDefaultAsync(i => i.Id == input.ItemId, ct);
        var libraryPath = item == null
            ? null
            : await db.LibraryPaths.AsNoTracking().FirstOrDefaultAsync(p => p.Id == item.LibraryPathId, ct);
        var sourceLang = libraryPath == null
            ? null
            : await db.Languages.AsNoTracking().FirstOrDefaultAsync(l => l.Id == libraryPath.SourceLanguageId, ct);
        if (item == null || libraryPath == null || sourceLang == null)
        {
            await compute.FailOcrJobDuringResolutionAsync(claimed, "Item, library path or source language not found", ct);
            await jobs.DeleteAsync(claimed.Id, ct);
            return null;
        }

        await using var fs = await fsFactory.CreateAsync(libraryPath, ct);

        MediaProbeService.ResolvedSrtSource? resolved = null;
        if (input.SourceOverride is { } ovr && ovr.Type == "external" && !string.IsNullOrEmpty(ovr.Path))
        {
            resolved = await fs.ExistsAsync(ovr.Path, ct)
                ? new MediaProbeService.ResolvedSrtSource(ovr.Path, false)
                : null;
        }
        else
        {
            string? stagedVideo = null;
            try
            {
                var hasEmbeddedPref = input.SourceOverride is { } o2 &&
                    (!string.IsNullOrWhiteSpace(o2.Codec) || (o2.TrackId ?? 0) > 0);
                if (!hasEmbeddedPref)
                {
                    var best = LibraryNameParser.SelectBestSrt(
                        await probe.FindCompanionSubtitlesAsync(item.Path, fs), [],
                        sourceLang.Iso639, sourceLang.Name);
                    if (best != null) resolved = new MediaProbeService.ResolvedSrtSource(best, false);
                }
                if (resolved == null)
                {
                    if (fs.IsRemote)
                        stagedVideo = await fs.StageToWorkAsync(item.Path, LibraryStaging.ScanDir(libraryPath.Id), ct);
                    resolved = await probe.ResolveSrtSourceAsync(item.Path, sourceLang.Iso639,
                        sourceLang.Iso6392B, sourceLang.Name, input.SourceOverride?.TrackId,
                        input.SourceOverride?.Codec, ct, fs, stagedVideo);
                }
            }
            finally
            {
                LibraryStaging.SafeDeleteFile(stagedVideo);
            }
        }

        if (resolved == null)
        {
            await compute.FailOcrJobDuringResolutionAsync(claimed, "No usable subtitle source found for item", ct);
            await jobs.DeleteAsync(claimed.Id, ct);
            return null;
        }

        var ext = Path.GetExtension(resolved.Path).ToLowerInvariant();
        if (ext != ".sup" && ext != ".sub")
        {
            var srt = resolved.IsTemp
                ? await File.ReadAllTextAsync(resolved.Path, ct)
                : await fs.ReadTextAsync(resolved.Path, ct);
            await compute.CompleteOcrTextSourceAsync(claimed, srt, ct);
            if (resolved.IsTemp) ExtractTemp.SafeDeleteTempExtract(resolved.Path);
            await jobs.DeleteAsync(claimed.Id, ct);
            return null;
        }

        var staged = resolved.IsTemp || !fs.IsRemote
            ? await StageOcrSourceAsync(resolved.Path, claimed.Id, ct)
            : await StageOcrSourceFromFsAsync(fs, resolved.Path, claimed.Id, ct);
        if (resolved.IsTemp) ExtractTemp.SafeDeleteTempExtract(resolved.Path);
        if (staged == null)
        {
            await compute.FailOcrJobDuringResolutionAsync(claimed, "Could not stage subtitle image for OCR", ct);
            await jobs.DeleteAsync(claimed.Id, ct);
            return null;
        }

        var ocrLang = input.SourceOverride?.OcrLang
            ?? input.SourceLanguageHint
            ?? input.SourceOverride?.Language;
        return JsonSerializer.Serialize(
            new OcrDispatchInput(ext == ".sup" ? "pgs" : "vobsub", staged, ocrLang, input.Name), DispatchJson);
    }

    private static readonly JsonSerializerOptions DispatchJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static T? TryDeserialize<T>(string? json) where T : class
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<T>(json, new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string OcrStagingDir() =>
        Environment.GetEnvironmentVariable("BCOOKIESUBS_OCR_STAGING_DIR") ?? "/work/ocr";

    private static async Task<string?> StageOcrSourceAsync(string source, long jobId, CancellationToken ct)
    {
        var staging = OcrStagingDir();
        try
        {
            Directory.CreateDirectory(staging);
        }
        catch (Exception)
        {
            return null;
        }

        var ext = Path.GetExtension(source).ToLowerInvariant();
        var target = Path.Combine(staging, $"{jobId}{ext}");
        File.Copy(source, target, overwrite: true);
        if (ext == ".sub")
        {
            var idxSibling = Path.ChangeExtension(source, ".idx");
            if (File.Exists(idxSibling))
                File.Copy(idxSibling, Path.ChangeExtension(target, ".idx"), overwrite: true);
            else
            {
                try { File.Delete(target); } catch (IOException) { }
                return null;
            }
        }
        await Task.CompletedTask;
        return target;
    }

    private static async Task<string?> StageOcrSourceFromFsAsync(
        ILibraryFileSystem fs, string source, long jobId, CancellationToken ct)
    {
        var staging = OcrStagingDir();
        try
        {
            Directory.CreateDirectory(staging);
        }
        catch (Exception)
        {
            return null;
        }

        var ext = Path.GetExtension(source).ToLowerInvariant();
        var target = Path.Combine(staging, $"{jobId}{ext}");
        try
        {
            await using var input = await fs.OpenReadAsync(source, ct);
            await using var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
            await input.CopyToAsync(output, ct);
            if (ext == ".sub")
            {
                var idxSibling = Path.ChangeExtension(source, ".idx");
                if (!await fs.ExistsAsync(idxSibling, ct)) return null;
                await using var idxIn = await fs.OpenReadAsync(idxSibling, ct);
                await using var idxOut = new FileStream(
                    Path.ChangeExtension(target, ".idx"), FileMode.Create, FileAccess.Write, FileShare.None);
                await idxIn.CopyToAsync(idxOut, ct);
            }
            return target;
        }
        catch (Exception ex) when (ex is IOException or LibraryConnectionException)
        {
            return null;
        }
    }

    private async Task<string?> StageWhisperMediaAsync(
        BCookieSubsDbContext db, ILibraryFileSystemFactory fsFactory, Subtitle subtitle, long jobId, CancellationToken ct)
    {
        if (subtitle.MediaPath == null) return null;
        var lp = subtitle.LibraryPathItemId == null
            ? null
            : (await db.LibraryPathItems.AsNoTracking()
                    .FirstOrDefaultAsync(i => i.Id == subtitle.LibraryPathItemId.Value, ct))?.LibraryPathId;
        var libraryPath = lp == null
            ? null
            : await db.LibraryPaths.AsNoTracking().FirstOrDefaultAsync(p => p.Id == lp.Value, ct);
        if (libraryPath == null) return null;

        try
        {
            var fs = await fsFactory.CreateAsync(libraryPath, ct);
            await using var _ = fs;
            if (!fs.IsRemote) return null;
            return await fs.StageToWorkAsync(subtitle.MediaPath, LibraryStaging.WhisperDir(jobId), ct);
        }
        catch (Exception ex) when (ex is IOException or LibraryConnectionException)
        {
            logger.LogWarning(ex, "Failed to stage whisper media for job {JobId}: {Path}", jobId, subtitle.MediaPath);
            return null;
        }
    }

    private static string RewriteWhisperMediaPath(string payloadJson, string stagedPath)
    {
        var node = JsonNode.Parse(payloadJson) as JsonObject;
        if (node == null) return payloadJson;
        node["mediaPath"] = stagedPath;
        return node.ToJsonString(DispatchJson);
    }

    private async Task SweepStagedWhisperAsync(BCookieSubsDbContext db, CancellationToken ct)
    {
        if (_stagedWhisperJobs.Count == 0) return;
        var ids = _stagedWhisperJobs.ToList();
        var statuses = await db.WorkerJobs.AsNoTracking()
            .Where(j => ids.Contains(j.Id))
            .Select(j => new { j.Id, j.Status })
            .ToListAsync(ct);
        foreach (var row in statuses)
        {
            if (row.Status is WorkerJobStatus.Queued or WorkerJobStatus.Running) continue;
            LibraryStaging.SafeDeleteDir(LibraryStaging.WhisperDir(row.Id));
            _stagedWhisperJobs.Remove(row.Id);
        }
        var known = statuses.Select(s => s.Id).ToHashSet();
        foreach (var id in ids.Except(known))
        {
            LibraryStaging.SafeDeleteDir(LibraryStaging.WhisperDir(id));
            _stagedWhisperJobs.Remove(id);
        }
    }
}