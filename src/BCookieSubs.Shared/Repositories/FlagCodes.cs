namespace BCookieSubs.Shared.Repositories;

public static class FlagCodes
{
    public static string? Derive(string? locale)
    {
        if (string.IsNullOrEmpty(locale))
        {
            return null;
        }

        var lower = locale.ToLowerInvariant();
        switch (lower)
        {
            case "cy-gb": return "gb-wls";
            case "gd-gb": return "gb-sct";
            case "ga-ie": return "ie";
            case "eu-es": return "es";
            case "ca-es": return "es";
            case "gl-es": return "es";
            case "eo-001": return "un";
        }

        var parts = lower.Split('-');
        return parts.Length >= 2 ? parts[1] : null;
    }
}