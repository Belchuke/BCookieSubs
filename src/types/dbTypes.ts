import { SubtitleFormat } from "./subtitleTypes"

export type DBUser = {
  id: number
  username: string
  passwordHash: string | null
  hasSeenTutorial: boolean
  selectedThemeId: number
  showPosters: number
  language: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type DBRole = {
  id: number
  name: string
  level: number
  description: string | null
  createdAt: string
  updatedAt: string
}

export type DBPermission = {
  id: number
  key: string
  label: string
  description: string
  category: string | null
  createdAt: string
  updatedAt: string
}

export type DBRolePermission = {
  id: number
  roleId: number
  permissionId: number
  createdAt: string
}

export type DBUserRole = {
  id: number
  userId: number
  roleId: number
  createdAt: string
}

export type DBUserSession = {
  id: number
  userId: number
  sessionTokenHash: string
  expiresAt: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type DBTheme = {
  id: number
  name: string

  bg: string
  surface: string
  surface2: string
  surface3: string
  borderColor: string

  textColor: string
  textDim: string
  textHint: string

  accent: string
  accentDim: string

  success: string
  successDim: string
  warning: string
  warningDim: string
  error: string
  errorDim: string
  infoDim: string

  createdByUserId: number | null
  isPublic: number

  createdAt: string
  updatedAt: string
}

export type DBRecommendedModel = {
  id: number
  name: string
  size: string | null
  parameterSize: string | null
  provider: string
  baseUrl: string | null
  roles: string | null
  requireOllamaSubscription: number
  score: string
  createdAt: string
  updatedAt: string
}

export type DBModel = {
  id: number
  name: string
  modelName: string
  size: string | null
  parameterSize: string | null
  modelUpdatedAt: string | null
  closeAfterUse: boolean
  active: boolean
  provider: "ollama" | "ollama cloud" | "chatgpt" | "claude" | "copilot" | "custom"
  baseUrl: string | null
  recommendedModelId: number | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type DBModelRole = {
  id: number
  modelId: number
  role: "translation" | "judge" | "fallbackJudge" | "nameFormatter"
  createdAt: string
  deletedAt: string | null
}

export type DBLanguage = {
  id: number
  name: string
  iso639: string
  iso6392b: string | null
  locale: string
  flag: string | null
  flagCode: string | null  // ISO 3166-1 alpha-2 lowercase for flag-icons, e.g. "us", "gb-wls"
  createdAt: string
  updatedAt: string
}

export type DBPrompt = {
  id: number
  name: string
  type: "translation" | "judge" | "nameFormatter"
  active: boolean
  createdAt: string
  updatedAt: string
}

export type DBPromptVersion = {
  id: number
  promptId: number
  version: number
  active: boolean
  promptText: string
  createdAt: string
  deletedAt: string | null
}

export type DBPromptStat = {
  id: number
  promptId: number
  promptVersionId: number
  modelId: number
  languageId: number | null
  requestCount: number
  failedCount: number
  successCount: number
  selectedCount: number
  createdAt: string
  updatedAt: string
}

export type DBJudgeEvaluation = {
  id: number
  subtitleChunkId: number
  modelId: number
  judgeInput: string
  selectedCandidateId: number | null
  judgeReason: string | null
  createdAt: string
}

export type DBConfig = {
  id: number
  defaultChunkSize: number
  maxRetriesPerChunk: number
  showPosters: boolean
  nameDetectionActive: boolean
  theMovieDbActive: boolean
  finishSingleSubtitleFirst: boolean
  scanLibraryPaths: boolean
  scheduleConfigured: boolean
  clearLogs: boolean
  clearLogsOlderThanDays: number
  version: string
  sessionTimeoutMinutes: number
  selectedThemeId: number
  rootLibraryPath: string | null
  defaultLanguage: string
  whisperModel: string
  whisperTimestampsLength: number
  whisperUseCuda: number
  whisperModelRootPath: string | null
  whisperEnabled: number
  whisperRunAsSeparateTask: number
  createdAt: string
  updatedAt: string
}

export type DBConfigTranslationLanguage = {
  id: number
  languageId: number
  orderNumber: number
  createdAt: string
  updatedAt: string
}

export type DBUserConfigTranslationLanguage = {
  id: number
  userId: number
  languageId: number
  orderNumber: number
  createdAt: string
  updatedAt: string
}

export type DBSecret = {
  id: number
  secretName: string
  encryptedValue: string
  iv: string
  authTag: string
  algorithm: string
  setByEnv: number
  createdAt: string
  updatedAt: string
}

export type DBSchedule = {
  id: number
  taskName: string
  enabled: boolean
  dayOfTheWeek: number
  startTimeHour: number
  startTimeMinute: number
  durationMinutes: number
  repeatUnit: "day" | "week" | "month"
  repeatInterval: number
  lastRunAt: string | null
  firstStartAt: string | null
  createdAt: string
  updatedAt: string
}

export type DBMediaItem = {
  id: number
  type: "movie" | "series" | "unknown"
  title: string
  originalTitle: string | null
  year: number | null
  theMovieDbId: string | null
  isAnime: boolean | null
  genres: string | null
  mediaItemPhotoPath: string | null
  createdAt: string
  updatedAt: string
}

export type DBSubtitle = {
  id: number
  userId: number
  sourceLangId: number
  mediaItemId: number | null
  libraryPathItem: number | null
  name: string
  originalFileHash: string
  originalTextSRTName: string
  originalText: string
  sourceFormat: SubtitleFormat
  orderNumber: number
  whisperOrderNumber: number | null
  hide: boolean
  source: string | null
  sourcePath: string | null
  mediaPath: string | null
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "paused"
  whisperTranscriptionStatus: WhisperTranscriptionStatus | null
  whisperModel: string | null
  whisperTimestampsLength: number | null
  whisperUseCuda: number | null
  season: number | null
  episode: number | null
  whisperProgress: number
  whisperPositionMs: number
  whisperDurationMs: number
  // Whisper stop/resume checkpoint. Cleared on successful finalize.
  whisperResumeSrt: string | null
  whisperResumeMs: number
  finishedAt: string | null
  cancelledAt: string | null
  cancelledByUserId: number | null
  deletedAt: string | null
  deletedByUserId: number | null
  createdAt: string
  updatedAt: string
}

export type WhisperTranscriptionStatus =
  | "queued_for_transcription"
  | "transcribing"
  | "transcription_failed"
  | "transcription_completed"
  | "queued_for_translation"
  | "translating"

export type DBSubtitleJob = {
  id: number
  subtitleId: number
  userId: number
  targetLangId: number
  chunkSetting: number
  chunkSizeTotal: number
  chunkCurrent: number
  season: number | null
  episode: number | null
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "paused"
  orderNumber: number
  translatedText: string | null
  outputFilePath: string | null
  outputHash: string | null
  finishedAt: string | null
  cancelledAt: string | null
  cancelledByUserId: number | null
  deletedAt: string | null
  deletedByUserId: number | null
  createdAt: string
  updatedAt: string
}

export type DBSubtitleChunk = {
  id: number
  subtitleId: number
  subtitleJobId: number
  targetLangId: number
  chunkIndex: number
  srtIdFrom: number
  srtIdTo: number
  chunkTextRaw: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "retrying" | "waiting_for_judge"
  judgeModelId: number | null
  judgeReason: string | null
  selectedCandidateId: number | null
  durationMs: number | null
  retryCount: number
  errorMessage: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  updatedAt: string
}

export type DBSubtitleChunkCandidate = {
  id: number
  subtitleChunkId: number
  modelId: number | null
  promptId: number | null
  promptVersionId: number | null
  promptTextSnapshot: string | null
  translatedText: string | null
  status: "queued" | "running" | "completed" | "failed" | "validation_failed"
  validationPassed: boolean | null
  selected: boolean
  retryCount: number
  durationMs: number | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export type DBSubtitleSrtLine = {
  id: number
  subtitleId: number
  srtIndex: number
  startTime: string
  startSeconds: number
  endTime: string
  endSeconds: number
  text: string
  createdAt: string
  updatedAt: string
}

export type DBLibraryPath = {
  id: number
  name: string
  enabled: boolean
  path: string
  autoTranslate: boolean
  autoExtract: boolean
  sourceLangId: number
  lastRunAt: string | null
  state: "idle" | "scanning" | "error"
  type: "movie" | "series"
  initialScanCompleted: boolean
  createdAt: string
  updatedAt: string
}

export type DBLibraryPathItem = {
  id: number
  libraryPathId: number
  mediaItemId: number | null
  status: "not_started" | "queued" | "no_srts_found" | "completed" | "failed" | "no_media_item"
  season: number | null
  episode: number | null
  path: string
  extractFileName: string
  createdAt: string
  updatedAt: string
}

export type DBLibraryPathItemBlacklist = {
  id: number
  libraryPathItemId: number
  blacklistedByUserId: number | null
  reason: string | null
  createdAt: string
  updatedAt: string
}

export type DBLibraryPathItemCandidate = {
  id: number
  libraryPathItemId: number
  path: string
  mediaItemId: number
  createdAt: string
  updatedAt: string
}

export type DBLog = {
  id: number
  level: "debug" | "info" | "warning" | "error"
  type: string | null
  entityType: string | null
  entityId: number | null
  message: string
  metadata: string | null
  createdAt: string
  deletedAt: string | null
}

// Fine-grained log "type" values — a second filtering dimension alongside level.
// Kept as a loose string column (no CHECK) so new types can be added freely; this
// list is the known set, used to populate the type filter dropdown on the logs page.
export const LOG_TYPES: string[] = [
  "login",
  "resetPassword",
  "newUser",
  "updateUserRoles",
  "newRole",
  "updateRole",
  "deleteRole",
  "deleteUser",
  "chunkCompleted",
  "chunkFailed",
  "chunkCandidate",
  "chunkJudge",
  "tmdbMatch",
  "tmdbMatching",
  "tmdbMultiple",
  "tmdbBlocked",
  "nfoMatch",
  "nameDetection",
  "nameFormatter",
  "scanFailed",
  "scanSkipped",
  "libraryScanner",
  "libraryPathCreate",
  "libraryPathUpdate",
  "libraryPathDelete",
  "libraryPathRescan",
  "libraryPathBlacklist",
  "whisperQueued",
  "whisperStart",
  "whisperRun",
  "whisperModel",
  "whisperPaused",
  "whisperCompleted",
  "whisperFailed",
  "whisperGrouped",
  "whisperTranscription",
  "workerState",
  "subtitleCreate",
  "subtitleCancel",
  "subtitleDelete",
  "subtitleCompleted",
  "subtitleJobCompleted",
  "subtitleJobFailed",
  "configUpdate",
  "languageConfig",
  "secretConfig",
  "modelAdd",
  "modelUpdate",
  "modelDelete",
  "rateLimit",
  "prompt",
  "scheduleCreate",
  "scheduleUpdate",
  "scheduleDelete",
  "sessionDelete",
  "offset",
]

export type Migration = {
  id: number
  name: string
  version: string
  path: string | null
  appliedAt: string
  createdAt: string
}
