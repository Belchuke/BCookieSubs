namespace BCookieSubs.Shared.Database.Seeding;

public static class ThemeSeedData
{
    public sealed record Row(
        string Name, string Bg, string Surface, string Surface2, string Surface3,
        string BorderColor, string TextColor, string TextDim, string TextHint,
        string Accent, string AccentDim, string Success, string SuccessDim,
        string Warning, string WarningDim, string Error, string ErrorDim, string InfoDim);

    public static readonly IReadOnlyList<Row> Rows =
    [
        new("Default Blue", "#0f1117", "#1a1b23", "#252636", "#2e3048", "#2a2b3d", "#e2e4f0", "#6b7280", "#4b5563", "#4a9eff", "#1e3a5f", "#34d399", "#064e3b", "#fbbf24", "#451a03", "#f87171", "#450a0a", "#1e3a5f"),
        new("Midnight Indigo", "#0b1020", "#151b2f", "#1d2640", "#273252", "#2a3656", "#e6eaf7", "#94a3b8", "#64748b", "#7c8cff", "#2c356b", "#3dd9a3", "#103b31", "#f6c453", "#4a3510", "#ff7b7b", "#4d1f24", "#1f3f68"),
        new("Emerald Night", "#0b1411", "#12201b", "#183029", "#214136", "#295143", "#e6f3ee", "#8ca39a", "#61756d", "#34d399", "#124737", "#4ade80", "#123922", "#fbbf24", "#4b3206", "#fb7185", "#4b1d26", "#1d4b43"),
        new("Carbon Amber", "#111111", "#1a1a1a", "#242424", "#2f2f2f", "#3b3b3b", "#f0ece4", "#a1a1aa", "#71717a", "#f59e0b", "#5a3a08", "#22c55e", "#16351f", "#fbbf24", "#4a3206", "#f87171", "#4a1e1e", "#5b4320"),
        new("Rose Noir", "#120f14", "#1b1620", "#251d2d", "#31263b", "#3a2d47", "#f3eaf2", "#a78fa4", "#746474", "#e879f9", "#5b2b63", "#34d399", "#123b30", "#fbbf24", "#4a3206", "#fb7185", "#4d1f2a", "#4a2f68"),
        new("Arctic Slate", "#0f1720", "#18212b", "#212c38", "#2b3847", "#364658", "#e8eef5", "#94a3b8", "#64748b", "#38bdf8", "#1c4a63", "#4ade80", "#153826", "#facc15", "#4a3b09", "#f87171", "#4a1f23", "#1f4f66"),
        new("Neon Cyan", "#07131a", "#0d1f28", "#14303b", "#1b4250", "#25586a", "#e6fbff", "#8fb4bd", "#5f7f87", "#22d3ee", "#11414a", "#2dd4bf", "#103833", "#facc15", "#493c0a", "#fb7185", "#4b1d27", "#174859"),
        new("Royal Plum", "#120d1b", "#1b1527", "#261d36", "#32274a", "#43335f", "#f1eafe", "#ab9bc8", "#796b94", "#a78bfa", "#3e3163", "#34d399", "#123b30", "#fbbf24", "#4b3206", "#fb7185", "#4d1f2a", "#3b3f72"),
        new("Forest Moss", "#0c120d", "#151d16", "#1e2a21", "#28382c", "#35483a", "#edf3ea", "#98a692", "#6b7868", "#84cc16", "#365114", "#4ade80", "#163720", "#facc15", "#4a3b09", "#f87171", "#4a1f23", "#2f4f3d"),
        new("Sunset Coral", "#18110f", "#221714", "#2f1f1a", "#3d2821", "#52352b", "#f8ece7", "#b59a90", "#836b63", "#fb7185", "#5a2831", "#34d399", "#123b30", "#f59e0b", "#4b3206", "#ef4444", "#4a1f23", "#5a3a32"),
        new("Ocean Steel", "#0b1418", "#122028", "#1a2d37", "#233a47", "#304c5d", "#e7f1f5", "#93a9b4", "#667d88", "#60a5fa", "#203f66", "#2dd4bf", "#123732", "#fbbf24", "#49330a", "#f87171", "#4a2023", "#1f4f66"),
        new("Grape Soda", "#140f17", "#1d1522", "#291d30", "#35263e", "#473254", "#f4ebf7", "#ac97b3", "#78677d", "#c084fc", "#503269", "#34d399", "#123b30", "#fbbf24", "#4b3206", "#fb7185", "#4b1d27", "#4a3b63"),
        new("Sandstone Dark", "#15120f", "#1f1a15", "#2b241d", "#382f27", "#4a3f34", "#f4eee5", "#ab9e90", "#786d62", "#d97706", "#5a3408", "#22c55e", "#163420", "#facc15", "#4a3a09", "#f87171", "#4a1f23", "#5a4531"),
        new("Mint Graphite", "#0e1312", "#161d1b", "#202926", "#2a3531", "#384640", "#ecf5f2", "#97a8a1", "#6b7a74", "#5eead4", "#1e4c46", "#4ade80", "#163720", "#fbbf24", "#4b3206", "#fb7185", "#4b1d27", "#24545a"),
        new("Crimson Night", "#140c0d", "#1d1315", "#281b1e", "#342427", "#472f34", "#f7ebec", "#b19a9d", "#7c686c", "#ef4444", "#5b2323", "#22c55e", "#163420", "#f59e0b", "#4b3206", "#fb7185", "#4b1d27", "#5a3138"),
        new("Lavender Ice", "#10131a", "#171c27", "#212838", "#2c3549", "#3a4560", "#eef1fb", "#9ca7c2", "#6d7893", "#8b5cf6", "#38285f", "#34d399", "#123b30", "#fbbf24", "#4b3206", "#f87171", "#4a2023", "#334a72"),
    ];

    public const string DefaultThemeName = "Default Blue";
}