using System.Text.Json;
using System.Text.RegularExpressions;

namespace BCookieSubs.Shared.Services.Translation;

public record JudgeParseResult(bool Ok, int WinnerIndex, string? Reason, string? Error);

public static partial class JudgeResponseParser
{
    private const string RepairInstruction =
        "\n\nYour previous response was not a single valid JSON object. " +
        "Respond with ONLY the JSON object: {\"winnerIndex\": <number or -1>, \"reason\": \"...\"} — no other text.";

    public static string JudgeRepairPrompt(string promptText, int attempt)
    {
        var suffix = attempt > 1 ? " (previous attempts also failed to parse)" : "";
        return promptText + RepairInstruction + suffix;
    }

    public static JudgeParseResult ParseJudgeResponse(string content)
    {
        var trimmed = content.Trim();
        if (trimmed.Length == 0) return new JudgeParseResult(false, 0, null, "empty response");

        var candidates = new List<string> { trimmed };

        var fenced = FenceStart().Replace(trimmed, "", 1);
        fenced = FenceTail().Replace(fenced, "", 1).Trim();
        if (fenced != trimmed) candidates.Add(fenced);

        var balanced = ExtractFirstBalancedObject(trimmed);
        if (balanced != null && !candidates.Contains(balanced)) candidates.Add(balanced);

        var repaired = RepairTruncatedJson(balanced ?? fenced);
        if (repaired != null && !candidates.Contains(repaired)) candidates.Add(repaired);

        var error = "no parseable JSON object found";
        foreach (var attempt in candidates)
        {
            var (result, shapeError) = ValidateShape(attempt);
            if (result != null) return result;
            error = shapeError ?? error;
        }
        return new JudgeParseResult(false, 0, null, error);
    }

    private static int StringEnd(string content, int start)
    {
        var i = start + 1;
        while (i < content.Length)
        {
            if (content[i] == '\\')
            {
                i += 2;
                continue;
            }
            if (content[i] == '"') return i;
            i++;
        }
        return -1;
    }

    private static string? ExtractFirstBalancedObject(string content)
    {
        var start = content.IndexOf('{');
        if (start == -1) return null;
        var depth = 0;
        var i = start;
        while (i < content.Length)
        {
            var ch = content[i];
            if (ch == '"')
            {
                var end = StringEnd(content, i);
                if (end == -1) return null;
                i = end + 1;
                continue;
            }
            if (ch == '{') depth++;
            else if (ch == '}')
            {
                depth--;
                if (depth == 0) return content[start..(i + 1)];
            }
            i++;
        }
        return null;
    }

    private static string? RepairTruncatedJson(string? fragment)
    {
        if (string.IsNullOrEmpty(fragment) || !fragment.Contains('{')) return null;
        var start = fragment.IndexOf('{');
        var s = fragment[start..];
        s = TrailingBackslash().Replace(s, "", 1);
        if (string.IsNullOrWhiteSpace(s)) return null;

        var stack = new List<char>();
        var openString = false;
        var i = 0;
        while (i < s.Length)
        {
            var ch = s[i];
            if (openString)
            {
                if (ch == '\\')
                {
                    i += 2;
                    continue;
                }
                if (ch == '"') openString = false;
                i++;
                continue;
            }
            if (ch == '"')
            {
                openString = true;
                i++;
                continue;
            }
            if (ch == '{' || ch == '[') stack.Add(ch);
            else if (ch == '}' || ch == ']')
            {
                if (stack.Count > 0) stack.RemoveAt(stack.Count - 1);
            }
            i++;
        }

        var repaired = s;
        if (openString) repaired += '"';
        repaired = TrailingPunct().Replace(repaired, "", 1);
        stack.Reverse();
        foreach (var opener in stack) repaired += opener == '{' ? "}" : "]";
        return repaired;
    }

    private static (JudgeParseResult? Result, string? Error) ValidateShape(string text)
    {
        try
        {
            using var doc = JsonDocument.Parse(text);
            var value = doc.RootElement;
            if (value.ValueKind != JsonValueKind.Object)
            {
                return (null, "response is not a JSON object");
            }
            if (!value.TryGetProperty("winnerIndex", out var winnerElement))
            {
                return (null, "JSON object missing winnerIndex");
            }
            var winnerIndex = NormalizeWinnerIndex(winnerElement);
            if (winnerIndex == null)
            {
                return (null, "winnerIndex not numeric");
            }
            string? reason = null;
            if (value.TryGetProperty("reason", out var reasonElement) &&
                reasonElement.ValueKind == JsonValueKind.String)
            {
                var raw = reasonElement.GetString();
                if (raw != null) reason = raw.Length > 500 ? raw[..500] : raw;
            }
            return (new JudgeParseResult(true, winnerIndex.Value, reason, null), null);
        }
        catch (JsonException e)
        {
            return (null, e.Message);
        }
    }

    private static int? NormalizeWinnerIndex(JsonElement raw)
    {
        switch (raw.ValueKind)
        {
            case JsonValueKind.Number:
            {
                if (raw.TryGetInt32(out var i)) return i;
                if (raw.TryGetDouble(out var d) && double.IsFinite(d)) return (int)Math.Round(d);
                return null;
            }
            case JsonValueKind.String:
            {
                var trimmed = raw.GetString()?.Trim() ?? "";
                if (trimmed.Length == 0) return 0;
                if (double.TryParse(trimmed, System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var n) &&
                    double.IsFinite(n))
                {
                    return (int)Math.Round(n);
                }
                return null;
            }
            default:
                return null;
        }
    }

    [GeneratedRegex("^`{3}[a-zA-Z0-9_-]*\\s*\\n?")]
    private static partial Regex FenceStart();

    [GeneratedRegex("```$")]
    private static partial Regex FenceTail();

    [GeneratedRegex(@"\\$")]
    private static partial Regex TrailingBackslash();

    [GeneratedRegex(@"[,:\s]+$")]
    private static partial Regex TrailingPunct();
}