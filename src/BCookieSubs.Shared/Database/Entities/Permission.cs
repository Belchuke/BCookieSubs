namespace BCookieSubs.Shared.Database.Entities;

public class Permission
{
    public long Id { get; set; }
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public string Description { get; set; } = "";
    public string? Category { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}