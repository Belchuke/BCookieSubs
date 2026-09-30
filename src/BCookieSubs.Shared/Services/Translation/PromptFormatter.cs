using BCookieSubs.Shared.Database.Entities;

namespace BCookieSubs.Shared.Services.Translation;

public static class PromptFormatter
{
    public static string FormatTranslationPrompt(
        string promptText,
        Language sourceLang,
        Language targetLang,
        string mediaItemName,
        string? genres,
        string mediaType,
        string chunkXml) =>
        promptText
            .Replace("//sourceLang//", sourceLang.Name)
            .Replace("//sourceShortLang//", sourceLang.Iso639)
            .Replace("//targetLang//", targetLang.Name)
            .Replace("//targetShortLang//", targetLang.Iso639)
            .Replace("//genres//", genres ?? "unknown")
            .Replace("//mediaType//", mediaType)
            .Replace("//name//", mediaItemName)
        + "\n\n" + chunkXml;

    public static string FormatJudgePrompt(
        string promptText,
        Language sourceLang,
        Language targetLang,
        string mediaItemName,
        string sourceChunkXml,
        string? genres,
        string mediaType,
        List<(int Index, List<ParsedChunkRow> TranslatedRows)> candidates)
    {
        var candidateList = string.Join("\n\n", candidates.Select(c =>
        {
            var text = string.Join("\n", c.TranslatedRows.Select(r => $"[{r.Id}] {r.Text}"));
            return $"Candidate {c.Index}:\n{text}";
        }));

        return promptText
            .Replace("//sourceLang//", sourceLang.Name)
            .Replace("//targetLang//", targetLang.Name)
            .Replace("//name//", mediaItemName)
            .Replace("//sourceText//", sourceChunkXml)
            .Replace("//total//", candidates.Count.ToString())
            .Replace("//totalMinusOne//", (candidates.Count - 1).ToString())
            .Replace("//candidateList//", candidateList)
            .Replace("//genres//", genres ?? "unknown")
            .Replace("//mediaType//", mediaType);
    }
}