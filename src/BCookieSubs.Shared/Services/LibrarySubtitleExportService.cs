using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Services.Storage;
using BCookieSubs.Shared.Services.Translation;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Services;

public record ExportOptions(bool IncludeOriginal = true, bool IncludeTranslated = true, bool MarkCompleted = true);

public partial class LibrarySubtitleExportService(
    BCookieSubsDbContext db,
    ApplicationConfigRepository config,
    ExportedSubtitleFileRepository exportedFiles,
    ILibraryFileSystemFactory fsFactory,
    ApplicationLogRepository logs)
{
    public async Task ExportSubtitleToLibraryFolderAsync(
        Subtitle subtitle, ExportOptions opts, CancellationToken ct = default)
    {
        if (subtitle.LibraryPathItemId == null) return;

        var item = await db.LibraryPathItems.FirstOrDefaultAsync(i => i.Id == subtitle.LibraryPathItemId.Value, ct);
        if (item == null) return;
        if (await db.LibraryPathItemBlacklist.AnyAsync(b => b.LibraryPathItemId == item.Id, ct)) return;

        var libraryPath = await db.LibraryPaths.FirstOrDefaultAsync(p => p.Id == item.LibraryPathId, ct);
        if (libraryPath == null || !libraryPath.AutoExtract) return;
        await using var fs = await fsFactory.CreateAsync(libraryPath, ct);

        var sourceBaseRaw = Path.GetFileName(item.Path);
        var dot = sourceBaseRaw.LastIndexOf('.');
        if (dot > 0) sourceBaseRaw = sourceBaseRaw.Substring(0, dot);
        var sourceBase = IllegalChars().Replace(sourceBaseRaw, "").Trim();

        var outputDir = Path.GetDirectoryName(item.Path);
        if (string.IsNullOrEmpty(outputDir) || !await fs.ExistsAsync(outputDir, ct)) return;

        var ext = SubtitleExport.SubtitleExportExtension(subtitle.SourceFormat);
        var appConfig = await config.GetAsync(ct);
        var isWhisperSource = subtitle.Source == SubtitleSourceKind.Whisper;

        string? lastExportName = null;
        var anyExported = false;

        // Original-language subtitle (e.g. the Whisper-generated transcript).
        if (opts.IncludeOriginal && !string.IsNullOrEmpty(subtitle.OriginalText))
        {
            var srcCode = "original";
            var srcLang = subtitle.SourceLanguageId != 0
                ? await db.Languages.FirstOrDefaultAsync(l => l.Id == subtitle.SourceLanguageId, ct)
                : null;
            if (srcLang != null) srcCode = srcLang.Iso639.ToLowerInvariant();

            var origName = $"{sourceBase}.{srcCode}{ext}";
            var origPath = Path.Combine(outputDir, origName);

            if (await fs.ExistsAsync(origPath, ct))
            {
                lastExportName = origName;
            }
            else
            {
                try
                {
                    var origContent = SubtitleExport.FinalizeSubtitleForOutput(
                        subtitle.OriginalText, subtitle.SourceFormat, srcCode,
                        srcLang?.Name ?? "", appConfig?.ThaiAssFont);
                    await fs.WriteTextAsync(origPath, origContent, ct);
                    lastExportName = origName;
                    anyExported = true;
                    await exportedFiles.UpsertAsync(new ExportedSubtitleFile
                    {
                        LibraryPathId = item.LibraryPathId,
                        Path = origPath,
                        SubtitleId = subtitle.Id,
                        IsWhisper = isWhisperSource,
                    }, ct);
                    await LogAsync(LogLevelKind.Info, item.Id,
                        $"Exported original subtitle to {origName}",
                        new { exportPath = origPath, exportName = origName, subtitleId = subtitle.Id }, ct);
                }
                catch (Exception e)
                {
                    await LogAsync(LogLevelKind.Error, item.Id,
                        $"Failed to export original subtitle \"{origName}\": {e.Message}",
                        new { exportPath = origPath, exportName = origName, subtitleId = subtitle.Id, error = e.ToString() }, ct);
                }
            }
        }

        // One file per completed target language.
        if (opts.IncludeTranslated)
        {
            var completedJobs = await db.SubtitleJobs
                .AsNoTracking()
                .Where(j => j.SubtitleId == subtitle.Id &&
                            j.Status == SubtitleJobStatus.Completed && j.TranslatedText != null)
                .ToListAsync(ct);

            foreach (var job in completedJobs)
            {
                var lang = await db.Languages.FirstOrDefaultAsync(l => l.Id == job.TargetLanguageId, ct);
                if (lang == null) continue;

                var langCode = lang.Iso639.ToLowerInvariant();
                var exportName = $"{sourceBase}.{langCode}{ext}";
                var exportPath = Path.Combine(outputDir, exportName);

                if (await fs.ExistsAsync(exportPath, ct))
                {
                    lastExportName = exportName;
                    continue;
                }

                try
                {
                    var content = SubtitleExport.FinalizeSubtitleForOutput(
                        job.TranslatedText!, subtitle.SourceFormat, langCode, lang.Name,
                        appConfig?.ThaiAssFont);
                    if (string.IsNullOrWhiteSpace(content))
                    {
                        await LogAsync(LogLevelKind.Error, item.Id,
                            $"Translated content for \"{exportName}\" was empty — not written",
                            new { exportPath, exportName, jobId = job.Id }, ct);
                        continue;
                    }
                    await fs.WriteTextAsync(exportPath, content, ct);
                    lastExportName = exportName;
                    anyExported = true;
                    await exportedFiles.UpsertAsync(new ExportedSubtitleFile
                    {
                        LibraryPathId = item.LibraryPathId,
                        Path = exportPath,
                        SubtitleId = subtitle.Id,
                        IsWhisper = false,
                    }, ct);
                    await LogAsync(LogLevelKind.Info, item.Id,
                        $"Exported translated subtitle to {exportName} ({lang.Name})",
                        new { exportPath, exportName, lang = lang.Name, jobId = job.Id }, ct);
                }
                catch (Exception e)
                {
                    await LogAsync(LogLevelKind.Error, item.Id,
                        $"Failed to export translated subtitle \"{exportName}\" ({lang.Name}): {e.Message}",
                        new { exportPath, exportName, lang = lang.Name, jobId = job.Id, error = e.ToString() }, ct);
                }
            }
        }

        if (lastExportName != null)
        {
            await db.LibraryPathItems.Where(i => i.Id == item.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.ExtractFileName, lastExportName)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        }
        if (opts.MarkCompleted && anyExported)
        {
            await db.LibraryPathItems.Where(i => i.Id == item.Id).ExecuteUpdateAsync(u => u
                .SetProperty(x => x.Status, LibraryPathItemStatus.Completed)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        }
    }

    /// <summary>
    /// Export sweep over subtitles with at least one completed job tied to a
    /// library item, run at the end of a scan.
    /// </summary>
    public async Task AutoExtractItemsAsync(CancellationToken ct = default)
    {
        var rows = await db.Subtitles
            .Where(s => s.LibraryPathItemId != null &&
                        s.DeletedAt == null &&
                        db.SubtitleJobs.Any(j => j.SubtitleId == s.Id && j.Status == SubtitleJobStatus.Completed))
            .Select(s => new { s.Id, LibraryPathItemId = s.LibraryPathItemId!.Value })
            .Distinct()
            .ToListAsync(ct);

        foreach (var row in rows)
        {
            var subtitle = await db.Subtitles.FirstOrDefaultAsync(s => s.Id == row.Id, ct);
            if (subtitle == null) continue;
            try
            {
                await ExportSubtitleToLibraryFolderAsync(subtitle,
                    new ExportOptions { IncludeOriginal = false, IncludeTranslated = true, MarkCompleted = true }, ct);
            }
            catch (Exception)
            {
            }
        }
    }

    private async Task LogAsync(LogLevelKind level, long itemId, string message, object? metadata, CancellationToken ct)
    {
        try
        {
            await logs.AddAsync(new ApplicationLog
            {
                Level = level,
                Type = "libraryScanner",
                EntityType = "libraryScanner",
                EntityId = itemId,
                Message = message,
                Metadata = metadata is null ? null : System.Text.Json.JsonSerializer.Serialize(metadata),
                CreatedAt = DateTime.UtcNow,
            }, ct);
        }
        catch (Exception)
        {
        }
    }

    [GeneratedRegex(@"[/\\:*?""<>|]")]
    private static partial Regex IllegalChars();
}