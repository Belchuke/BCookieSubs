using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Services.Translation;

public record SubtitleRowMeta
{
    public string? StartTime { get; init; }
    public string? EndTime { get; init; }

    public int? LineIndex { get; init; }
    public string? Prefix { get; init; }
}

public record SubtitleRow
{
    public required string Id { get; init; }
    public long StartMs { get; init; }
    public long EndMs { get; init; }
    public required string Text { get; init; }
    public required string OriginalText { get; init; }
    public required SubtitleFormat Format { get; init; }
    public SubtitleRowMeta? Meta { get; init; }
}

public record TranslatedRow(string Id, string? Text);

public record ParsedChunk(List<ParsedChunkRow> Rows, string Xml);
public record ParsedChunkRow(string Id, string Text);

public static class SubtitleAdapter
{
    public static List<SubtitleRow> ParseSubtitleRows(string raw, SubtitleFormat format) =>
        format is SubtitleFormat.Ass or SubtitleFormat.Ssa
            ? AssSubtitleAdapter.ParseAssRows(raw, format)
            : SrtSubtitleAdapter.ParseSrtRows(raw);

    public static string SerializeSubtitle(string rawOriginal, List<TranslatedRow> rows, SubtitleFormat format) =>
        format is SubtitleFormat.Ass or SubtitleFormat.Ssa
            ? AssSubtitleAdapter.SerializeAssFromRows(rawOriginal, rows, format)
            : SrtSubtitleAdapter.SerializeSrtFromRows(rawOriginal, rows);
}

public static class SrtSubtitleAdapter
{
    public static List<SubtitleRow> ParseSrtRows(string raw) =>
        SrtParser.Parse(raw)
            .Select(e => new SubtitleRow
            {
                Id = e.Id,
                StartMs = e.StartMs,
                EndMs = e.EndMs,
                Text = e.Text,
                OriginalText = e.Text,
                Format = SubtitleFormat.Srt,
                Meta = new SubtitleRowMeta { StartTime = e.StartTime, EndTime = e.EndTime },
            })
            .ToList();

    public static string SerializeSrtFromRows(string rawOriginal, List<TranslatedRow> rows)
    {
        var translated = new Dictionary<string, string>();
        foreach (var row in rows) translated[row.Id] = row.Text ?? "";

        var lines = new List<string>();
        var counter = 0;
        foreach (var e in SrtParser.Parse(rawOriginal))
        {
            counter += 1;
            lines.Add(counter.ToString());
            lines.Add($"{e.StartTime} --> {e.EndTime}");
            lines.Add(translated.TryGetValue(e.Id, out var text) ? text : e.Text);
            lines.Add("");
        }
        return string.Join("\n", lines);
    }
}