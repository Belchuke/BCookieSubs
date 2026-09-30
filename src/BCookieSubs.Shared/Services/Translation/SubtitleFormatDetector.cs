using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Services.Translation;

public static partial class SubtitleFormatDetector
{
    private static readonly string[] SubtitleExtensions = [".srt", ".ass", ".ssa"];

    private static string? SubtitleExtensionOf(string path)
    {
        var lower = path.ToLowerInvariant();
        foreach (var ext in SubtitleExtensions)
        {
            if (lower.EndsWith(ext, StringComparison.Ordinal)) return ext;
        }
        return null;
    }

    private static bool IsSubFile(string path) =>
        path.EndsWith(".sub", StringComparison.OrdinalIgnoreCase);

    private static bool IsSupFile(string path) =>
        path.EndsWith(".sup", StringComparison.OrdinalIgnoreCase);

    private static string? SniffAssScriptVariant(string content)
    {
        if (V4PlusStyles().IsMatch(content)) return "ass";
        if (ScriptTypeV4Plus().IsMatch(content)) return "ass";
        if (V4Styles().IsMatch(content)) return "ssa";
        if (ScriptTypeV4().IsMatch(content)) return "ssa";
        return null;
    }

    public static SubtitleFormat DetectSubtitleFormat(string filename, string? content)
    {
        var ext = SubtitleExtensionOf(filename);
        if (ext == ".srt") return SubtitleFormat.Srt;
        if (IsSubFile(filename) || IsSupFile(filename)) return SubtitleFormat.Srt;

        if ((ext is ".ass" or ".ssa" || ext == null) && content != null)
        {
            var sniffed = SniffAssScriptVariant(content);
            if (sniffed != null) return sniffed == "ass" ? SubtitleFormat.Ass : SubtitleFormat.Ssa;
        }

        if (ext == ".ass") return SubtitleFormat.Ass;
        if (ext == ".ssa") return SubtitleFormat.Ssa;

        if (content != null)
        {
            var head = content.Length > 4096 ? content[..4096] : content;
            if (ScriptInfoHead().IsMatch(head) || EventsHead().IsMatch(head) || V4StylesHead().IsMatch(head))
            {
                return SubtitleFormat.Ass;
            }
        }
        return SubtitleFormat.Srt;
    }

    [GeneratedRegex(@"\[\s*V4\+\s*Styles\s*\]", RegexOptions.IgnoreCase)]
    private static partial Regex V4PlusStyles();

    [GeneratedRegex(@"ScriptType\s*:\s*v4\.00\+", RegexOptions.IgnoreCase)]
    private static partial Regex ScriptTypeV4Plus();

    [GeneratedRegex(@"\[\s*V4\s+Styles\s*\]", RegexOptions.IgnoreCase)]
    private static partial Regex V4Styles();

    [GeneratedRegex(@"ScriptType\s*:\s*v4\.00(?!\+)", RegexOptions.IgnoreCase)]
    private static partial Regex ScriptTypeV4();

    [GeneratedRegex(@"\[Script Info\]", RegexOptions.IgnoreCase)]
    private static partial Regex ScriptInfoHead();

    [GeneratedRegex(@"\[Events\]", RegexOptions.IgnoreCase)]
    private static partial Regex EventsHead();

    [GeneratedRegex(@"\[V4\+?\s*Styles\]", RegexOptions.IgnoreCase)]
    private static partial Regex V4StylesHead();
}