using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

[Authorize(Policy = Policies.Prefix + Permissions.CanViewStatistics)]
[Route("stats")]
public class StatsController(
    StatsRepository stats,
    SubtitleRepository subtitles,
    SubtitleJobRepository subtitleJobs,
    LanguageRepository languages) : Controller
{
    [HttpGet]
    public async Task<IActionResult> Index(CancellationToken ct)
    {
        ViewBag.PromptStats = await stats.GetAllPromptStatsAsync(ct);
        ViewBag.Models = await stats.GetModelsStatsAsync(ct);
        ViewBag.Subtitles = await stats.GetSubtitlesWithLangAsync(ct);
        return View();
    }

    [HttpGet("subtitle-data")]
    public async Task<IActionResult> SubtitleData(long subtitleId, CancellationToken ct)
    {
        if (subtitleId <= 0) return BadRequest(new { error = "Missing subtitleId" });
        var subtitle = await subtitles.GetAsync(subtitleId, ct);
        if (subtitle == null) return NotFound();

        var jobs = await subtitleJobs.GetBySubtitleAsync(subtitleId, ct);
        var langs = await languages.GetAllAsync(ct);
        var sourceLangName = langs.FirstOrDefault(l => l.Id == subtitle.SourceLanguageId)?.Name ?? "";

        return Json(new
        {
            subtitle = new { subtitle.Id, subtitle.Name },
            jobs = jobs.Select(j => new
            {
                j.Id, TargetLangId = j.TargetLanguageId,
                TargetLangName = langs.FirstOrDefault(l => l.Id == j.TargetLanguageId)?.Name
                                 ?? j.TargetLanguageId.ToString(),
                j.ChunkSetting,
                Status = EnumText.Snake(j.Status),
            }),
            sourceLangName,
        });
    }

    [HttpGet("job-data")]
    public async Task<IActionResult> JobData(long jobId, CancellationToken ct)
    {
        if (jobId <= 0) return BadRequest(new { error = "Missing jobId" });
        var job = await subtitleJobs.GetAsync(jobId, ct);
        if (job == null) return NotFound();

        var subtitle = await subtitles.GetAsync(job.SubtitleId, ct);
        var langs = await languages.GetAllAsync(ct);
        var sourceLangName = langs.FirstOrDefault(l => l.Id == subtitle?.SourceLanguageId)?.Name ?? "";
        var targetLangName = langs.FirstOrDefault(l => l.Id == job.TargetLanguageId)?.Name ?? "";
        var chunks = await stats.GetJobChunkStatsDataAsync(jobId, ct);

        return Json(new
        {
            job = new
            {
                job.Id, job.ChunkSetting, ChunkSizeTotal = job.TotalChunks,
                Status = EnumText.Snake(job.Status),
            },
            subtitle = subtitle == null ? null : new { subtitle.Id, subtitle.Name },
            sourceLangName,
            targetLangName,
            chunks,
        });
    }

    [HttpGet("model-data")]
    public async Task<IActionResult> ModelData(long modelId, CancellationToken ct)
    {
        if (modelId <= 0) return BadRequest(new { error = "Missing modelId" });
        return Json(await stats.GetModelCandidateStatsAsync(modelId, ct));
    }

    [HttpGet("judge-data")]
    public async Task<IActionResult> JudgeData(long? modelId, int page, CancellationToken ct)
    {
        if (page < 0) page = 0;
        return Json(await stats.GetJudgeEvaluationsAsync(modelId, 30, page * 30, ct));
    }

    [HttpGet("poll")]
    public async Task<IActionResult> Poll(CancellationToken ct) =>
        Json(new { stats = await stats.GetAllPromptStatsAsync(ct) });
}