namespace BCookieSubs.Shared.Database.Entities;

public class ApplicationSecret
{
    public long Id { get; set; }

    public string Key { get; set; } = "";

    public byte[] Ciphertext { get; set; } = [];
    public byte[] Nonce { get; set; } = [];
    public byte[] Tag { get; set; } = [];

    public string Algorithm { get; set; } = "aes-256-gcm";

    /// <summary>True when the value was last synced from the environment, not set by a user.</summary>
    public bool SetByEnv { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}