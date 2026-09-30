using System.Text.RegularExpressions;

namespace BCookieSubs.Shared.Services.Translation;

public record SrtEntry(string Id, long StartMs, long EndMs, string StartTime, string EndTime, string Text);

public static class SrtParser
{
    private static readonly Regex SrtTimeRegex =
        new(@"^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$", RegexOptions.Compiled);

    private static readonly Regex CommaRegex =
        new(@"(\d+)\n(\d{1,2}:\d{2}:\d{2},\d{1,3}) --> (\d{1,2}:\d{2}:\d{2},\d{1,3})", RegexOptions.Compiled);

    private static readonly Regex DotRegex =
        new(@"(\d+)\n(\d{1,2}:\d{2}:\d{2}\.\d{1,3}) --> (\d{1,2}:\d{2}:\d{2}\.\d{1,3})", RegexOptions.Compiled);

    public static SrtEntry MakeEntry(long id, long startMs, long endMs, string text)
    {
        var safeEnd = endMs > startMs ? endMs : startMs + 1000;
        return new SrtEntry(id.ToString(), startMs, safeEnd, MsToSrtTime(startMs), MsToSrtTime(safeEnd), text);
    }

    private static long SrtTimeToMs(string ts)
    {
        var m = SrtTimeRegex.Match(ts.Trim());
        if (!m.Success) return 0;
        var h = int.Parse(m.Groups[1].Value);
        var mm = int.Parse(m.Groups[2].Value);
        var s = int.Parse(m.Groups[3].Value);
        var ms = int.Parse(m.Groups[4].Value.PadRight(3, '0'));
        return h * 3600000L + mm * 60000L + s * 1000L + ms;
    }

    public static string MsToSrtTime(long ms)
    {
        if (ms < 0) ms = 0;
        var h = ms / 3600000;
        var m = ms % 3600000 / 60000;
        var s = ms % 60000 / 1000;
        var millis = ms % 1000;
        return $"{h:D2}:{m:D2}:{s:D2},{millis:D3}";
    }

    public static List<SrtEntry> Parse(string raw)
    {
        var entries = new List<SrtEntry>();
        if (string.IsNullOrWhiteSpace(raw)) return entries;

        var data = raw.Replace("\r", "");
        var parts = SplitWithCaptures(data, CommaRegex);
        // No comma-formatted timing found → retry with the dot variant.
        if (parts.Count < 5) parts = SplitWithCaptures(data, DotRegex);

        // parts = [pre, id, start, end, text/pre, id, start, end, text/pre, ...];
        // ids therefore start at index 1 with stride 4.
        for (var i = 1; i + 3 < parts.Count; i += 4)
        {
            var startTime = CorrectFormat(parts[i + 1].Trim());
            var endTime = CorrectFormat(parts[i + 2].Trim());
            var startMs = SrtTimeToMs(startTime);
            var endMs = SrtTimeToMs(endTime);
            entries.Add(new SrtEntry(
                parts[i].Trim(), startMs, endMs, MsToSrtTime(startMs), MsToSrtTime(endMs), parts[i + 3].Trim()));
        }
        return entries;
    }

    // JS String.split with a capturing regex interleaves the captures into the
    // result: [pre, id, start, end, text, ...]. This reproduces that shape.
    private static List<string> SplitWithCaptures(string input, Regex regex)
    {
        var result = new List<string>();
        var last = 0;
        foreach (Match m in regex.Matches(input))
        {
            result.Add(input.Substring(last, m.Index - last));
            for (var g = 1; g < m.Groups.Count; g++) result.Add(m.Groups[g].Value);
            last = m.Index + m.Length;
        }
        result.Add(input[last..]);
        return result;
    }

    // srt-parser-2 correctFormat: normalize "." to "," and pad/slice each field.
    private static string CorrectFormat(string time)
    {
        var str = time;
        var dot = str.IndexOf('.');
        if (dot >= 0) str = str.Substring(0, dot) + "," + str.Substring(dot + 1);

        var comma = str.IndexOf(',');
        var front = comma >= 0 ? str[..comma] : str;
        var ms = comma >= 0 ? str[(comma + 1)..] : "";
        ms = FixedStrDigit(ms, 3, padEnd: true);

        var fields = front.Split(':');
        var hour = fields.Length > 0 ? FixedStrDigit(fields[0], 2, padEnd: false) : "00";
        var minute = fields.Length > 1 ? FixedStrDigit(fields[1], 2, padEnd: false) : "00";
        var second = fields.Length > 2 ? FixedStrDigit(fields[2], 2, padEnd: false) : "00";
        return $"{hour}:{minute}:{second},{ms}";
    }

    private static string FixedStrDigit(string str, int howMany, bool padEnd)
    {
        if (str.Length == howMany) return str;
        if (str.Length > howMany) return str[..howMany];
        return padEnd ? str.PadRight(howMany, '0') : str.PadLeft(howMany, '0');
    }

    // Renumber 1..N and enforce a minimum 1 ms duration.
    public static string Serialize(List<SrtEntry> entries)
    {
        var lines = new List<string>();
        for (var i = 0; i < entries.Count; i++)
        {
            var e = entries[i];
            var end = Math.Max(e.EndMs, e.StartMs + 1);
            lines.Add((i + 1).ToString());
            lines.Add($"{MsToSrtTime(e.StartMs)} --> {MsToSrtTime(end)}");
            lines.Add(e.Text ?? "");
            lines.Add("");
        }
        return string.Join("\n", lines);
    }
}