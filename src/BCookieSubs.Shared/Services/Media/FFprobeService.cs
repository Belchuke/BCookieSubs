using Microsoft.Extensions.Logging;
using System.Text.Json;

namespace BCookieSubs.Shared.Services.Media;

public record ProbeSubtitleStream(
    int SubtitleIndex,
    string? Language,
    string? Title,
    string? CodecName,
    string? ImageKind);

public class FFprobeService(ProcessRunnerService runner, ILogger<FFprobeService> logger)
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(15);

    public async Task<List<ProbeSubtitleStream>> ProbeSubtitleStreamsAsync(
        string videoPath, CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(
            "ffprobe",
            ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "s", videoPath],
            new ProcessRunOptions { Timeout = ProbeTimeout },
            cancellationToken);

        if (!result.Success || string.IsNullOrWhiteSpace(result.StdOut))
        {
            if (!result.Success) logger.LogDebug("ffprobe failed for {Path}: {Error}", videoPath, result.StdErr);
            return [];
        }

        try
        {
            using var doc = JsonDocument.Parse(result.StdOut);
            if (!doc.RootElement.TryGetProperty("streams", out var streams) || streams.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            var list = new List<ProbeSubtitleStream>();
            var i = 0;
            foreach (var stream in streams.EnumerateArray())
            {
                string? GetString(string name) =>
                    stream.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String ? el.GetString() : null;

                var codecName = GetString("codec_name");
                string? language = null;
                string? title = null;
                if (stream.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Object)
                {
                    if (tags.TryGetProperty("language", out var langEl) && langEl.ValueKind == JsonValueKind.String) language = langEl.GetString();
                    if (tags.TryGetProperty("title", out var titleEl) && titleEl.ValueKind == JsonValueKind.String) title = titleEl.GetString();
                }

                list.Add(new ProbeSubtitleStream(i, language, title, codecName, SubtitleFileTypes.ImageSubtitleKindFromCodec(codecName)));
                i++;
            }
            return list;
        }
        catch (JsonException ex)
        {
            logger.LogDebug(ex, "ffprobe produced invalid JSON for {Path}", videoPath);
            return [];
        }
    }

    public async Task<double?> DetectFpsAsync(string videoPath, CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(
            "ffprobe",
            ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0", videoPath],
            new ProcessRunOptions { Timeout = ProbeTimeout },
            cancellationToken);

        if (!result.Success || string.IsNullOrWhiteSpace(result.StdOut)) return null;

        try
        {
            using var doc = JsonDocument.Parse(result.StdOut);
            if (!doc.RootElement.TryGetProperty("streams", out var streams) || streams.ValueKind != JsonValueKind.Array)
            {
                return null;
            }
            foreach (var stream in streams.EnumerateArray())
            {
                foreach (var prop in new[] { "r_frame_rate", "avg_frame_rate" })
                {
                    if (stream.TryGetProperty(prop, out var el) && el.ValueKind == JsonValueKind.String)
                    {
                        var fps = ParseFrameRate(el.GetString());
                        if (fps is > 0) return fps;
                    }
                }
            }
        }
        catch (JsonException)
        {
        }
        return null;
    }

    public static double? ParseFrameRate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var parts = value.Split('/');
        try
        {
            if (parts.Length == 2)
            {
                var numerator = double.Parse(parts[0].Trim(), System.Globalization.CultureInfo.InvariantCulture);
                var denominator = double.Parse(parts[1].Trim(), System.Globalization.CultureInfo.InvariantCulture);
                return denominator == 0 ? null : numerator / denominator;
            }
            return double.Parse(value.Trim(), System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}