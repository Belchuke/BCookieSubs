using System.Security.Cryptography;
using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Services.Translation;

public static partial class Trcnk
{
    public static string StripMarkdownFences(string input)
    {
        var s = FenceLangStart().Replace(input, "", 1);
        s = FenceEnd().Replace(s, "", 1);
        s = FenceBareStart().Replace(s, "", 1);
        s = FenceTail().Replace(s, "", 1);
        return s.Trim();
    }

    public static string EscapeAttribute(string value) =>
        value.Replace("&", "&amp;").Replace("\"", "&quot;");

    public static ParsedChunk? ParseLLMResponse(string response)
    {
        var cleaned = StripMarkdownFences(response).Trim();

        if (!cleaned.StartsWith("<trcnk>", StringComparison.Ordinal) ||
            !cleaned.EndsWith("</trcnk>", StringComparison.Ordinal))
        {
            return null;
        }

        var outsideTagsRemoved = TrcnkOpenStrip().Replace(cleaned, "", 1);
        outsideTagsRemoved = TrcnkCloseStrip().Replace(outsideTagsRemoved, "", 1);

        var rows = new List<ParsedChunkRow>();
        var reconstructed = "";
        foreach (Match match in BlockRegex().Matches(outsideTagsRemoved))
        {
            reconstructed += match.Value;
            rows.Add(new ParsedChunkRow(
                match.Groups[1].Value,
                match.Groups[2].Value.Replace("<breakcnk>", "\n")));
        }

        if (rows.Count == 0) return null;

        var normalizedOriginal = WhitespaceRegex().Replace(outsideTagsRemoved, "");
        var normalizedReconstructed = WhitespaceRegex().Replace(reconstructed, "");
        if (normalizedOriginal != normalizedReconstructed) return null;

        return new ParsedChunk(rows, cleaned);
    }

    public static bool ValidateChunkIntegrity(
        List<ParsedChunkRow> originalRows, List<ParsedChunkRow> parsedRows)
    {
        if (originalRows.Count != parsedRows.Count) return false;

        var seen = new HashSet<string>();
        for (var i = 0; i < originalRows.Count; i++)
        {
            if (parsedRows[i].Id != originalRows[i].Id) return false;
            if (!seen.Add(parsedRows[i].Id)) return false;
            if (string.IsNullOrWhiteSpace(parsedRows[i].Text) &&
                !string.IsNullOrWhiteSpace(originalRows[i].Text)) return false;
        }

        for (var i = 0; i < originalRows.Count; i++)
        {
            var originalBreaks = CountNewlines(originalRows[i].Text);
            var parsedBreaks = CountNewlines(parsedRows[i].Text);
            if (Math.Abs(originalBreaks - parsedBreaks) > 2) return false;
        }

        return true;
    }

    private static int CountNewlines(string s)
    {
        var count = 0;
        foreach (var c in s) if (c == '\n') count++;
        return count;
    }

    // <trcnk> wrapper fed to the model for a chunk of rows.
    public static string SrtFormatterForModel(List<ParsedChunkRow> chunk)
    {
        var lines = new List<string> { "<trcnk>" };
        foreach (var row in chunk)
        {
            if (string.IsNullOrEmpty(row.Id)) continue;
            var normalizedText = (row.Text ?? "")
                .Replace("\r\n", "\n")
                .Replace("\r", "\n")
                .Trim()
                .Replace("\n", "<breakcnk>");
            lines.Add($"<txtcnk id=\"{EscapeAttribute(row.Id)}\">{normalizedText}</txtcnk>");
        }
        lines.Add("</trcnk>");
        return string.Join("\n", lines);
    }

    // Instructions prepended to the chunk envelope. Every format gets the
    // row-preservation rule; ASS/SSA additionally gets ⟨ASk⟩ placeholder rules.
    public static string FormatAwareChunkPreamble(SubtitleFormat format)
    {
        var preamble = "Every <txtcnk> row in the input must appear in your output with the same id — never omit, merge, reorder, or add rows, even if a row looks like a credit, watermark, URL, advertisement, or a repeated line such as song lyrics. Translate or preserve its content as appropriate.";

        if (format is not (SubtitleFormat.Ass or SubtitleFormat.Ssa)) return preamble;

        return preamble + " " + string.Join(" ",
        [
            "These subtitle entries are ASS/SSA Dialogue Text fields where every styling/position override tag and vector-drawing command has been replaced by a placeholder token of the form ⟨AS1⟩, ⟨AS2⟩, etc.",
            "Treat every ⟨ASk⟩ placeholder as untouchable: copy it character-for-character into your output, in the same position relative to the surrounding text. Never translate, rename, reorder, split, merge, add, or drop a placeholder.",
            "Preserve \\N (and \\n) line-break markers exactly.",
            "Translate only the human-readable dialogue text around the placeholders; the placeholders themselves carry no meaning and must pass through unchanged.",
            "Keep each entry on a single logical line, matching the input.",
        ]);
    }

    public static string GetFileHash(string content)
    {
        var bytes = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(content));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    [GeneratedRegex("^`{3}[a-zA-Z0-9_-]*\\s*\\n")]
    private static partial Regex FenceLangStart();

    [GeneratedRegex(@"\n```$")]
    private static partial Regex FenceEnd();

    [GeneratedRegex("^`{3}[\\r\\n]?")]
    private static partial Regex FenceBareStart();

    [GeneratedRegex("```$")]
    private static partial Regex FenceTail();

    [GeneratedRegex("^<trcnk>\\s*")]
    private static partial Regex TrcnkOpenStrip();

    [GeneratedRegex("\\s*</trcnk>$")]
    private static partial Regex TrcnkCloseStrip();

    [GeneratedRegex(@"<txtcnk id=""([^""]+)"">([\s\S]*?)</txtcnk>")]
    private static partial Regex BlockRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();
}