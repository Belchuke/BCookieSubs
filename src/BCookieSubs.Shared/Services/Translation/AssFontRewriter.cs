using System.Text.RegularExpressions;

namespace BCookieSubs.Shared.Services.Translation;

public static partial class AssFontRewriter
{
    public static string RewriteAssFontnames(string content, string font)
    {
        var eol = DetectEol(content);
        var lines = content.Split(eol);

        var inStyles = false;
        var fontIndex = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            var header = SectionHeader(lines[i]);
            if (header != null)
            {
                inStyles = IsStylesSectionHeader(header);
                fontIndex = -1;
                continue;
            }
            if (!inStyles) continue;

            if (FormatLine().IsMatch(lines[i]))
            {
                var fields = FormatLine().Replace(lines[i], "", 1)
                    .Split(',').Select(f => f.Trim().ToLowerInvariant()).ToList();
                fontIndex = fields.IndexOf("fontname");
                continue;
            }
            if (fontIndex < 0) continue;

            var style = StyleLine().Match(lines[i]);
            if (!style.Success) continue;

            var parts = style.Groups[2].Value.Split(',');
            if (fontIndex >= parts.Length || parts[fontIndex] == font) continue;
            parts[fontIndex] = font;
            lines[i] = style.Groups[1].Value + string.Join(",", parts);
        }
        return string.Join(eol, lines);
    }

    public static string RewriteAssInlineFontOverrides(string content, string font)
    {
        var result = new System.Text.StringBuilder(content.Length);
        var i = 0;
        while (i < content.Length)
        {
            if (content[i] != '{')
            {
                result.Append(content[i]);
                i++;
                continue;
            }
            var end = content.IndexOf('}', i);
            var blockEnd = end == -1 ? content.Length : end + 1;
            var block = content.Substring(i, blockEnd - i);
            result.Append(FnOverride().Replace(block, $"\\fn{font}"));
            i = blockEnd;
        }
        return result.ToString();
    }

    public static string SetAssScriptInfoTitle(string content, string title)
    {
        var eol = DetectEol(content);
        var lines = content.Split(eol);

        var scriptInfoIndex = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            if (SectionHeader(lines[i]) == "script info")
            {
                scriptInfoIndex = i;
                break;
            }
        }
        if (scriptInfoIndex < 0) return content;

        for (var i = scriptInfoIndex + 1; i < lines.Length; i++)
        {
            if (SectionHeader(lines[i]) != null) break;
            if (TitleLine().IsMatch(lines[i]))
            {
                if (TitleLine().Replace(lines[i], "", 1).Trim() == title) return content;
                lines[i] = $"Title: {title}";
                return string.Join(eol, lines);
            }
        }

        var outLines = new List<string>(lines);
        outLines.Insert(scriptInfoIndex + 1, $"Title: {title}");
        return string.Join(eol, outLines);
    }

    private static string? SectionHeader(string line)
    {
        var m = SectionHeaderRegex().Match(line);
        return m.Success ? m.Groups[1].Value.ToLowerInvariant().Trim() : null;
    }

    private static string DetectEol(string raw) => raw.Contains("\r\n") ? "\r\n" : "\n";

    private static bool IsStylesSectionHeader(string name) => V4StylesHeader().IsMatch(name);

    [GeneratedRegex(@"^\s*\[([^\]]+)\]\s*$")]
    private static partial Regex SectionHeaderRegex();

    [GeneratedRegex(@"^v4\+?\s*styles$")]
    private static partial Regex V4StylesHeader();

    [GeneratedRegex(@"^\s*Format\s*:", RegexOptions.IgnoreCase)]
    private static partial Regex FormatLine();

    [GeneratedRegex(@"^(\s*Style\s*:\s*)(.*)$", RegexOptions.IgnoreCase)]
    private static partial Regex StyleLine();

    [GeneratedRegex(@"\\fn[^\\}]*")]
    private static partial Regex FnOverride();

    [GeneratedRegex(@"^\s*Title\s*:", RegexOptions.IgnoreCase)]
    private static partial Regex TitleLine();
}