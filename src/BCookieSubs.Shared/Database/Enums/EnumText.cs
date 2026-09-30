namespace BCookieSubs.Shared.Database.Enums;

public static class EnumText
{
    public static string Snake<T>(T value) where T : struct, Enum
    {
        var name = value.ToString()!;
        var sb = new System.Text.StringBuilder(name.Length + 4);
        for (var i = 0; i < name.Length; i++)
        {
            if (char.IsUpper(name[i]) && i > 0) sb.Append('_');
            sb.Append(char.ToLowerInvariant(name[i]));
        }
        return sb.ToString();
    }
}