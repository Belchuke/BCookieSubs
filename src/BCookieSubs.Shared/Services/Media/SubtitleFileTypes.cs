using System.Text;

namespace BCookieSubs.Shared.Services.Media;

public static class SubtitleFileTypes
{
    public static readonly HashSet<string> SubtitleExtensions = [".srt", ".ass", ".ssa"];
    public static readonly HashSet<string> SubFileExtensions = [".sub", ".sup"];

    public static readonly HashSet<string> VobSubCodecs =
    [
        "vobsub",
        "dvd_subtitle",
    ];

    public static readonly HashSet<string> PgsCodecs =
    [
        "hdmv_pgs_subtitle",
        "pgssub",
        "hdmv_pgs",
        "hdmv pgs",
    ];

    public static readonly HashSet<string> MkvTextCodecs =
    [
        "SubRip/SRT",
        "SubStationAlpha",
        "Advanced SubStation Alpha",
        "WebVTT",
    ];

    public static readonly HashSet<string> FfmpegTextCodecs =
    [
        "subrip", "srt", "mov_text", "ass", "ssa", "webvtt",
    ];

    public static bool IsSubtitleExtension(string extension) =>
        SubtitleExtensions.Contains(extension.ToLowerInvariant()) ||
        SubFileExtensions.Contains(extension.ToLowerInvariant());

    public static string? SubtitleFileExtensionOf(string filename)
    {
        var ext = Path.GetExtension(filename).ToLowerInvariant();
        return IsSubtitleExtension(ext) ? ext : null;
    }

    public static bool IsSubFile(string filename) =>
        Path.GetExtension(filename).Equals(".sub", StringComparison.OrdinalIgnoreCase);

    public static bool IsSupFile(string filename) =>
        Path.GetExtension(filename).Equals(".sup", StringComparison.OrdinalIgnoreCase);

    public static string? ImageSubtitleKindFromCodec(string? codec)
    {
        if (codec is null) return null;
        var c = codec.ToLowerInvariant();
        if (VobSubCodecs.Contains(c)) return "vobsub";
        if (PgsCodecs.Contains(c)) return "pgs";
        return null;
    }

    public static bool IsAssCodec(string? codec)
    {
        if (codec is null) return false;
        var c = codec.ToLowerInvariant();
        return c is "ass" or "ssa" or "advanced substation alpha" or "substationalpha";
    }

    public static string CodecToSubtitleExt(string? codec)
    {
        if (codec is null) return ".srt";
        var c = codec.ToLowerInvariant();
        if (c is "ass" or "advanced substation alpha") return ".ass";
        if (c is "ssa" or "substationalpha") return ".ssa";
        return ".srt";
    }

    public static string StripUtf8Bom(string text) =>
        text.Length > 0 && text[0] == '﻿' ? text[1..] : text;

    public static string ReadTextStrippingBom(string path)
    {
        var text = File.ReadAllText(path, Encoding.UTF8);
        return StripUtf8Bom(text);
    }
}

public static class OcrLanguageMapper
{
    public const string FallbackOcrLang = "eng";

    private static readonly Dictionary<string, string> AppLangToTesseract = new()
    {
        ["en"] = "eng", ["da"] = "dan", ["th"] = "tha", ["ja"] = "jpn", ["de"] = "deu",
        ["fr"] = "fra", ["es"] = "spa", ["it"] = "ita", ["pt"] = "por", ["ru"] = "rus",
        ["ko"] = "kor", ["zh"] = "chi_sim", ["ar"] = "ara", ["hi"] = "hin", ["tr"] = "tur",
        ["nl"] = "nld", ["pl"] = "pol", ["sv"] = "swe", ["no"] = "nor", ["fi"] = "fin",
        ["el"] = "ell", ["cs"] = "ces", ["he"] = "heb", ["hu"] = "hun", ["ro"] = "ron",
        ["vi"] = "vie", ["id"] = "ind", ["uk"] = "ukr", ["bg"] = "bul", ["hr"] = "hrv",
        ["sr"] = "srp", ["sk"] = "slk", ["sl"] = "slv", ["et"] = "est", ["lv"] = "lav",
        ["lt"] = "lit", ["fa"] = "fas", ["ca"] = "cat", ["gl"] = "glg", ["bn"] = "ben",
        ["ta"] = "tam", ["te"] = "tel", ["ml"] = "mal", ["pa"] = "pan",
        ["eng"] = "eng", ["dan"] = "dan", ["tha"] = "tha", ["jpn"] = "jpn", ["ger"] = "deu",
        ["deu"] = "deu", ["fre"] = "fra", ["fra"] = "fra", ["spa"] = "spa", ["ita"] = "ita",
        ["por"] = "por", ["rus"] = "rus", ["kor"] = "kor", ["chi"] = "chi_sim", ["zho"] = "chi_sim",
        ["ara"] = "ara", ["hin"] = "hin", ["tur"] = "tur", ["dut"] = "nld", ["nld"] = "nld",
        ["pol"] = "pol", ["swe"] = "swe", ["nor"] = "nor", ["fin"] = "fin", ["gre"] = "ell",
        ["ell"] = "ell", ["cze"] = "ces", ["ces"] = "ces", ["heb"] = "heb", ["hun"] = "hun",
        ["rum"] = "ron", ["ron"] = "ron", ["vie"] = "vie", ["ind"] = "ind", ["ukr"] = "ukr",
        ["bul"] = "bul", ["hrv"] = "hrv", ["srp"] = "srp", ["slo"] = "slk", ["slk"] = "slk",
        ["slv"] = "slv", ["est"] = "est", ["lav"] = "lav", ["lit"] = "lit", ["per"] = "fas",
        ["fas"] = "fas", ["cat"] = "cat", ["glg"] = "glg", ["ben"] = "ben", ["tam"] = "tam",
        ["tel"] = "tel", ["mal"] = "mal", ["pan"] = "pan",
    };

    public static string AppLangToTesseractLang(string? appLang)
    {
        if (string.IsNullOrEmpty(appLang)) return FallbackOcrLang;
        return AppLangToTesseract.TryGetValue(appLang.ToLowerInvariant(), out var mapped)
            ? mapped
            : FallbackOcrLang;
    }

    public static string ResolveOcrLang(params string?[] hints)
    {
        foreach (var hint in hints)
        {
            if (string.IsNullOrEmpty(hint)) continue;
            if (AppLangToTesseract.TryGetValue(hint.ToLowerInvariant(), out var mapped)) return mapped;
        }
        return FallbackOcrLang;
    }
}