namespace BCookieSubs.Shared.Database.Entities;

public class LibraryPathItemBlacklist
{
    public long Id { get; set; }
    public long LibraryPathItemId { get; set; }
    public LibraryPathItem LibraryPathItem { get; set; } = null!;

    public long? BlacklistedByUserId { get; set; }
    public ApplicationUser? BlacklistedByUser { get; set; }

    public string? Reason { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}