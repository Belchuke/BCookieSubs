namespace BCookieSubs.Shared.Database.Enums;


public enum ModelProvider
{
    Ollama,
    OllamaCloud,
    ChatGpt,
    Claude,
    Copilot,
    Custom
}

public enum ModelRoleKind
{
    Translation,
    Judge,
    FallbackJudge,
    NameFormatter
}

public enum PromptKind
{
    Translation,
    Judge,
    NameFormatter
}