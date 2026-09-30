using System.Text.RegularExpressions;

namespace BCookieSubs.Shared.Services.Translation;

public enum SubKind
{
    VobSub,
    TextMicroDvd,
    TextSubViewer,
    Unsupported,
}

public record SubToSrtResult(
    string Srt,
    List<SrtEntry> Entries,
    SubKind Kind,
    double? FpsUsed);

public class SubParseException(string message) : Exception(message);

public sealed class MicroDvdFpsRequiredException() : SubParseException(
    "MicroDVD subtitles use frame numbers. Enter the source video's FPS to calculate the offset.");

public static partial class SubTextAdapter
{

    public static string? FindSiblingIdx(string subPath)
    {
        var idx = SubIdxRegex().Replace(subPath, ".idx");
        try
        {
            if (File.Exists(idx)) return idx;
        }
        catch (IOException)
        {
        }
        return null;
    }

    public static SubKind DetectSubKind(string subPath, string? content = null)
    {
        if (FindSiblingIdx(subPath) != null) return SubKind.VobSub;
        var raw = content ?? SafeReadHead(subPath);
        if (raw == null) return SubKind.Unsupported;

        var firstLines = string.Join("\n",
            raw.Split(["\r\n", "\n"], StringSplitOptions.None)
                .Where(l => l.Trim().Length != 0)
                .Take(5));
        if (MicroDvdHeader().IsMatch(firstLines.Trim())) return SubKind.TextMicroDvd;
        if (SubViewerHeader().IsMatch(firstLines)) return SubKind.TextSubViewer;
        return SubKind.Unsupported;
    }

    private static string? SafeReadHead(string subPath)
    {
        try
        {
            using var fs = File.OpenRead(subPath);
            var buf = new byte[4096];
            var n = fs.Read(buf, 0, buf.Length);
            return System.Text.Encoding.UTF8.GetString(buf, 0, n);
        }
        catch (IOException)
        {
            return null;
        }
    }

    private static List<SrtEntry> ParseMicroDvd(string raw, double fps)
    {
        var entries = new List<SrtEntry>();
        var lines = raw.Split(["\r\n", "\n"], StringSplitOptions.None);
        foreach (var line in lines)
        {
            var m = MicroDvdLine().Match(line);
            if (!m.Success) continue;
            var startFrame = long.Parse(m.Groups[1].Value);
            var endFrame = long.Parse(m.Groups[2].Value);
            var text = m.Groups[3].Value;
            if (DefaultHeaderRegex().IsMatch(line)) continue;
            if (startFrame == 1 && endFrame == 1) continue;
            if (string.IsNullOrWhiteSpace(text)) continue;
            text = text.Replace("|", "\n");
            var startMs = (long)Math.Round(startFrame / fps * 1000);
            var endMs = (long)Math.Round(endFrame / fps * 1000);
            entries.Add(SrtParser.MakeEntry(entries.Count + 1, startMs, endMs, text));
        }
        return entries;
    }

    private static long? SubviewerTimeToMs(string ts)
    {
        var m = SubviewerTime().Match(ts.Trim());
        if (!m.Success) return null;
        var h = int.Parse(m.Groups[1].Value);
        var mm = int.Parse(m.Groups[2].Value);
        var s = int.Parse(m.Groups[3].Value);
        var frac = int.Parse(m.Groups[4].Value.PadRight(3, '0'));
        return h * 3600000L + mm * 60000L + s * 1000L + frac;
    }

    private static List<SrtEntry> ParseSubViewer(string raw)
    {
        var entries = new List<SrtEntry>();
        var lines = raw.Split(["\r\n", "\n"], StringSplitOptions.None);
        var i = 0;
        while (i < lines.Length && !FirstTimingStart().IsMatch(lines[i].Trim())) i++;

        while (i < lines.Length)
        {
            var timeLine = lines[i].Trim();
            var tm = SubviewerPair().Match(timeLine);
            if (!tm.Success)
            {
                i++;
                continue;
            }
            var startMs = SubviewerTimeToMs(tm.Groups[1].Value);
            var endMs = SubviewerTimeToMs(tm.Groups[2].Value);
            i++;
            var textLines = new List<string>();
            while (i < lines.Length && lines[i].Trim().Length != 0 && !FirstTimingStart().IsMatch(lines[i].Trim()))
            {
                textLines.Add(lines[i]);
                i++;
            }
            while (i < lines.Length && lines[i].Trim().Length == 0) i++;
            if (startMs == null || endMs == null) continue;
            var text = Br().Replace(string.Join("\n", textLines), "\n").Trim();
            if (text.Length == 0) continue;
            entries.Add(SrtParser.MakeEntry(entries.Count + 1, startMs.Value, endMs.Value, text));
        }
        return entries;
    }

    public static SubToSrtResult ConvertTextSubToSrt(string subPath, string content, double? fpsOverride, double? mediaFps)
    {
        var detected = DetectSubKind(subPath, content);
        if (detected == SubKind.VobSub)
        {
            throw new SubParseException(
                "VobSub (.sub + .idx) requires OCR, which is handled by the Python compute workers.");
        }
        if (detected == SubKind.Unsupported)
        {
            throw new SubParseException(
                $"Unsupported .sub format: not VobSub (no .idx), MicroDVD, or SubViewer. Cannot parse \"{Path.GetFileName(subPath)}\".");
        }

        if (detected == SubKind.TextSubViewer)
        {
            var entries = ParseSubViewer(content);
            if (entries.Count == 0)
                throw new SubParseException("SubViewer .sub parsed but contained no subtitle rows");
            return new SubToSrtResult(SrtParser.Serialize(entries), entries, SubKind.TextSubViewer, null);
        }

        var fps = fpsOverride ?? ExtractHeaderFps(content) ?? mediaFps;
        if (fps is not > 0) throw new MicroDvdFpsRequiredException();
        var mdEntries = ParseMicroDvd(content, fps.Value);
        if (mdEntries.Count == 0)
            throw new SubParseException("MicroDVD .sub parsed but contained no subtitle rows");
        return new SubToSrtResult(SrtParser.Serialize(mdEntries), mdEntries, SubKind.TextMicroDvd, fps);
    }


    public sealed record SubTextEntry(
        int LineIndex, long? FrameStart, long? FrameEnd, long StartMs, long EndMs, string Text);

    public sealed record SubTextParseResult(
        SubKind Kind, List<SubTextEntry> Entries, double? FpsUsed);

    public static SubTextParseResult ParseTextSubEntries(string subPath, string content, double? fpsOverride)
    {
        var detected = DetectSubKind(subPath, content);
        if (detected == SubKind.VobSub)
        {
            throw new SubParseException(
                "VobSub (.sub + .idx) is an image subtitle — it goes through the OCR pipeline and can't be offset here.");
        }
        if (detected == SubKind.Unsupported)
        {
            throw new SubParseException(
                $"Unsupported .sub format: not MicroDVD or SubViewer. Cannot parse \"{Path.GetFileName(subPath)}\".");
        }

        if (detected == SubKind.TextSubViewer)
        {
            var svEntries = ParseSubViewer(content);
            if (svEntries.Count == 0)
                throw new SubParseException("SubViewer .sub parsed but contained no subtitle rows");
            var svList = svEntries.Select(e => new SubTextEntry(-1, null, null, e.StartMs, e.EndMs, e.Text)).ToList();
            return new SubTextParseResult(SubKind.TextSubViewer, svList, null);
        }

        var fps = fpsOverride ?? ExtractHeaderFps(content);
        if (fps is not > 0) throw new MicroDvdFpsRequiredException();
        var entries = ParseMicroDvdEntries(content, fps.Value);
        if (entries.Count == 0)
            throw new SubParseException("MicroDVD .sub parsed but contained no subtitle rows");
        return new SubTextParseResult(SubKind.TextMicroDvd, entries, fps);
    }

    public static double? ExtractHeaderFps(string content)
    {
        foreach (var line in content.Split(["\r\n", "\n"], StringSplitOptions.None))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var m = MicroDvdLine().Match(line);
            if (!m.Success) continue;
            if (long.TryParse(m.Groups[1].Value, out var s) && long.TryParse(m.Groups[2].Value, out var e)
                && (s is 1 or 0 && e is 1 or 0))
            {
                var text = FpsSuffix().Replace(m.Groups[3].Value, "").Trim();
                if (double.TryParse(text, System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var fps)
                    && fps is >= 1 and <= 200)
                {
                    return fps;
                }
                return null;
            }
            return null;
        }
        return null;
    }

    public sealed record MicroDvdTimingChange(
        int LineIndex, long FrameStart, long FrameEnd, string? Text,
        long? OrigFrameStart = null, long? OrigFrameEnd = null);

    // Offset editor: rewrite only the {startFrame}{endFrame} numbers (and the
    // text when edited) on the matching lines — every other byte is preserved.
    // Original frame numbers are re-checked so a file changed on disk is
    // rejected instead of shifted at wrong positions. Returns null on mismatch.
    public static string? ShiftMicroDvdFrames(
        string raw, IReadOnlyList<MicroDvdTimingChange> changes, bool addCredit, double fps)
    {
        var byIndex = new Dictionary<int, MicroDvdTimingChange>();
        foreach (var c in changes)
        {
            if (!byIndex.TryAdd(c.LineIndex, c)) return null;
        }

        var (lines, seps) = SubtitleTextUtils.SplitKeepEndings(raw);
        var applied = 0;
        foreach (var (index, change) in byIndex)
        {
            var m = MicroDvdLine().Match(lines[index]);
            if (!m.Success) return null;
            var parsedStart = long.Parse(m.Groups[1].Value);
            var parsedEnd = long.Parse(m.Groups[2].Value);
            if (change.OrigFrameStart is { } os && parsedStart != os) return null;
            if (change.OrigFrameEnd is { } oe && parsedEnd != oe) return null;
            var newStart = Math.Max(0, change.FrameStart);
            var newEnd = Math.Max(newStart, change.FrameEnd);
            var rest = lines[index][(m.Groups[2].Index + m.Groups[2].Length + 1)..];
            var text = change.Text is { Length: > 0 } t ? t.Replace("\n", "|") : rest;
            lines[index] = $"{{{newStart}}}{{{newEnd}}}{text}";
            applied++;
        }

        if (applied != changes.Count) return null;

        if (addCredit && changes.Count > 0)
        {
            var firstStart = changes[0].FrameStart;
            if (firstStart > 0)
            {
                var creditFrames = Math.Max(1, (long)Math.Round(SubtitleExport.CreditDurationMs / 1000.0 * fps));
                creditFrames = Math.Min(creditFrames, firstStart - 1);
                lines.Insert(0, $"{{0}}{{{creditFrames}}}{SubtitleExport.CreditText}");
                seps.Insert(0, raw.Contains("\r\n") ? "\r\n" : "\n");
            }
        }

        return SubtitleTextUtils.JoinKeepEndings(lines, seps);
    }

    // Display rows for the offset editor (frames retained, text with | → \n).
    private static List<SubTextEntry> ParseMicroDvdEntries(string raw, double fps)
    {
        var entries = new List<SubTextEntry>();
        var lines = raw.Split(["\r\n", "\n"], StringSplitOptions.None);
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var m = MicroDvdLine().Match(line);
            if (!m.Success) continue;
            var startFrame = long.Parse(m.Groups[1].Value);
            var endFrame = long.Parse(m.Groups[2].Value);
            var text = m.Groups[3].Value;
            if (DefaultHeaderRegex().IsMatch(line)) continue;
            if (startFrame == 1 && endFrame == 1) continue;
            if (string.IsNullOrWhiteSpace(text)) continue;
            text = text.Replace("|", "\n");
            entries.Add(new SubTextEntry(
                i, startFrame, endFrame,
                SrtOffsetService.FrameToMs(startFrame, fps),
                SrtOffsetService.FrameToMs(endFrame, fps),
                text));
        }
        return entries;
    }

    [GeneratedRegex(@"\.sub$", RegexOptions.IgnoreCase)]
    private static partial Regex SubIdxRegex();

    [GeneratedRegex(@"^\{\d+\}\{\d+\}")]
    private static partial Regex MicroDvdHeader();

    [GeneratedRegex(@"^\{(\d+)\}\{(\d+)\}(.*)$")]
    private static partial Regex MicroDvdLine();

    [GeneratedRegex(@"^\{DEFAULT\}", RegexOptions.IgnoreCase)]
    private static partial Regex DefaultHeaderRegex();

    [GeneratedRegex(@"^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3},\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}", RegexOptions.Multiline)]
    private static partial Regex SubViewerHeader();

    [GeneratedRegex(@"^(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}),(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})$")]
    private static partial Regex SubviewerPair();

    [GeneratedRegex(@"^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3},")]
    private static partial Regex FirstTimingStart();

    [GeneratedRegex(@"^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$")]
    private static partial Regex SubviewerTime();

    [GeneratedRegex(@"\[br\]", RegexOptions.IgnoreCase)]
    private static partial Regex Br();

    [GeneratedRegex(@"\s*fps\.?\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex FpsSuffix();
}