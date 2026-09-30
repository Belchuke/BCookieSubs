namespace BCookieSubs.Shared.Common;

public static class CapabilityNames
{
    public const string Whisper = "whisper";
    public const string Ocr = "ocr";
    public const string Vision = "vision";

    public static readonly IReadOnlyList<string> All = [Whisper, Ocr, Vision];

    public static IReadOnlyList<string> Normalize(IEnumerable<string> reported) =>
        reported.Where(c => All.Contains(c)).Distinct().ToList();
}