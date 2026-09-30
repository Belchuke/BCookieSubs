namespace BCookieSubs.Shared.Services.Translation;

public record OffsetScope(string Type, int StartIndex = 0, int FromIndex = 0, int ToIndex = 0, int Index = 0)
{
    public static readonly OffsetScope All = new("all");
}

public record OffsetEntry(
    string Id, long StartMs, long EndMs, string StartTime, string EndTime, string Text,
    int? Line = null, long? FrameStart = null, long? FrameEnd = null,
    long? OrigStart = null, long? OrigEnd = null);

public static class SrtOffsetService
{
    public const long MaxOffsetMs = 300_000;

    public static long ValidateOffsetMs(long offsetMs)
    {
        if (offsetMs > MaxOffsetMs) return MaxOffsetMs;
        if (offsetMs < -MaxOffsetMs) return -MaxOffsetMs;
        return offsetMs;
    }

    public static List<SrtEntry> ApplyOffset(List<SrtEntry> entries, long offsetMs, OffsetScope scope)
    {
        var delta = ValidateOffsetMs(offsetMs);
        if (delta == 0) return entries.Select(e => e with { }).ToList();

        return entries.Select((e, idx) =>
        {
            var inScope = scope.Type switch
            {
                "from" => idx >= scope.StartIndex,
                "single" => idx == scope.Index,
                "range" => idx >= scope.FromIndex && idx <= scope.ToIndex,
                _ => true,
            };
            if (!inScope) return e with { };

            var safeStart = Math.Max(0, e.StartMs + delta);
            var safeEnd = Math.Max(safeStart + 1, e.EndMs + delta);
            return e with { StartMs = safeStart, EndMs = safeEnd, StartTime = SrtParser.MsToSrtTime(safeStart), EndTime = SrtParser.MsToSrtTime(safeEnd) };
        }).ToList();
    }

    public static List<OffsetEntry> ApplyOffsetEntries(List<OffsetEntry> entries, long offsetMs, OffsetScope scope, double? fps)
    {
        var delta = ValidateOffsetMs(offsetMs);
        if (delta == 0) return entries.Select(e => e with { }).ToList();

        if (fps is not > 0 && entries.Any(e => e.FrameStart is not null || e.FrameEnd is not null))
            throw new MicroDvdFpsRequiredException();

        var frameOffset = fps is > 0 ? (long)Math.Round(delta / 1000.0 * fps.Value) : 0;

        return entries.Select((e, idx) =>
        {
            var inScope = scope.Type switch
            {
                "from" => idx >= scope.StartIndex,
                "single" => idx == scope.Index,
                "range" => idx >= scope.FromIndex && idx <= scope.ToIndex,
                _ => true,
            };
            if (!inScope) return e with { };

            if (e.FrameStart is { } startFrame && e.FrameEnd is { } endFrame && frameOffset != 0)
            {
                var newStart = Math.Max(0, startFrame + frameOffset);
                var newEnd = Math.Max(newStart, endFrame + frameOffset);
                var startMs = FrameToMs(newStart, fps!.Value);
                var endMs = FrameToMs(newEnd, fps.Value);
                return e with
                {
                    FrameStart = newStart,
                    FrameEnd = newEnd,
                    StartMs = startMs,
                    EndMs = endMs,
                    StartTime = SrtParser.MsToSrtTime(startMs),
                    EndTime = SrtParser.MsToSrtTime(endMs),
                };
            }

            var safeStart = Math.Max(0, e.StartMs + delta);
            var safeEnd = Math.Max(safeStart + 1, e.EndMs + delta);
            return e with
            {
                StartMs = safeStart,
                EndMs = safeEnd,
                StartTime = SrtParser.MsToSrtTime(safeStart),
                EndTime = SrtParser.MsToSrtTime(safeEnd),
            };
        }).ToList();
    }

    public static long FrameToMs(long frame, double fps) => (long)Math.Round(frame / fps * 1000);
}