namespace BCookieSubs.Shared.Services.Translation;

public static class SubtitleTextUtils
{
    public static (List<string> Lines, List<string> Separators) SplitKeepEndings(string raw)
    {
        var lines = new List<string>();
        var seps = new List<string>();
        var start = 0;
        for (var i = 0; i < raw.Length; i++)
        {
            if (raw[i] != '\n') continue;
            var lineEnd = i;
            var sepEnd = i + 1;
            if (lineEnd > start && raw[lineEnd - 1] == '\r')
            {
                lineEnd--;
                sepEnd = i + 1;
            }
            lines.Add(raw[start..lineEnd]);
            seps.Add(raw[lineEnd..sepEnd]);
            start = i + 1;
        }
        if (start < raw.Length) lines.Add(raw[start..]);
        return (lines, seps);
    }

    public static string JoinKeepEndings(List<string> lines, List<string> seps)
    {
        var sb = new System.Text.StringBuilder();
        for (var i = 0; i < lines.Count; i++)
        {
            sb.Append(lines[i]);
            if (i < seps.Count) sb.Append(seps[i]);
        }
        return sb.ToString();
    }
}