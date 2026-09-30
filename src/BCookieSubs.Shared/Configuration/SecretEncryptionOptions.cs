namespace BCookieSubs.Shared.Configuration;

public class SecretEncryptionOptions
{
    public const string SectionName = "SecretEncryption";
    public const string EnvVarName = "SECRET_ENCRYPTION_KEY";

    public string? MasterKey { get; set; }
}