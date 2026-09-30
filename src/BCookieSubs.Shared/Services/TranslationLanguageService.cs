using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;

namespace BCookieSubs.Shared.Services;

public record TranslationLanguageRow(
    long LanguageId, string Name, string? Iso639, string? Locale, string? Flag, int Position)
{
    public string? FlagCode => FlagCodes.Derive(Locale);
}

public class TranslationLanguageService(LanguageRepository languages, AuditService audit)
{
    public async Task<List<TranslationLanguageRow>> GetGlobalAsync(CancellationToken ct = default)
    {
        var rows = await languages.GetDefaultTranslationLanguagesAsync(ct);
        return rows.Select(r => Map(r.LanguageId, r.Language, r.Position)).ToList();
    }

    public async Task<List<TranslationLanguageRow>> GetUserAsync(long userId, CancellationToken ct = default)
    {
        var rows = await languages.GetUserTranslationLanguagesAsync(userId, ct);
        return rows.Select(r => Map(r.LanguageId, r.Language, r.Position)).ToList();
    }

    public async Task<(bool Ok, string? Error)> ReplaceGlobalAsync(
        long actingUserId, List<long> languageIds, CancellationToken ct = default)
    {
        var ids = languageIds.Distinct().ToList();
        if (ids.Count == 0)
        {
            return (false, "Add at least one language before continuing");
        }

        var known = await languages.GetAllAsync(ct);
        var unknown = ids.Where(id => known.All(l => l.Id != id)).ToList();
        if (unknown.Count > 0)
        {
            return (false, "Unknown language submitted");
        }

        await languages.ReplaceConfigLanguagesAsync(ids, ct);
        await languages.SyncUserLanguagesFromGlobalAsync(actingUserId, ct);
        await audit.AdminActionAsync("globalLanguagesReplaced", "language", null,
            $"Set the global translation list to {ids.Count} languages");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> AddGlobalAsync(
        long actingUserId, long languageId, CancellationToken ct = default)
    {
        var language = await languages.GetAsync(languageId, ct);
        if (language is null)
        {
            return (false, "Language not found");
        }

        if (!await languages.AddConfigLanguageAsync(languageId, ct))
        {
            return (false, "Language is already in the translation list");
        }

        await languages.SyncUserLanguagesFromGlobalAsync(actingUserId, ct);
        await audit.AdminActionAsync("globalLanguageAdded", "language", languageId,
            $"Added {language.Name} to the global translation list");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> RemoveGlobalAsync(
        long actingUserId, long languageId, CancellationToken ct = default)
    {
        var language = await languages.GetAsync(languageId, ct);
        if (language is null)
        {
            return (false, "Language not found");
        }

        if (!await languages.RemoveConfigLanguageAsync(languageId, ct))
        {
            return (false, "Language not found");
        }

        await languages.SyncUserLanguagesFromGlobalAsync(actingUserId, ct);
        await audit.AdminActionAsync("globalLanguageRemoved", "language", languageId,
            $"Removed {language.Name} from the global translation list");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> MoveGlobalAsync(
        long actingUserId, long languageId, int direction, CancellationToken ct = default)
    {
        var language = await languages.GetAsync(languageId, ct);
        if (language is null)
        {
            return (false, "Language not found");
        }

        if (!await languages.MoveConfigLanguageAsync(languageId, direction, ct))
        {
            return (false, "Language not found");
        }

        await languages.SyncUserLanguagesFromGlobalAsync(actingUserId, ct);
        await audit.AdminActionAsync("globalLanguageMoved", "language", languageId,
            $"Moved {language.Name} {(direction < 0 ? "up" : "down")} in the global translation list");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> AddUserLanguageAsync(
        long targetUserId, long languageId, CancellationToken ct = default)
    {
        var language = await languages.GetAsync(languageId, ct);
        if (language is null)
        {
            return (false, "Language not found");
        }

        if (!await languages.AddUserLanguageAsync(targetUserId, languageId, ct))
        {
            return (false, "Language is already in the user's translation list");
        }

        await audit.AdminActionAsync("userLanguageAdded", "user", targetUserId,
            $"Added {language.Name} to user translation list");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> RemoveUserLanguageAsync(
        long targetUserId, long languageId, CancellationToken ct = default)
    {
        var language = await languages.GetAsync(languageId, ct);
        if (language is null)
        {
            return (false, "Language not found");
        }

        if (!await languages.RemoveUserLanguageAsync(targetUserId, languageId, ct))
        {
            return (false, "Language not found");
        }

        await audit.AdminActionAsync("userLanguageRemoved", "user", targetUserId,
            $"Removed {language.Name} from user translation list");
        return (true, null);
    }

    public async Task<(bool Ok, string? Error)> MoveUserLanguageAsync(
        long targetUserId, long languageId, int direction, CancellationToken ct = default)
    {
        var language = await languages.GetAsync(languageId, ct);
        if (language is null)
        {
            return (false, "Language not found");
        }

        if (!await languages.MoveUserLanguageAsync(targetUserId, languageId, direction, ct))
        {
            return (false, "Language not found");
        }

        await audit.AdminActionAsync("userLanguageMoved", "user", targetUserId,
            $"Moved {language.Name} {(direction < 0 ? "up" : "down")} in user translation list");
        return (true, null);
    }

    private static TranslationLanguageRow Map(long languageId, Language language, int position) =>
        new(languageId, language.Name, language.Iso639, language.Locale, language.Flag, position);
}