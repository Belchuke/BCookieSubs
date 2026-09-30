namespace BCookieSubs.Shared.Security;

public static class PermissionCatalog
{
    public sealed record Definition(string Key, string Label, string Description, string Category);

    public static readonly IReadOnlyList<Definition> Definitions =
    [
        new("canManageWorker", "Manage Worker", "Can start, stop, pause, or resume the translation worker from the dashboard.", "dashboard"),
        new("canAddSubtitleToTranslateDashboard", "Add Subtitle From Dashboard", "Can add or upload subtitles for translation from the dashboard.", "dashboard"),
        new("canAddSubtitleToTranslateFromLibrary", "Add Subtitle From Library", "Can add a library path item to be translated.", "dashboard"),
        new("canChangeSubtitlePriority", "Change Subtitle Priority", "Can change the priority/order of subtitles waiting to be translated.", "dashboard"),
        new("canCancelTranslationJob", "Cancel Translation Job", "Can cancel or delete a subtitle job entity from the dashboard.", "dashboard"),
        new("canDeleteTranslation", "Delete Translation", "Can delete an entire subtitle translation entry.", "dashboard"),
        new("canViewLogsDashboard", "View Dashboard Logs", "Can view logs shown on the dashboard.", "dashboard"),
        new("canRestartTranslationChunk", "Restart Translation Chunk", "Can restart a failed or completed chunk of a subtitle job.", "dashboard"),
        new("canDownloadFinishedSubtitles", "Download Finished Subtitles", "Can export/download finished subtitles to a computer or phone.", "dashboard"),
        new("canViewFinishedTranslatedPage", "View Finished Translated Page", "Can navigate to the Translated page.", "dashboard"),

        new("canViewModelsPage", "View Models Page", "Can navigate to the Models page.", "models"),
        new("canAddOrInstallAModel", "Add Or Install Model", "Can add a model, add one from Available in Ollama, or install/add one from Recommended Models.", "models"),
        new("canEditModels", "Edit Models", "Can edit model settings in the Configured Models section.", "models"),
        new("canManageModelRoles", "Manage Model Roles", "Can change which roles a model has.", "models"),
        new("canRemoveAndDeleteModels", "Remove And Delete Models", "Can remove or delete configured models.", "models"),

        new("canViewPromptsPage", "View Prompts Page", "Can navigate to the Prompts page.", "prompts"),
        new("canManagePrompts", "Manage Prompts", "Can add, disable, edit, or change prompts.", "prompts"),

        new("canViewStatistics", "View Statistics", "Can view the Statistics page.", "statistics"),

        new("canViewUsers", "View Users", "Can navigate to the Users page.", "users"),
        new("canEditPermissions", "Edit Permissions", "Can edit permissions/roles for other users and self, but cannot grant permissions or roles above their own level.", "users"),
        new("canChangeOtherUsersPassword", "Change Other Users Password", "Can change another user's password if that user is not higher elevated.", "users"),
        new("canManageRoles", "Manage Roles", "Can manage roles and their permissions.", "users"),
        new("canAddUser", "Add User", "Can create a new user, but cannot assign roles above their own level.", "users"),

        new("canViewLibraryPathsPage", "View Library Paths Page", "Can navigate to the Library Paths page.", "library"),
        new("canChangeMatchForLibraryPaths", "Change Library Path Match", "Can change the media match for a library path item.", "library"),
        new("canAddPathForLibraryPaths", "Add Library Path", "Can add a new library path.", "library"),
        new("canBlackListALibraryPathItem", "Blacklist Library Path Item", "Can blacklist a library path item.", "library"),
        new("canEditLibraryPath", "Edit Library Path", "Can edit a library path row.", "library"),
        new("canDisableAndDeleteALibraryPath", "Disable Or Delete Library Path", "Can disable or delete a library path row.", "library"),
        new("canViewOffsetPage", "View Offset Page", "Can navigate to the Offset page to view SRT offsets.", "library"),
        new("canEditSubtitleOffsets", "Edit Subtitle Offsets", "Can apply an offset to a subtitle (upload new or use existing library file).", "library"),
        new("canCreateSubtitlesWithWhisper", "Create Subtitles With Whisper", "Can generate custom source subtitles from media files using Whisper.", "library"),

        new("canViewSettingsPage", "View Settings Page", "Can navigate to the Settings page.", "settings"),
        new("canManageSettings", "Manage Settings", "Can change settings in the General, Default Target Languages, and Theme sections.", "settings"),
        new("canManageSecrets", "Manage Secrets", "Can view and manage the Secrets section, including show, edit, and delete.", "settings"),

        new("canViewSchedules", "View Schedules", "Can navigate to the Schedules page when schedules are enabled.", "schedules"),
        new("canManageSchedules", "Manage Schedules", "Can add, edit, and delete schedules.", "schedules"),

        new("canViewLogs", "View Logs", "Can view the Logs page.", "logs"),
    ];

    public static readonly IReadOnlyList<string> AllKeys = Definitions.Select(d => d.Key).ToList();
}