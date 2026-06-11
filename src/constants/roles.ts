import { PermissionKey } from './permissions'

export type RoleName = 'User' | 'SuperUser' | 'MasterUser' | 'Admin' | 'Owner'

export type RoleDefinition = {
  name: RoleName
  level: number
  description: string
  permissions: PermissionKey[]
}

const USER_PERMS: PermissionKey[] = [
  'canAddSubtitleToTranslateFromLibrary',
]

const SUPERUSER_PERMS: PermissionKey[] = [
  ...USER_PERMS,
  'canChangeSubtitlePriority',
  'canRestartTranslationChunk',
]

const MASTERUSER_PERMS: PermissionKey[] = [
  ...SUPERUSER_PERMS,
  'canAddSubtitleToTranslateDashboard',
  'canViewFinishedTranslatedPage',
  'canManageWorker',
  'canCancelTranslationJob',
  'canDeleteTranslation',
  'canViewStatistics',
  'canViewSchedules',
  'canViewLogs',
  'canViewLibraryPathsPage',
  'canChangeMatchForLibraryPaths',
  'canBlackListALibraryPathItem',
  'canViewLogsDashboard',
  'canViewPromptsPage',
  'canViewModelsPage',
  'canDownloadFinishedSubtitles',
  'canViewOffsetPage',
]

const ADMIN_PERMS: PermissionKey[] = [
  ...MASTERUSER_PERMS,
  'canAddOrInstallAModel',
  'canEditModels',
  'canManageModelRoles',
  'canRemoveAndDeleteModels',
  'canManagePrompts',
  'canViewUsers',
  'canViewSettingsPage',
]

const OWNER_PERMS: PermissionKey[] = [
  ...ADMIN_PERMS,
  'canEditPermissions',
  'canChangeOtherUsersPassword',
  'canManageRoles',
  'canAddUser',
  'canAddPathForLibraryPaths',
  'canEditLibraryPath',
  'canDisableAndDeleteALibraryPath',
  'canManageSettings',
  'canManageSecrets',
  'canManageSchedules',
  'canEditSubtitleOffsets',
]

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    name: 'User',
    level: 10,
    description: 'Basic user who can see translation status and request translations from library/request flows.',
    permissions: USER_PERMS,
  },
  {
    name: 'SuperUser',
    level: 20,
    description: 'User with additional control over translation priority and chunk retries.',
    permissions: SUPERUSER_PERMS,
  },
  {
    name: 'MasterUser',
    level: 30,
    description: 'Power user with access to dashboard translation management, completed subtitles, stats, logs, models/prompts view, and library path actions.',
    permissions: MASTERUSER_PERMS,
  },
  {
    name: 'Admin',
    level: 40,
    description: 'Admin user who can manage models, prompts, users view, and settings view.',
    permissions: ADMIN_PERMS,
  },
  {
    name: 'Owner',
    level: 50,
    description: 'Top-level owner with full system-management permissions.',
    permissions: OWNER_PERMS,
  },
]
