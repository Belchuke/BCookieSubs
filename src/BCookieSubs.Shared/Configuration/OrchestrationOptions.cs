namespace BCookieSubs.Shared.Configuration;

public class OrchestrationOptions
{
    public const string SectionName = "Orchestration";

    public string Url { get; set; } = "http://localhost:5100";
    public string ApiKey { get; set; } = "";
}

/// <summary>Signing material for short-lived worker JWTs.</summary>
public class WorkerJwtOptions
{
    public const string SectionName = "Worker";

    public string SigningKey { get; set; } = "";
    public string Issuer { get; set; } = "bcookiesubs";
    public string Audience { get; set; } = "bcookiesubs-worker";
    public int LifetimeMinutes { get; set; } = 720;

    public string BootstrapToken { get; set; } = "";
}