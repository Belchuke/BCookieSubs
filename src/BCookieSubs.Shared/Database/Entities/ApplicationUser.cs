using Microsoft.AspNetCore.Identity;

namespace BCookieSubs.Shared.Database.Entities;

public class ApplicationUser : IdentityUser<long>
{
    public DateTime CreatedAt { get; set; }

    public DateTime? DeletedAt { get; set; }

    public bool HasSeenTutorial { get; set; }

    public long? SelectedThemeId { get; set; }
    public Theme? SelectedTheme { get; set; }

    public bool ShowPosters { get; set; } = true;

    public string? Language { get; set; }
}

public class ApplicationRole : IdentityRole<long>
{
    public DateTime CreatedAt { get; set; }

    public int Level { get; set; }
    public string? Description { get; set; }
}