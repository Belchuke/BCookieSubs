namespace BCookieSubs.Shared.Security;

public static class Permissions
{
    public const string ClaimType = "permission";
    public const string WorkersView = "workers.view";
    public const string WorkersManage = "workers.manage";

    public const string CanViewModelsPage = "canViewModelsPage";
    public const string CanAddOrInstallAModel = "canAddOrInstallAModel";
    public const string CanEditModels = "canEditModels";
    public const string CanManageModelRoles = "canManageModelRoles";
    public const string CanRemoveAndDeleteModels = "canRemoveAndDeleteModels";
    public const string CanViewPromptsPage = "canViewPromptsPage";
    public const string CanManagePrompts = "canManagePrompts";
    public const string CanViewUsers = "canViewUsers";
    public const string CanAddUser = "canAddUser";
    public const string CanEditPermissions = "canEditPermissions";
    public const string CanChangeOtherUsersPassword = "canChangeOtherUsersPassword";
    public const string CanManageRoles = "canManageRoles";
    public const string CanViewSettingsPage = "canViewSettingsPage";
    public const string CanManageSettings = "canManageSettings";
    public const string CanManageSecrets = "canManageSecrets";
    public const string CanViewStatistics = "canViewStatistics";
    public const string CanViewLibraryPathsPage = "canViewLibraryPathsPage";
    public const string CanAddSubtitleToTranslateFromLibrary = "canAddSubtitleToTranslateFromLibrary";
    public const string CanAddSubtitleToTranslateDashboard = "canAddSubtitleToTranslateDashboard";
    public const string CanCancelTranslationJob = "canCancelTranslationJob";
    public const string CanRestartTranslationChunk = "canRestartTranslationChunk";
    public const string CanCreateSubtitlesWithWhisper = "canCreateSubtitlesWithWhisper";
    public const string CanChangeSubtitlePriority = "canChangeSubtitlePriority";
    public const string CanDeleteTranslation = "canDeleteTranslation";
    public const string CanDownloadFinishedSubtitles = "canDownloadFinishedSubtitles";
    public const string CanViewFinishedTranslatedPage = "canViewFinishedTranslatedPage";
    public const string CanViewLogsDashboard = "canViewLogsDashboard";
    public const string CanViewLogs = "canViewLogs";
    public const string CanViewSchedules = "canViewSchedules";
    public const string CanManageSchedules = "canManageSchedules";
    public const string CanViewOffsetPage = "canViewOffsetPage";
    public const string CanEditSubtitleOffsets = "canEditSubtitleOffsets";

    public static readonly IReadOnlyList<string> WorkerPermissions = [WorkersView, WorkersManage];

    public static readonly IReadOnlyList<string> All =
        [.. WorkerPermissions, .. PermissionCatalog.AllKeys];
}

public static class Policies
{
    public const string Prefix = "Perm:";

    public const string WorkersView = "WorkersView";
    public const string WorkersManage = "WorkersManage";
    public const string LibraryPages = "LibraryPages";
    public const string PathBrowse = "PathBrowse";

    public static readonly string[] LibraryPagePermissions =
    [
        "canViewLibraryPathsPage",
        "canAddPathForLibraryPaths",
        "canEditLibraryPath",
        "canDisableAndDeleteALibraryPath",
        "canBlackListALibraryPathItem",
        "canChangeMatchForLibraryPaths",
        "canAddSubtitleToTranslateFromLibrary",
    ];
}