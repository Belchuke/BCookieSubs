using Microsoft.Extensions.Logging;
using System.Text.Json;

namespace BCookieSubs.Shared.Services.Media;

public record MkvSubtitleTrack(
    int TrackId,
    string Codec,
    string? Language,
    string? Title,
    bool DefaultTrack,
    int NumIndexEntries,
    string? ImageKind);

public class MkvToolNixService(ProcessRunnerService runner, ILogger<MkvToolNixService> logger)
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan TextExtractTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan VobSubExtractTimeout = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan PgsExtractTimeout = TimeSpan.FromSeconds(180);
    private static readonly TimeSpan PictureCountTimeout = TimeSpan.FromSeconds(180);

    public async Task<List<MkvSubtitleTrack>?> ProbeSubtitleTracksAsync(string videoPath, CancellationToken cancellationToken = default)
    {
        var result = await runner.RunAsync(
            "mkvmerge",
            ["-J", videoPath],
            new ProcessRunOptions { Timeout = ProbeTimeout },
            cancellationToken);

        if (!result.Success || string.IsNullOrWhiteSpace(result.StdOut)) return null;

        try
        {
            using var doc = JsonDocument.Parse(result.StdOut);
            if (!doc.RootElement.TryGetProperty("tracks", out var tracks) || tracks.ValueKind != JsonValueKind.Array)
            {
                return [];
            }

            var list = new List<MkvSubtitleTrack>();
            foreach (var track in tracks.EnumerateArray())
            {
                if (!track.TryGetProperty("type", out var typeEl) || typeEl.GetString() != "subtitles") continue;
                if (!track.TryGetProperty("codec", out var codecEl) || codecEl.ValueKind != JsonValueKind.String) continue;
                var codec = codecEl.GetString()!;

                string? language = null;
                string? trackName = null;
                bool defaultTrack = false;
                int numIndexEntries = 0;
                if (track.TryGetProperty("properties", out var props) && props.ValueKind == JsonValueKind.Object)
                {
                    if (props.TryGetProperty("language", out var langEl) && langEl.ValueKind == JsonValueKind.String) language = langEl.GetString();
                    if (props.TryGetProperty("track_name", out var nameEl) && nameEl.ValueKind == JsonValueKind.String) trackName = nameEl.GetString();
                    if (props.TryGetProperty("default_track", out var defEl) && defEl.ValueKind == JsonValueKind.True) defaultTrack = true;
                    if (props.TryGetProperty("num_index_entries", out var nieEl) && nieEl.ValueKind == JsonValueKind.Number)
                    {
                        numIndexEntries = nieEl.GetInt32();
                    }
                }

                list.Add(new MkvSubtitleTrack(track.GetProperty("id").GetInt32(), codec, language, trackName, defaultTrack, numIndexEntries, null));
            }
            return list;
        }
        catch (JsonException ex)
        {
            logger.LogDebug(ex, "mkvmerge -J produced invalid JSON for {Path}", videoPath);
            return null;
        }
        catch (KeyNotFoundException)
        {
            return null;
        }
    }

    public async Task<bool> ExtractTrackAsync(
        string videoPath, int trackId, string outputPath, CancellationToken cancellationToken = default)
    {
        var timeout = Path.GetExtension(outputPath).Equals(".sup", StringComparison.OrdinalIgnoreCase)
            ? PgsExtractTimeout
            : Path.GetExtension(outputPath).Equals(".sub", StringComparison.OrdinalIgnoreCase)
                ? VobSubExtractTimeout
                : TextExtractTimeout;

        var result = await runner.RunAsync(
            "mkvextract",
            ["tracks", videoPath, $"{trackId}:{outputPath}"],
            new ProcessRunOptions { Timeout = timeout },
            cancellationToken);

        return result.Success && File.Exists(outputPath);
    }

    public async Task<Dictionary<int, int>> CountPicturesBatchAsync(
        string videoPath,
        IReadOnlyList<(int TrackId, string Kind)> tracks,
        Func<string, string?, int> parseCount,
        CancellationToken cancellationToken = default)
    {
        var result = new Dictionary<int, int>();
        if (tracks.Count == 0) return result;

        var temps = new List<(int TrackId, string Kind, string Path, string? IdxPath)>();
        var args = new List<string> { "tracks", videoPath };
        foreach (var (trackId, kind) in tracks)
        {
            var ext = kind == "vobsub" ? ".sub" : ".sup";
            var path = ExtractTemp.MakePath($"count-track-{trackId}", "count", ext);
            temps.Add((trackId, kind, path, kind == "vobsub" ? Path.ChangeExtension(path, ".idx") : null));
            args.Add($"{trackId}:{path}");
        }

        try
        {
            await runner.RunAsync("mkvextract", args, new ProcessRunOptions { Timeout = PictureCountTimeout }, cancellationToken);
            foreach (var (trackId, kind, path, idxPath) in temps)
            {
                try
                {
                    if (kind == "pgs")
                    {
                        if (File.Exists(path)) result[trackId] = PgsSupParser.CountEvents(path);
                    }
                    else if (idxPath != null && File.Exists(idxPath))
                    {
                        result[trackId] = VobSubIdxParser.CountEvents(idxPath);
                    }
                }
                catch
                {
                }
            }
        }
        finally
        {
            foreach (var (_, _, path, idxPath) in temps)
            {
                SafeDelete(path);
                if (idxPath != null) SafeDelete(idxPath);
            }
        }
        return result;
    }

    private const string UnsafeStemChars = "/\\:*?\"<>|";

    private static void SafeDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException)
        {
        }
    }

    public static string SanitizeStem(string stem) =>
        string.Concat(stem.Select(c => UnsafeStemChars.Contains(c) ? '_' : c));
}