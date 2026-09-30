using Microsoft.Extensions.Logging;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Services.Storage;

namespace BCookieSubs.Shared.Services.Media;

public class MediaProbeService(
    FFprobeService ffprobe,
    FFmpegService ffmpeg,
    MkvToolNixService mkvToolNix,
    ILogger<MediaProbeService> logger)
{

    public async Task<List<string>> FindCompanionSubtitlesAsync(string videoPath, ILibraryFileSystem? fs = null)
    {
        var dir = Path.GetDirectoryName(videoPath);
        if (string.IsNullOrEmpty(dir)) return [];

        var videoNorm = NormalizeCompanionStem(Path.GetFileNameWithoutExtension(videoPath));
        var companions = new List<string>();
        try
        {
            if (fs == null)
            {
                if (!Directory.Exists(dir)) return [];
                foreach (var file in Directory.EnumerateFiles(dir))
                {
                    var ext = Path.GetExtension(file).ToLowerInvariant();
                    if (!SubtitleFileTypes.IsSubtitleExtension(ext)) continue;
                    var stemNorm = NormalizeCompanionStem(Path.GetFileNameWithoutExtension(file));
                    if (stemNorm == videoNorm || stemNorm.StartsWith(videoNorm + ".")) companions.Add(file);
                }
            }
            else
            {
                await foreach (var entry in fs.EnumerateDirectoryEntriesAsync(dir))
                {
                    if (entry.IsDirectory) continue;
                    var ext = Path.GetExtension(entry.Name).ToLowerInvariant();
                    if (!SubtitleFileTypes.IsSubtitleExtension(ext)) continue;
                    var stemNorm = NormalizeCompanionStem(Path.GetFileNameWithoutExtension(entry.Name));
                    if (stemNorm == videoNorm || stemNorm.StartsWith(videoNorm + ".")) companions.Add(entry.FullPath);
                }
            }
        }
        catch (IOException ex)
        {
            logger.LogDebug(ex, "Failed to list directory for {Path}", videoPath);
        }
        catch (LibraryConnectionException ex)
        {
            logger.LogDebug(ex, "Failed to list directory for {Path}", videoPath);
        }
        companions.Sort(StringComparer.OrdinalIgnoreCase);
        return companions;
    }

    public static string NormalizeCompanionStem(string stem) =>
        stem.ToLowerInvariant().Replace(" ", ".").Replace("_", ".").Replace("-", ".");


    public async Task<List<SubtitleSourceCandidate>> ListSubtitleSourcesAsync(
        string videoPath,
        string sourceLangIso639,
        string? sourceLangIso2b = null,
        string sourceLangName = "",
        bool withPictureCounts = true,
        CancellationToken cancellationToken = default,
        ILibraryFileSystem? fs = null,
        string? localVideoPath = null)
    {
        ExtractTemp.EnsureDir();
        var result = new List<SubtitleSourceCandidate>();
        var ext = Path.GetExtension(videoPath).ToLowerInvariant();
        var stem = Path.GetFileNameWithoutExtension(videoPath);
        var ocrLangDefault = OcrLanguageMapper.ResolveOcrLang(sourceLangIso639, sourceLangIso2b, sourceLangName);

        foreach (var srt in await FindCompanionSubtitlesAsync(videoPath, fs))
        {
            var filename = Path.GetFileName(srt);
            var fileExt = SubtitleFileTypes.SubtitleFileExtensionOf(filename) ?? ".srt";
            var isSub = SubtitleFileTypes.IsSubFile(filename);
            var isSup = SubtitleFileTypes.IsSupFile(filename);
            var idxPath = Path.ChangeExtension(srt, ".idx");
            var hasIdx = fs != null ? await fs.ExistsAsync(idxPath, cancellationToken) : File.Exists(idxPath);
            var subKind = isSup
                ? "pgs"
                : isSub
                    ? (hasIdx ? "vobsub" : "text")
                    : null;
            var imageBased = subKind is "vobsub" or "pgs";
            result.Add(new SubtitleSourceCandidate
            {
                Type = "external",
                Path = srt,
                IsTemp = false,
                Label = filename,
                Language = null,
                Codec = fileExt,
                Filename = filename,
                FilenameOnly = filename,
                ImageBased = imageBased,
                RequiresOcr = imageBased,
                OcrLang = imageBased ? ocrLangDefault : null,
                TrackId = null,
                Unsupported = false,
                SubKind = subKind,
                PictureCount = withPictureCounts && imageBased
                    ? await CountExternalPicturesAsync(srt, subKind, fs, cancellationToken)
                    : null,
            });
        }

        var probeVideo = localVideoPath ?? videoPath;
        var embedded = fs is { IsRemote: true } && localVideoPath == null
            ? []
            : await EmbeddedCandidatesAsync(probeVideo, ext, cancellationToken);
        var embeddedImageTracks = embedded
            .Where(t => t.ImageKind is "vobsub" or "pgs")
            .Select(t => (t.TrackId, t.ImageKind!))
            .ToList();
        var embeddedPictureCounts =
            withPictureCounts && ext == ".mkv" && embeddedImageTracks.Count > 0 && embedded.Count > 0
                ? await mkvToolNix.CountPicturesBatchAsync(
                    probeVideo,
                    embeddedImageTracks,
                    CountParsedPictures,
                    cancellationToken)
                : new Dictionary<int, int>();

        foreach (var track in embedded)
        {
            var langTag = track.Language ?? $"track-{track.TrackId}";
            var isImage = track.ImageKind is not null;
            var trackExt = track.ImageKind switch
            {
                "vobsub" => ".sub",
                "pgs" => ".sup",
                _ => SubtitleFileTypes.CodecToSubtitleExt(track.Codec),
            };
            var tempPath = ExtractTemp.MakePath(stem, langTag, trackExt);
            var titlePart = track.Title ?? (isImage ? "untitled image track" : null);
            result.Add(new SubtitleSourceCandidate
            {
                Type = "embedded",
                Path = tempPath,
                IsTemp = true,
                Label = titlePart != null
                    ? $"Embedded · {track.Codec} · {track.Language ?? "unknown"} · {titlePart}"
                    : $"Embedded · {track.Codec} · {track.Language ?? "unknown"}",
                Language = track.Language,
                Codec = track.Codec,
                Filename = null,
                FilenameOnly = $"{stem}.{langTag}{trackExt}",
                ImageBased = isImage,
                RequiresOcr = isImage,
                OcrLang = isImage
                    ? OcrLanguageMapper.ResolveOcrLang(track.Language, sourceLangIso639, sourceLangIso2b, sourceLangName)
                    : null,
                TrackId = track.TrackId,
                Title = track.Title,
                Unsupported = false,
                SubKind = track.ImageKind,
                NumIndexEntries = track.NumIndexEntries,
                PictureCount = isImage && withPictureCounts && embeddedPictureCounts.TryGetValue(track.TrackId, out var count)
                    ? count
                    : null,
            });
        }

        result.Sort((a, b) =>
        {
            var ra = Rank(a);
            var rb = Rank(b);
            if (ra != rb) return ra - rb;
            if (ra == 2) return (b.PictureCount ?? 0) - (a.PictureCount ?? 0);
            return 0;
        });

        var sourceLangLc = (sourceLangIso639 ?? "").ToLowerInvariant();
        var sourceNameLc = (sourceLangName ?? "").ToLowerInvariant();
        var source2bLc = (sourceLangIso2b ?? "").ToLowerInvariant();
        foreach (var candidate in result)
        {
            if (candidate.Type == "embedded" && !string.IsNullOrEmpty(candidate.Language))
            {
                var t = candidate.Language.ToLowerInvariant();
                if ((source2bLc.Length > 0 && t == source2bLc) || t == sourceLangLc ||
                    (sourceNameLc.Length > 0 && t == sourceNameLc))
                {
                    candidate.Label = $"★ {candidate.Label}";
                }
            }
        }
        return result;
    }

    private static int CountParsedPictures(string path, string? kind) =>
        kind switch
        {
            "pgs" => PgsSupParser.CountEvents(path),
            "vobsub" => VobSubIdxParser.CountEvents(Path.ChangeExtension(path, ".idx")),
            _ => 0,
        };

    private static int? CountExternalPictures(string path, string? subKind)
    {
        try
        {
            return subKind == "pgs"
                ? PgsSupParser.CountEvents(path)
                : subKind == "vobsub" && File.Exists(Path.ChangeExtension(path, ".idx"))
                    ? VobSubIdxParser.CountEvents(Path.ChangeExtension(path, ".idx"))
                    : null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    // Remote (SFTP) companions are counted by streaming the file — never by
    // staging the whole subtitle just to count events.
    private static async Task<int?> CountExternalPicturesAsync(
        string path, string? subKind, ILibraryFileSystem? fs, CancellationToken ct)
    {
        if (fs is not { IsRemote: true }) return CountExternalPictures(path, subKind);
        try
        {
            switch (subKind)
            {
                case "pgs":
                {
                    await using var sup = await fs.OpenReadAsync(path, ct);
                    return PgsSupParser.CountEvents(sup);
                }
                case "vobsub" when await fs.ExistsAsync(Path.ChangeExtension(path, ".idx"), ct):
                {
                    await using var idx = await fs.OpenReadAsync(Path.ChangeExtension(path, ".idx"), ct);
                    return VobSubIdxParser.CountEvents(idx);
                }
                default:
                    return null;
            }
        }
        catch (Exception ex) when (ex is IOException or LibraryConnectionException)
        {
            return null;
        }
    }

    private static int Rank(SubtitleSourceCandidate r)
    {
        if (r.Unsupported == true) return 3;
        if (r.RequiresOcr == true || r.ImageBased == true) return 2;
        return r.Type == "external" ? 0 : 1;
    }

    // ── Embedded track discovery ───────────────────────────────────────────

    /// <summary>
    /// Extract the best embedded subtitle track to a temp file (scan path).
    /// MKV: language-matching text track,
    /// default-flag first then index entries; image tracks only when no text
    /// track exists (densest first). Other containers: ffmpeg text streams,
    /// title matching included.
    /// </summary>
    public async Task<string?> ExtractBestEmbeddedSrtAsync(
        string videoPath,
        string sourceIso1,
        string? sourceIso2b,
        string langName,
        long? preferTrackId = null,
        string? preferCodec = null,
        CancellationToken ct = default)
    {
        ExtractTemp.EnsureDir();
        var ext = Path.GetExtension(videoPath).ToLowerInvariant();
        var stem = Path.GetFileNameWithoutExtension(videoPath);
        var preferKind = preferCodec != null
            ? SubtitleFileTypes.ImageSubtitleKindFromCodec(preferCodec)
            : null;

        bool TrackLangMatches(string? trackLang)
        {
            if (trackLang == null) return false;
            var t = trackLang.ToLowerInvariant();
            if (sourceIso2b != null && t == sourceIso2b.ToLowerInvariant()) return true;
            return t == sourceIso1.ToLowerInvariant();
        }

        if (ext == ".mkv")
        {
            var all = await mkvToolNix.ProbeSubtitleTracksAsync(videoPath, ct);
            if (all != null)
            {
                var textTracks = all
                    .Where(t => SubtitleFileTypes.ImageSubtitleKindFromCodec(t.Codec) == null &&
                                SubtitleFileTypes.MkvTextCodecs.Contains(t.Codec))
                    .ToList();
                var imageTracks = all
                    .Select(t => (Track: t, Kind: SubtitleFileTypes.ImageSubtitleKindFromCodec(t.Codec)))
                    .Where(x => x.Kind != null)
                    .ToList();

                if (preferKind == "vobsub" ||
                    (preferTrackId != null &&
                     imageTracks.Any(x => x.Track.TrackId == preferTrackId.Value && x.Kind == "vobsub")))
                {
                    var target = imageTracks.FirstOrDefault(x => x.Kind == "vobsub" &&
                        (preferTrackId == null || x.Track.TrackId == preferTrackId.Value)).Track;
                    if (target != null)
                    {
                        var tag = target.Language ?? $"sub{target.TrackId}";
                        var outputPath = ExtractTemp.MakePath(stem, tag, ".sub");
                        if (await mkvToolNix.ExtractTrackAsync(videoPath, target.TrackId, outputPath, ct))
                        {
                            return outputPath;
                        }
                    }
                    return null;
                }

                if (preferKind == "pgs" ||
                    (preferTrackId != null &&
                     imageTracks.Any(x => x.Track.TrackId == preferTrackId.Value && x.Kind == "pgs")))
                {
                    var target = imageTracks.FirstOrDefault(x => x.Kind == "pgs" &&
                        (preferTrackId == null || x.Track.TrackId == preferTrackId.Value)).Track;
                    if (target != null)
                    {
                        var tag = target.Language ?? $"sub{target.TrackId}";
                        var outputPath = ExtractTemp.MakePath(stem, tag, ".sup");
                        if (await mkvToolNix.ExtractTrackAsync(videoPath, target.TrackId, outputPath, ct))
                        {
                            return outputPath;
                        }
                    }
                    return null;
                }

                if (textTracks.Count == 0)
                {
                    if (imageTracks.Count > 0)
                    {
                        var langMatch = imageTracks.Where(x => TrackLangMatches(x.Track.Language)).ToList();
                        var pool = langMatch.Count > 0 ? langMatch : imageTracks;
                        var sorted = pool
                            .OrderByDescending(x => x.Track.NumIndexEntries)
                            .ThenBy(x => x.Track.DefaultTrack ? 0 : 1)
                            .ThenBy(x => x.Track.TrackId);
                        foreach (var (track, kind) in sorted)
                        {
                            var tag = track.Language ?? $"sub{track.TrackId}";
                            var outputPath = ExtractTemp.MakePath(stem, tag, kind == "pgs" ? ".sup" : ".sub");
                            if (await mkvToolNix.ExtractTrackAsync(videoPath, track.TrackId, outputPath, ct))
                            {
                                return outputPath;
                            }
                        }
                    }
                    return null;
                }

                var textLangMatch = textTracks.Where(t => TrackLangMatches(t.Language)).ToList();
                var textPool = textLangMatch.Count > 0 ? textLangMatch : textTracks;
                var textSorted = textPool
                    .OrderBy(t => t.DefaultTrack ? 0 : 1)
                    .ThenByDescending(t => t.NumIndexEntries);
                foreach (var track in textSorted)
                {
                    if (preferTrackId != null && track.TrackId != preferTrackId.Value) continue;
                    var tag = track.Language ?? $"sub{track.TrackId}";
                    var outputPath = ExtractTemp.MakePath(stem, tag, SubtitleFileTypes.CodecToSubtitleExt(track.Codec));
                    if (await mkvToolNix.ExtractTrackAsync(videoPath, track.TrackId, outputPath, ct))
                    {
                        return outputPath;
                    }
                }
                return null;
            }
        }

        var streams = (await ffprobe.ProbeSubtitleStreamsAsync(videoPath, ct))
            .Where(s => SubtitleFileTypes.ImageSubtitleKindFromCodec(s.CodecName) == null &&
                        SubtitleFileTypes.FfmpegTextCodecs.Contains(s.CodecName ?? ""))
            .ToList();
        if (preferKind is not null) return null;
        if (streams.Count == 0) return null;

        var lowerName = langName.ToLowerInvariant();
        var lowerIso = sourceIso1.ToLowerInvariant();
        var lower2b = sourceIso2b?.ToLowerInvariant();
        var match = streams.Where(s =>
        {
            if (TrackLangMatches(s.Language)) return true;
            var title = s.Title?.ToLowerInvariant() ?? "";
            return title.Contains(lowerIso) ||
                   (lower2b != null && title.Contains(lower2b)) ||
                   title.Contains(lowerName);
        }).ToList();
        var streamPool = match.Count > 0 ? match : streams;
        if (preferTrackId != null)
            streamPool = streamPool.Where(s => s.SubtitleIndex == preferTrackId.Value).ToList();

        foreach (var stream in streamPool)
        {
            var tag = stream.Language ?? $"sub{stream.SubtitleIndex}";
            var outputPath = ExtractTemp.MakePath(stem, tag, SubtitleFileTypes.CodecToSubtitleExt(stream.CodecName));
            if (await ffmpeg.ExtractSubtitleStreamAsync(videoPath, stream.SubtitleIndex, outputPath, stream.CodecName, ct))
            {
                return outputPath;
            }
        }
        return null;
    }

    private sealed record EmbeddedCandidate(
        int TrackId, string? Language, string Codec, string? ImageKind, string? Title, int NumIndexEntries);

    /// <summary>mkvmerge first for .mkv (image tracks have real metadata); ffprobe otherwise/fallback.</summary>
    private async Task<List<EmbeddedCandidate>> EmbeddedCandidatesAsync(
        string videoPath, string ext, CancellationToken cancellationToken)
    {
        var outList = new List<EmbeddedCandidate>();
        if (ext == ".mkv")
        {
            var tracks = await mkvToolNix.ProbeSubtitleTracksAsync(videoPath, cancellationToken);
            if (tracks != null)
            {
                foreach (var t in tracks)
                {
                    var kind = SubtitleFileTypes.ImageSubtitleKindFromCodec(t.Codec);
                    if (kind == null && !SubtitleFileTypes.MkvTextCodecs.Contains(t.Codec)) continue;
                    outList.Add(new EmbeddedCandidate(t.TrackId, t.Language, t.Codec, kind, t.Title, t.NumIndexEntries));
                }
                return outList;
            }
        }

        foreach (var s in await ffprobe.ProbeSubtitleStreamsAsync(videoPath, cancellationToken))
        {
            outList.Add(s.ImageKind == null
                ? new EmbeddedCandidate(s.SubtitleIndex, s.Language, s.CodecName ?? "embedded", null, s.Title, 0)
                : new EmbeddedCandidate(s.SubtitleIndex, s.Language, s.CodecName ?? s.ImageKind, s.ImageKind, s.Title, 0));
        }
        return outList;
    }

    // Source resolution: an explicit track/codec preference goes straight
    // to embedded extraction; otherwise the best companion file, then the best
    // embedded track as fallback.
    public async Task<ResolvedSrtSource?> ResolveSrtSourceAsync(
        string videoPath,
        string sourceIso1,
        string? sourceIso2b,
        string langName,
        long? preferTrackId = null,
        string? preferCodec = null,
        CancellationToken ct = default,
        ILibraryFileSystem? fs = null,
        string? localVideoPath = null)
    {
        if (string.IsNullOrWhiteSpace(preferCodec)) preferCodec = null;
        if (preferTrackId <= 0) preferTrackId = null;
        if (preferCodec != null || preferTrackId != null)
        {
            var extracted = await ExtractBestEmbeddedSrtAsync(
                localVideoPath ?? videoPath, sourceIso1, sourceIso2b, langName, preferTrackId, preferCodec, ct);
            return extracted == null ? null : new ResolvedSrtSource(extracted, true);
        }

        var best = LibraryNameParser.SelectBestSrt(
            await FindCompanionSubtitlesAsync(videoPath, fs), [], sourceIso1, langName);
        if (best != null) return new ResolvedSrtSource(best, false);

        if (fs is { IsRemote: true } && localVideoPath == null) return null;
        var fallback = await ExtractBestEmbeddedSrtAsync(
            localVideoPath ?? videoPath, sourceIso1, sourceIso2b, langName, ct: ct);
        return fallback == null ? null : new ResolvedSrtSource(fallback, true);
    }

    public sealed record ResolvedSrtSource(string Path, bool IsTemp);
}