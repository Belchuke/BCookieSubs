using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Services.Translation;

public static partial class AssSubtitleAdapter
{
    private static readonly string[] DefaultAssFields =
    [
        "Layer", "Start", "End", "Style", "Name",
        "MarginL", "MarginR", "MarginV", "Effect", "Text",
    ];

    public static long AssTimeToMs(string ts)
    {
        var m = AssTimeRegex().Match(ts.Trim());
        if (!m.Success) return 0;
        var h = int.Parse(m.Groups[1].Value);
        var mm = int.Parse(m.Groups[2].Value);
        var s = int.Parse(m.Groups[3].Value);
        var cs = int.Parse(m.Groups[4].Value.PadRight(2, '0'));
        return h * 3600000L + mm * 60000L + s * 1000L + cs * 10L;
    }

    public static string MsToAssTime(long ms)
    {
        if (ms < 0) ms = 0;
        var h = ms / 3600000;
        var m = ms % 3600000 / 60000;
        var s = ms % 60000 / 1000;
        var cs = ms % 1000 / 10;
        return $"{h}:{m:D2}:{s:D2}.{cs:D2}";
    }

    private static string DetectEol(string raw) => raw.Contains("\r\n") ? "\r\n" : "\n";

    private static int FindNthComma(string s, int n)
    {
        var seen = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] != ',') continue;
            seen++;
            if (seen == n) return i;
        }
        return -1;
    }

    private static string? SectionHeader(string line)
    {
        var m = SectionHeaderRegex().Match(line);
        return m.Success ? m.Groups[1].Value.ToLowerInvariant() : null;
    }

    public static List<SubtitleRow> ParseAssRows(string raw, SubtitleFormat format)
    {
        var eol = DetectEol(raw);
        var lines = raw.Split(eol);

        var inEvents = false;
        string[]? fields = null;
        var textFieldIndex = -1;
        var startFieldIndex = -1;
        var endFieldIndex = -1;

        var rows = new List<SubtitleRow>();
        long counter = 0;

        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];

            var header = SectionHeader(line);
            if (header != null)
            {
                inEvents = header == "events";
                if (inEvents)
                {
                    fields = null;
                    textFieldIndex = -1;
                    startFieldIndex = -1;
                    endFieldIndex = -1;
                }
                continue;
            }

            if (!inEvents) continue;

            if (FormatLineRegex().IsMatch(line))
            {
                fields = FormatLineRegex().Replace(line, "", 1)
                    .Split(',')
                    .Select(f => f.Trim())
                    .ToArray();
                textFieldIndex = Array.IndexOf(fields, "Text");
                if (textFieldIndex == -1) textFieldIndex = fields.Length - 1;
                startFieldIndex = Array.IndexOf(fields, "Start");
                endFieldIndex = Array.IndexOf(fields, "End");
                continue;
            }

            if (!DialogueLineRegex().IsMatch(line)) continue;
            if (fields == null)
            {
                fields = DefaultAssFields.ToArray();
                textFieldIndex = fields.Length - 1;
                startFieldIndex = 1;
                endFieldIndex = 2;
            }

            // Text is the textFieldIndex-th field (0-based), so the comma right
            // before it is the textFieldIndex-th comma (1-based). Text may
            // itself contain commas, so slice rather than split.
            var textCommaIndex = FindNthComma(line, textFieldIndex);
            if (textCommaIndex < 0) continue;

            var prefix = line[..(textCommaIndex + 1)];
            var text = line[(textCommaIndex + 1)..];
            var leadingFields = line[..textCommaIndex].Split(',');
            var startMs = startFieldIndex >= 0 ? AssTimeToMs(leadingFields[startFieldIndex]) : 0;
            var endMs = endFieldIndex >= 0 ? AssTimeToMs(leadingFields[endFieldIndex]) : 0;

            counter += 1;
            rows.Add(new SubtitleRow
            {
                Id = counter.ToString(),
                StartMs = startMs,
                EndMs = endMs,
                Text = text,
                OriginalText = text,
                Format = format,
                Meta = new SubtitleRowMeta { LineIndex = i, Prefix = prefix },
            });
        }

        return rows;
    }

    public static string SerializeAssFromRows(string rawOriginal, List<TranslatedRow> rows, SubtitleFormat format)
    {
        var clean = rawOriginal.Length > 0 && rawOriginal[0] == '﻿' ? rawOriginal[1..] : rawOriginal;
        var eol = DetectEol(clean);
        var lines = clean.Split(eol).ToList();

        var metaById = new Dictionary<string, (int LineIndex, string Prefix)>();
        foreach (var r in ParseAssRows(clean, format))
        {
            if (r.Meta is { LineIndex: not null, Prefix: not null })
            {
                metaById[r.Id] = (r.Meta.LineIndex.Value, r.Meta.Prefix);
            }
        }

        foreach (var row in rows)
        {
            if (!metaById.TryGetValue(row.Id, out var m)) continue;
            lines[m.LineIndex] = m.Prefix + (row.Text ?? "");
        }

        AppendTranslatedByCredit(lines);
        return string.Join(eol, lines);
    }

    // Offset editor: one timing change per Dialogue line. Text null keeps the
    // original text bytes; the serializer rewrites only the Start/End fields
    // inside each line's prefix, so headers, styles, comments and line endings
    // stay byte-for-byte identical. OrigStartMs/OrigEndMs are re-checked
    // against the line's parsed times so a file changed on disk is rejected.
    // Returns null on any mismatch.
    public sealed record AssTimingChange(
        int LineIndex, long StartMs, long EndMs, string? Text,
        long? OrigStartMs = null, long? OrigEndMs = null);

    public static string? ShiftDialogueTimings(
        string raw, SubtitleFormat format, IReadOnlyList<AssTimingChange> changes, bool addCredit)
    {
        var byIndex = new Dictionary<int, AssTimingChange>();
        foreach (var c in changes)
        {
            if (!byIndex.TryAdd(c.LineIndex, c)) return null;
        }

        var (lines, seps) = SubtitleTextUtils.SplitKeepEndings(raw);

        var inEvents = false;
        var applied = 0;
        string[]? fields = null;
        var textFieldIndex = -1;
        var startFieldIndex = -1;
        var endFieldIndex = -1;

        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];

            var header = SectionHeader(line);
            if (header != null)
            {
                inEvents = header == "events";
                if (inEvents)
                {
                    fields = null;
                    textFieldIndex = -1;
                    startFieldIndex = -1;
                    endFieldIndex = -1;
                }
                continue;
            }

            if (!inEvents) continue;

            if (FormatLineRegex().IsMatch(line))
            {
                fields = FormatLineRegex().Replace(line, "", 1)
                    .Split(',')
                    .Select(f => f.Trim())
                    .ToArray();
                textFieldIndex = Array.IndexOf(fields, "Text");
                if (textFieldIndex == -1) textFieldIndex = fields.Length - 1;
                startFieldIndex = Array.IndexOf(fields, "Start");
                endFieldIndex = Array.IndexOf(fields, "End");
                continue;
            }

            if (!DialogueLineRegex().IsMatch(line)) continue;
            if (fields == null)
            {
                fields = DefaultAssFields.ToArray();
                textFieldIndex = fields.Length - 1;
                startFieldIndex = 1;
                endFieldIndex = 2;
            }

            if (!byIndex.TryGetValue(i, out var change)) continue;
            if (startFieldIndex < 0 || endFieldIndex < 0) return null;
            var textCommaIndex = FindNthComma(line, textFieldIndex);
            if (textCommaIndex < 0) return null;

            var leadingFields = line[..textCommaIndex].Split(',');
            var parsedStart = startFieldIndex < leadingFields.Length ? AssTimeToMs(leadingFields[startFieldIndex]) : -1;
            var parsedEnd = endFieldIndex < leadingFields.Length ? AssTimeToMs(leadingFields[endFieldIndex]) : -1;
            if (change.OrigStartMs is { } os && parsedStart != os) return null;
            if (change.OrigEndMs is { } oe && parsedEnd != oe) return null;

            var prefix = ReplaceAssField(
                ReplaceAssField(line[..(textCommaIndex + 1)], startFieldIndex, MsToAssTime(change.StartMs)),
                endFieldIndex, MsToAssTime(change.EndMs));
            lines[i] = prefix + (change.Text ?? line[(textCommaIndex + 1)..]);
            applied++;
        }

        if (applied != changes.Count) return null;
        var result = SubtitleTextUtils.JoinKeepEndings(lines, seps);
        return addCredit ? SubtitleExport.AddCreditToAss(result) : result;
    }

    // The prefix holds the leading fields plus the trailing comma; split/join
    // on ',' reproduces every byte except the replaced field's value.
    private static string ReplaceAssField(string prefix, int fieldIndex, string value)
    {
        var parts = prefix.Split(',');
        if (fieldIndex < 0 || fieldIndex >= parts.Length - 1) return prefix;
        parts[fieldIndex] = value;
        return string.Join(",", parts);
    }

    // "; Translated by BCookieSubs" comment as the first line of [Script Info],
    // guarded against duplicates. Runs after the Text swap so the per-row line
    // indexes captured above still point at the original lines.
    private static void AppendTranslatedByCredit(List<string> lines)
    {
        const string creditLine = "; Translated by BCookieSubs";
        var scriptInfoHeaderIndex = -1;
        for (var i = 0; i < lines.Count; i++)
        {
            if (SectionHeader(lines[i]) == "script info")
            {
                scriptInfoHeaderIndex = i;
                break;
            }
        }
        if (scriptInfoHeaderIndex < 0) return;

        for (var j = scriptInfoHeaderIndex + 1; j < lines.Count; j++)
        {
            if (SectionHeader(lines[j]) != null) break;
            if (lines[j].Trim() == creditLine) return;
        }

        lines.Insert(scriptInfoHeaderIndex + 1, creditLine);
    }

    [GeneratedRegex(@"^\s*\[([^\]]+)\]\s*$")]
    private static partial Regex SectionHeaderRegex();

    [GeneratedRegex(@"^(\d+):(\d{2}):(\d{2})\.(\d{1,2})$")]
    private static partial Regex AssTimeRegex();

    [GeneratedRegex(@"^\s*Format\s*:", RegexOptions.IgnoreCase)]
    private static partial Regex FormatLineRegex();

    [GeneratedRegex(@"^\s*Dialogue\s*:", RegexOptions.IgnoreCase)]
    private static partial Regex DialogueLineRegex();
}