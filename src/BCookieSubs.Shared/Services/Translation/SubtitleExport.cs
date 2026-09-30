using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Services.Translation;

public static partial class SubtitleExport
{
    public const string CreditText = "Translated by BCookieSubs";
    public const int CreditDurationMs = 5000;
    public const string DefaultThaiAssFont = "Garuda";

    public static string? ResolveAssFontForLanguage(string? languageCode, string? configuredThaiFont)
    {
        if (!IsThaiLanguageCode(languageCode)) return null;
        var configured = configuredThaiFont?.Trim();
        return string.IsNullOrEmpty(configured) ? DefaultThaiAssFont : configured;
    }

    public static bool IsThaiLanguageCode(string? code)
    {
        if (code == null) return false;
        var tag = PrimarySubtag(code);
        return tag is "th" or "tha";
    }

    public static string NormalizeLanguageCode(string? code)
    {
        if (string.IsNullOrWhiteSpace(code)) return "";
        return PrimarySubtag(code);
    }

    public static string SubtitleExportExtension(SubtitleFormat format) =>
        format switch
        {
            SubtitleFormat.Ass => ".ass",
            SubtitleFormat.Ssa => ".ssa",
            _ => ".srt",
        };

    // ── Download filename (export naming + dashboard call-site sanitize) ──

    public static string SanitizeExportTitle(string title) =>
        WhitespaceRegex().Replace(ExportTitleStripRegex().Replace(title, ""), " ").Trim();

    // [BCookieSub]<title>.S##E##.(<year>).<iso><ext>; season only when both parts exist.
    public static string GetExportFileName(
        string title, int? season, int? episode, int? year, string langCode, SubtitleFormat format)
    {
        var fileName = $"[BCookieSub]{title}";
        if (season != null && episode != null)
        {
            fileName += $".S{season.Value:D2}E{episode.Value:D2}";
        }
        if (year != null)
        {
            fileName += $".({year.Value})";
        }
        if (!string.IsNullOrEmpty(langCode))
        {
            fileName += $".{langCode}";
        }
        return fileName + SubtitleExportExtension(format);
    }

    public static string FinalizeSubtitleForOutput(
        string content, SubtitleFormat format, string languageCode, string languageName,
        string? configuredThaiFont)
    {
        var credited = AddCreditToSubtitle(content, format);
        return ApplyAssFontPolicy(credited, format, languageCode, languageName, configuredThaiFont);
    }

    public static string AddCreditToSubtitle(string content, SubtitleFormat format) =>
        format is SubtitleFormat.Ass or SubtitleFormat.Ssa
            ? AddCreditToAss(content)
            : AddCreditToSrt(content);

    public static string ApplyAssFontPolicy(
        string content, SubtitleFormat format, string? languageCode, string? languageName,
        string? configuredThaiFont)
    {
        if (format is not (SubtitleFormat.Ass or SubtitleFormat.Ssa)) return content;
        var font = ResolveAssFontForLanguage(languageCode, configuredThaiFont);
        if (font == null) return content;

        var result = AssFontRewriter.RewriteAssFontnames(content, font);
        result = AssFontRewriter.RewriteAssInlineFontOverrides(result, font);
        if (!string.IsNullOrEmpty(languageName))
            result = AssFontRewriter.SetAssScriptInfoTitle(result, languageName);
        return result;
    }

    private static string PrimarySubtag(string code) =>
        code.Trim().ToLowerInvariant().Split(['-', '_'])[0];

    // ── SRT credit ──────────────────────────────────────────────────────────

    public static string AddCreditToSrt(string srt)
    {
        if (string.IsNullOrWhiteSpace(srt)) return srt;

        var firstStartMs = ParseFirstStartMs(srt);
        long creditEndMs = CreditDurationMs;
        if (firstStartMs != null)
        {
            var safeEnd = firstStartMs.Value - 100;
            if (safeEnd <= 0) return ShiftSrtIds(srt);
            creditEndMs = Math.Min(CreditDurationMs, safeEnd);
        }

        var creditBlock = $"1\n{MsToSrtTime(0)} --> {MsToSrtTime(creditEndMs)}\n{CreditText}\n";
        return creditBlock + "\n" + ShiftSrtIds(srt);
    }

    private static long? ParseFirstStartMs(string srt)
    {
        var m = FirstStartRegex().Match(srt);
        return m.Success ? SrtTimeToMs(m.Groups[1].Value) : null;
    }

    // Bump every caption number by one so the credit block becomes number 1.
    private static string ShiftSrtIds(string srt) =>
        CaptionNumber().Replace(srt, m => $"{long.Parse(m.Groups[1].Value) + 1}{m.Groups[2].Value}");

    private static long SrtTimeToMs(string ts)
    {
        var parts = ts.Split(',');
        var hms = parts[0].Split(':');
        return long.Parse(hms[0]) * 3600000L + long.Parse(hms[1]) * 60000L +
               long.Parse(hms[2]) * 1000L + long.Parse(parts[1]);
    }

    private static string MsToSrtTime(long ms)
    {
        var h = ms / 3600000;
        var m = ms % 3600000 / 60000;
        var s = ms % 60000 / 1000;
        return $"{h:D2}:{m:D2}:{s:D2},{ms % 1000:D3}";
    }

    // ── ASS/SSA credit ──────────────────────────────────────────────────────

    // Insert a credit Dialogue line as the first event in [Events], following
    // the section's Format field order. Files without an Events/Format section
    // are returned unchanged rather than risk corrupting them.
    public static string AddCreditToAss(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return content;

        var eol = content.Contains("\r\n") ? "\r\n" : "\n";
        var lines = content.Split(eol);

        var inEvents = false;
        var inStyles = false;
        var formatLineIndex = -1;
        string[]? fields = null;
        string? firstStyleName = null;

        for (var i = 0; i < lines.Length; i++)
        {
            var header = AssSection().Match(lines[i]);
            if (header.Success)
            {
                var name = header.Groups[1].Value.ToLowerInvariant();
                inEvents = name == "events";
                inStyles = name is "v4+ styles" or "v4 styles";
                continue;
            }

            if (inStyles && firstStyleName == null && AssStyleLine().IsMatch(lines[i]))
            {
                var after = AssStyleLine().Replace(lines[i], "", 1);
                firstStyleName = after.Split(',')[0].Trim();
                if (firstStyleName.Length == 0) firstStyleName = "Default";
                continue;
            }

            if (inEvents && formatLineIndex == -1 && AssFormatLine().IsMatch(lines[i]))
            {
                fields = AssFormatLine().Replace(lines[i], "", 1).Split(',').Select(f => f.Trim()).ToArray();
                formatLineIndex = i;
            }
        }

        if (formatLineIndex == -1 || fields == null || fields.Length == 0) return content;

        var styleName = string.IsNullOrEmpty(firstStyleName) ? "Default" : firstStyleName;

        string ValueFor(string field) => field.ToLowerInvariant() switch
        {
            "layer" => "0",
            "start" => "0:00:00.00",
            "end" => AssSubtitleAdapter.MsToAssTime(CreditDurationMs),
            "style" => styleName,
            "name" => "",
            "marginl" or "marginr" or "marginv" => "0",
            "effect" => "",
            "text" => CreditText,
            _ => "",
        };

        var creditLine = $"Dialogue: {string.Join(",", fields.Select(ValueFor))}";

        var outLines = new List<string>(lines);
        outLines.Insert(formatLineIndex + 1, creditLine);
        return string.Join(eol, outLines);
    }

    [GeneratedRegex(@"\d+\r?\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->")]
    private static partial Regex FirstStartRegex();

    [GeneratedRegex(@"[/\\:*?""<>|]")]
    private static partial Regex ExportTitleStripRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex(@"^(\d+)(\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->)", RegexOptions.Multiline)]
    private static partial Regex CaptionNumber();

    [GeneratedRegex(@"^\s*\[([^\]]+)\]\s*$")]
    private static partial Regex AssSection();

    [GeneratedRegex(@"^\s*Style\s*:", RegexOptions.IgnoreCase)]
    private static partial Regex AssStyleLine();

    [GeneratedRegex(@"^\s*Format\s*:", RegexOptions.IgnoreCase)]
    private static partial Regex AssFormatLine();
}