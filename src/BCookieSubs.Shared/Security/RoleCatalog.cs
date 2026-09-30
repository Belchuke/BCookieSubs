namespace BCookieSubs.Shared.Security;

public static class RoleCatalog
{
    public sealed record Definition(string Name, int Level, string Description, IReadOnlyList<string> Permissions);

    private static readonly string[] UserPermissions =
    [
        "canAddSubtitleToTranslateFromLibrary",
    ];

    private static readonly string[] SuperUserPermissions =
    [
        .. UserPermissions,
        "canChangeSubtitlePriority",
        "canRestartTranslationChunk",
    ];

    private static readonly string[] MasterUserPermissions =
    [
        .. SuperUserPermissions,
        "canCreateSubtitlesWithWhisper",
        "canAddSubtitleToTranslateDashboard",
        "canViewFinishedTranslatedPage",
        "canManageWorker",
        "canCancelTranslationJob",
        "canDeleteTranslation",
        "canViewStatistics",
        "canViewSchedules",
        "canViewLogs",
        "canViewLibraryPathsPage",
        "canChangeMatchForLibraryPaths",
        "canBlackListALibraryPathItem",
        "canViewLogsDashboard",
        "canViewPromptsPage",
        "canViewModelsPage",
        "canDownloadFinishedSubtitles",
        "canViewOffsetPage",
        Permissions.WorkersView,
    ];

    private static readonly string[] AdminPermissions =
    [
        .. MasterUserPermissions,
        "canAddOrInstallAModel",
        "canEditModels",
        "canManageModelRoles",
        "canRemoveAndDeleteModels",
        "canManagePrompts",
        "canViewUsers",
        "canViewSettingsPage",
        Permissions.WorkersManage,
    ];

    private static readonly string[] OwnerPermissions =
    [
        .. AdminPermissions,
        "canEditPermissions",
        "canChangeOtherUsersPassword",
        "canManageRoles",
        "canAddUser",
        "canAddPathForLibraryPaths",
        "canEditLibraryPath",
        "canDisableAndDeleteALibraryPath",
        "canManageSettings",
        "canManageSecrets",
        "canManageSchedules",
        "canEditSubtitleOffsets",
    ];

    public static readonly IReadOnlyList<Definition> Definitions =
    [
        new("User", 10, "Basic user who can see translation status and request translations from library/request flows.", UserPermissions),
        new("SuperUser", 20, "User with additional control over translation priority and chunk retries.", SuperUserPermissions),
        new("MasterUser", 30, "Power user with access to dashboard translation management, completed subtitles, stats, logs, models/prompts view, and library path actions.", MasterUserPermissions),
        new("Admin", 40, "Admin user who can manage models, prompts, users view, and settings view.", AdminPermissions),
        new("Owner", 50, "Top-level owner with full system-management permissions.", OwnerPermissions),
    ];

    public const string OwnerRole = "Owner";
}