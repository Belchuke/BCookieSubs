namespace BCookieSubs.Shared.Database.Entities;

public class Theme
{
    public long Id { get; set; }
    public string Name { get; set; } = "";
    public string Bg { get; set; } = "";
    public string Surface { get; set; } = "";
    public string Surface2 { get; set; } = "";
    public string Surface3 { get; set; } = "";
    public string BorderColor { get; set; } = "";
    public string TextColor { get; set; } = "";
    public string TextDim { get; set; } = "";
    public string TextHint { get; set; } = "";
    public string Accent { get; set; } = "";
    public string AccentDim { get; set; } = "";
    public string Success { get; set; } = "";
    public string SuccessDim { get; set; } = "";
    public string Warning { get; set; } = "";
    public string WarningDim { get; set; } = "";
    public string Error { get; set; } = "";
    public string ErrorDim { get; set; } = "";
    public string InfoDim { get; set; } = "";

    /// <summary>Public themes are built-in and cannot be deleted.</summary>
    public bool IsPublic { get; set; }

    public long? CreatedByUserId { get; set; }
    public ApplicationUser? CreatedByUser { get; set; }

    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}