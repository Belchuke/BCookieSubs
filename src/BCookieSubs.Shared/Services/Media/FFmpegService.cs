using Microsoft.Extensions.Logging;
namespace BCookieSubs.Shared.Services.Media;

public class FFmpegService(ProcessRunnerService runner, ILogger<FFmpegService> logger)
{
    private static readonly TimeSpan ExtractTimeout = TimeSpan.FromSeconds(60);

    public async Task<bool> ExtractSubtitleStreamAsync(
        string videoPath,
        int subtitleIndex,
        string outputPath,
        string? codecName,
        CancellationToken cancellationToken = default)
    {
        var codecFlag = SubtitleFileTypes.IsAssCodec(codecName) ? "copy" : "srt";
        var result = await runner.RunAsync(
            "ffmpeg",
            ["-i", videoPath, "-map", $"0:s:{subtitleIndex}", "-c:s", codecFlag, "-y", outputPath],
            new ProcessRunOptions { Timeout = ExtractTimeout },
            cancellationToken);

        var ok = result.Success && File.Exists(outputPath);
        if (!ok)
        {
            logger.LogDebug("ffmpeg subtitle extraction failed ({Index} of {Path}): {Error}",
                subtitleIndex, videoPath, result.StdErr);
        }
        return ok;
    }
}