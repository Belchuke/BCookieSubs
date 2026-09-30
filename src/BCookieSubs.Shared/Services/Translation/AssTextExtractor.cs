using System.Text.RegularExpressions;

namespace BCookieSubs.Shared.Services.Translation;

public record AssExtractResult(string ModelText, bool HasTranslatable, List<string> Runs);

public static partial class AssTextExtractor
{
    private static readonly Regex PlaceholderRestoreRegex = new("⟨AS(\\d+)⟩", RegexOptions.Compiled);
    private static readonly Regex PlaceholderGlobalRegex = new("⟨AS\\d+⟩", RegexOptions.Compiled);
    private static readonly Regex DrawingTagRegex = new(@"\\p(?![a-zA-Z])\s*(\d*)", RegexOptions.Compiled);
    private static readonly Regex EscapeStripRegex = new(@"\\[NnhH]", RegexOptions.Compiled);

    private static string NextToken(List<string> runs) => $"⟨AS{runs.Count + 1}⟩";

    private static bool ApplyDrawingTags(bool current, string block)
    {
        var mode = current;
        foreach (Match m in DrawingTagRegex.Matches(block))
        {
            mode = m.Groups[1].Value.Length == 0 ? false : int.Parse(m.Groups[1].Value) > 0;
        }
        return mode;
    }

    public static AssExtractResult ExtractAssTranslatable(string text)
    {
        var runs = new List<string>();
        var modelText = "";
        var drawingOn = false;

        var i = 0;
        while (i < text.Length)
        {
            if (text[i] == '{')
            {
                var end = text.IndexOf('}', i);
                var blockEnd = end == -1 ? text.Length : end + 1;
                var block = end == -1 ? text[i..] : text[i..blockEnd];
                drawingOn = ApplyDrawingTags(drawingOn, block);
                modelText += NextToken(runs);
                runs.Add(block);
                i = blockEnd;
            }
            else
            {
                var j = i;
                while (j < text.Length && text[j] != '{') j++;
                var lit = text[i..j];
                if (drawingOn)
                {
                    modelText += NextToken(runs);
                    runs.Add(lit);
                }
                else
                {
                    modelText += lit;
                }
                i = j;
            }
        }

        // Translatable only if readable text remains after removing tokens and
        // the \N \n \h escapes; pure-drawing lines are skipped by the caller.
        var stripped = PlaceholderGlobalRegex.Replace(modelText, "");
        stripped = EscapeStripRegex.Replace(stripped, "");
        var hasTranslatable = stripped.Any(c => !char.IsWhiteSpace(c));

        return new AssExtractResult(modelText, hasTranslatable, runs);
    }

    public static string RestoreAssPlaceholders(string modelText, List<string> runs) =>
        PlaceholderRestoreRegex.Replace(modelText, m =>
        {
            var n = int.Parse(m.Groups[1].Value);
            return n >= 1 && n <= runs.Count ? runs[n - 1] : "";
        });

    // True when `translated` preserves the placeholder tokens of `source`
    // exactly — same count, same left-to-right order. Token reordering is
    // treated as corruption because ASS override tags apply to the text that
    // follows them, in order.
    public static bool AssPlaceholdersIntact(string source, string translated)
    {
        var src = PlaceholderGlobalRegex.Matches(source).Select(m => m.Value).ToList();
        var dst = PlaceholderGlobalRegex.Matches(translated).Select(m => m.Value).ToList();
        return src.Count == dst.Count && !src.Where((t, idx) => t != dst[idx]).Any();
    }
}