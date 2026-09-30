namespace BCookieSubs.Shared.Security;

public static class SecretKeys
{
    public const string TmdbApiKey = "tmdbApiKey";
    public const string OllamaApiKey = "ollamaApiKey";
    public const string OpenAiApiKey = "openAiApiKey";
    public const string AnthropicApiKey = "anthropicApiKey";

    public static readonly IReadOnlyDictionary<string, string> EnvironmentVariables = new Dictionary<string, string>
    {
        ["THEMOVIEDB_API_KEY"] = TmdbApiKey,
        ["OLLAMA_API_KEY"] = OllamaApiKey,
        ["OPENAI_API_KEY"] = OpenAiApiKey,
        ["ANTHROPIC_API_KEY"] = AnthropicApiKey,
    };

    public static string SftpPassword(long libraryPathId) => $"sftp:{libraryPathId}:password";
    public static string SftpPrivateKey(long libraryPathId) => $"sftp:{libraryPathId}:privateKey";
    public static string SftpKeyPassphrase(long libraryPathId) => $"sftp:{libraryPathId}:keyPassphrase";
}