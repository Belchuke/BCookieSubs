import * as fs from "fs"
import Database from "better-sqlite3"
import { themes } from "./seed/defaultThemes"
import {
  defaultJudgePrompt,
  defaultPromptFive,
  defaultPromptFour,
  defaultPromptOne,
  defaultPromptThree,
  defaultPromptTwo,
  nameFormatterPrompt,
  theMovieDBMatchingPrompt,
} from "./seed/defaultPrompts"
import { seedLanguages } from "./seed/defaultLangs"
import { recommendedSeeds } from "./seed/recommendedModels"
import { PERMISSIONS } from "./constants/permissions"
import { DEFAULT_ROLES } from "./constants/roles"
import { isSupportedLocale } from "./i18n"

export const dbName = process.env.DBPATH || "subtitles.db"

const createTables = (db: Database.Database) => {
  console.log("Creating new database...")

  const setup = db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    hasSeenTutorial INTEGER NOT NULL DEFAULT 0,
    selectedThemeId INTEGER NOT NULL DEFAULT 1,
    showPosters INTEGER NOT NULL DEFAULT 1,
    language TEXT DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deletedAt DATETIME DEFAULT NULL
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS permission (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS role (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    level INTEGER NOT NULL UNIQUE,
    description TEXT DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS rolePermission (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roleId INTEGER NOT NULL,
    permissionId INTEGER NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(roleId, permissionId),
    FOREIGN KEY(roleId) REFERENCES role(id) ON DELETE CASCADE,
    FOREIGN KEY(permissionId) REFERENCES permission(id) ON DELETE CASCADE
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS userRole (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    roleId INTEGER NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userId, roleId),
    FOREIGN KEY(userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY(roleId) REFERENCES role(id) ON DELETE CASCADE
  )`)

    db.exec(`CREATE INDEX IF NOT EXISTS idx_userRole_userId ON userRole(userId)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rolePermission_roleId ON rolePermission(roleId)`)

    const insertPermission = db.prepare(`
      INSERT INTO permission (key, label, description, category)
      VALUES (@key, @label, @description, @category)
      ON CONFLICT(key) DO UPDATE SET
        label = excluded.label,
        description = excluded.description,
        category = excluded.category,
        updatedAt = CURRENT_TIMESTAMP
    `)
    for (const p of PERMISSIONS) {
      insertPermission.run({ key: p.key, label: p.label, description: p.description, category: p.category })
    }

    const insertRole = db.prepare(`
      INSERT INTO role (name, level, description)
      VALUES (@name, @level, @description)
      ON CONFLICT(name) DO UPDATE SET
        level = excluded.level,
        description = excluded.description,
        updatedAt = CURRENT_TIMESTAMP
    `)
    for (const r of DEFAULT_ROLES) {
      insertRole.run({ name: r.name, level: r.level, description: r.description })
    }

    const insertRolePerm = db.prepare(`
      INSERT INTO rolePermission (roleId, permissionId)
      SELECT r.id, p.id
      FROM role r, permission p
      WHERE r.name = @roleName AND p.key = @permKey
      ON CONFLICT(roleId, permissionId) DO NOTHING
    `)
    for (const r of DEFAULT_ROLES) {
      for (const permKey of r.permissions) {
        insertRolePerm.run({ roleName: r.name, permKey })
      }
    }

    db.exec(`CREATE TABLE IF NOT EXISTS userSession (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    sessionTokenHash TEXT NOT NULL UNIQUE,
    expiresAt DATETIME NOT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deletedAt DATETIME DEFAULT NULL,

    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS theme (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,

      bg TEXT NOT NULL,
      surface TEXT NOT NULL,
      surface2 TEXT NOT NULL,
      surface3 TEXT NOT NULL,
      borderColor TEXT NOT NULL,

      textColor TEXT NOT NULL,
      textDim TEXT NOT NULL,
      textHint TEXT NOT NULL,

      accent TEXT NOT NULL,
      accentDim TEXT NOT NULL,

      success TEXT NOT NULL,
      successDim TEXT NOT NULL,
      warning TEXT NOT NULL,
      warningDim TEXT NOT NULL,
      error TEXT NOT NULL,
      errorDim TEXT NOT NULL,
      infoDim TEXT NOT NULL,

      createdByUserId INTEGER DEFAULT NULL,
      isPublic INTEGER NOT NULL DEFAULT 0,

      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (createdByUserId) REFERENCES user(id) ON DELETE SET NULL
    )`)

    const insertTheme = db.prepare(`
      INSERT INTO theme (
        name,
        bg, surface, surface2, surface3, borderColor,
        textColor, textDim, textHint,
        accent, accentDim,
        success, successDim,
        warning, warningDim,
        error, errorDim,
        infoDim,
        isPublic
      ) VALUES (
        @name,
        @bg, @surface, @surface2, @surface3, @borderColor,
        @textColor, @textDim, @textHint,
        @accent, @accentDim,
        @success, @successDim,
        @warning, @warningDim,
        @error, @errorDim,
        @infoDim,
        @isPublic
      )
      ON CONFLICT(name) DO NOTHING
    `)

    for (const theme of themes) {
      insertTheme.run(theme)
    }

    db.exec(`CREATE TABLE IF NOT EXISTS model (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      modelName TEXT NOT NULL,

      size TEXT DEFAULT NULL,
      parameterSize TEXT DEFAULT NULL,
      modelUpdatedAt TEXT DEFAULT NULL,

      closeAfterUse INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL DEFAULT 'ollama',
      baseUrl TEXT DEFAULT NULL,
      recommendedModelId INTEGER DEFAULT NULL,

      deletedAt DATETIME DEFAULT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE (modelName, modelUpdatedAt)
    );`)

    db.exec(`CREATE TABLE IF NOT EXISTS recommendedModel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      size TEXT DEFAULT NULL,
      parameterSize TEXT DEFAULT NULL,
      provider TEXT NOT NULL DEFAULT 'ollama',
      baseUrl TEXT DEFAULT NULL,
      roles TEXT DEFAULT NULL,
      requireOllamaSubscription INTEGER NOT NULL DEFAULT 0,
      score TEXT NOT NULL DEFAULT '',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)

    const seedRecommended = db.prepare(`
      INSERT INTO recommendedModel (name, provider, baseUrl, roles, requireOllamaSubscription, score)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO NOTHING
    `)

    for (const row of recommendedSeeds) seedRecommended.run(...row)

    db.exec(`CREATE TABLE IF NOT EXISTS modelRole (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modelId INTEGER NOT NULL,

      role TEXT NOT NULL
        CHECK (role IN ('translation', 'judge', 'fallbackJudge', 'nameFormatter')),

      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deletedAt DATETIME DEFAULT NULL,

      UNIQUE (modelId, role),

      FOREIGN KEY (modelId) REFERENCES model(id) ON DELETE CASCADE
    );`)

    db.exec(`CREATE TABLE IF NOT EXISTS language (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      iso639 TEXT NOT NULL,
      iso6392b TEXT DEFAULT NULL,
      locale TEXT NOT NULL,
      flag TEXT DEFAULT NULL,

      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

      UNIQUE (iso639, locale)
    )`)

    const insertLang = db.prepare(`
      INSERT INTO language (name, iso639, iso6392b, locale, flag)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(iso639, locale) DO UPDATE SET
        name = excluded.name,
        iso6392b = excluded.iso6392b,
        flag = excluded.flag,
        updatedAt = CURRENT_TIMESTAMP
    `)

    for (const lang of seedLanguages) {
      insertLang.run(lang.name, lang.iso639, lang.iso6392b ?? null, lang.locale, lang.flag)
    }

    db.exec(`CREATE TABLE IF NOT EXISTS prompt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,

    type TEXT NOT NULL DEFAULT 'translation'
      CHECK (type IN ('translation', 'judge', 'nameFormatter')),

    active INTEGER NOT NULL DEFAULT 1,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS promptVersion (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promptId INTEGER NOT NULL,
    version INTEGER NOT NULL,
    promptText TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deletedAt DATETIME DEFAULT NULL,
    UNIQUE (promptId, version),
    FOREIGN KEY (promptId) REFERENCES prompt(id) ON DELETE CASCADE
  )`)

    const insertPrompt = db.prepare(`
    INSERT INTO prompt (name, type)
    VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET
      type = excluded.type,
      updatedAt = CURRENT_TIMESTAMP
  `)

    insertPrompt.run("defaultPrompt1", "translation")
    insertPrompt.run("defaultPrompt2", "translation")
    insertPrompt.run("defaultPrompt3", "translation")
    insertPrompt.run("defaultPrompt4", "translation")
    insertPrompt.run("defaultPrompt5", "translation")
    insertPrompt.run("defaultJudgePrompt", "judge")
    insertPrompt.run("nameFormatterPrompt", "nameFormatter")
    insertPrompt.run("theMovieDBMatchingPrompt", "nameFormatter")

    const insertPromptVersion = db.prepare(`
    INSERT INTO promptVersion (promptId, version, promptText)
    VALUES (
      (SELECT id FROM prompt WHERE name = ?),
      ?,
      ?
    )
    ON CONFLICT(promptId, version) DO NOTHING
  `)

    insertPromptVersion.run("defaultPrompt1", 1, defaultPromptOne)
    insertPromptVersion.run("defaultPrompt2", 1, defaultPromptTwo)
    insertPromptVersion.run("defaultPrompt3", 1, defaultPromptThree)
    insertPromptVersion.run("defaultPrompt4", 1, defaultPromptFour)
    insertPromptVersion.run("defaultPrompt5", 1, defaultPromptFive)
    insertPromptVersion.run("defaultJudgePrompt", 1, defaultJudgePrompt)
    insertPromptVersion.run("nameFormatterPrompt", 1, nameFormatterPrompt)
    insertPromptVersion.run("theMovieDBMatchingPrompt", 1, theMovieDBMatchingPrompt)

    db.exec(`CREATE TABLE IF NOT EXISTS promptStat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promptId INTEGER NOT NULL,
    promptVersionId INTEGER NOT NULL,
    modelId INTEGER NOT NULL,
    languageId INTEGER DEFAULT NULL,

    requestCount INTEGER NOT NULL DEFAULT 0,
    failedCount INTEGER NOT NULL DEFAULT 0,
    successCount INTEGER NOT NULL DEFAULT 0,
    selectedCount INTEGER NOT NULL DEFAULT 0,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (promptId, promptVersionId, modelId, languageId),

    FOREIGN KEY (promptId) REFERENCES prompt(id) ON DELETE CASCADE,
    FOREIGN KEY (promptVersionId) REFERENCES promptVersion(id) ON DELETE CASCADE,
    FOREIGN KEY (modelId) REFERENCES model(id) ON DELETE CASCADE,
    FOREIGN KEY (languageId) REFERENCES language(id) ON DELETE SET NULL
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS judgeEvaluation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subtitleChunkId INTEGER NOT NULL,
      modelId INTEGER DEFAULT NULL ,
      judgeInput TEXT DEFAULT NULL,
      judgeReason TEXT DEFAULT NULL,
      selectedCandidateId INTEGER DEFAULT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (subtitleChunkId) REFERENCES subtitleChunk(id) ON DELETE CASCADE,
      FOREIGN KEY (modelId) REFERENCES model(id) ON DELETE CASCADE,
      FOREIGN KEY (selectedCandidateId) REFERENCES subtitleChunkCandidate(id) ON DELETE SET NULL
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),

    defaultChunkSize INTEGER NOT NULL DEFAULT 12,
    maxRetriesPerChunk INTEGER NOT NULL DEFAULT 5,

    showPosters INTEGER NOT NULL DEFAULT 0,
    nameDetectionActive INTEGER NOT NULL DEFAULT 0,
    theMovieDbActive INTEGER NOT NULL DEFAULT 0,
    finishSingleSubtitleFirst INTEGER NOT NULL DEFAULT 1,
    scanLibraryPaths INTEGER NOT NULL DEFAULT 0,

    scheduleConfigured INTEGER NOT NULL DEFAULT 0,
    setupCompleted INTEGER NOT NULL DEFAULT 0,

    clearLogs INTEGER NOT NULL DEFAULT 0,
    clearLogsOlderThanDays INTEGER NOT NULL DEFAULT 30,

    version TEXT NOT NULL DEFAULT '0.0.1',

    sessionTimeoutMinutes INTEGER NOT NULL DEFAULT 400,

    selectedThemeId INTEGER NOT NULL DEFAULT 1,

    rootLibraryPath TEXT DEFAULT NULL,

    defaultLanguage TEXT NOT NULL DEFAULT 'en',

    whisperModel TEXT NOT NULL DEFAULT 'large-v3-turbo',
    whisperTimestampsLength INTEGER NOT NULL DEFAULT 60,
    whisperUseCuda INTEGER NOT NULL DEFAULT 0,
    whisperModelRootPath TEXT DEFAULT NULL,
    whisperEnabled INTEGER NOT NULL DEFAULT 1,
    whisperRunAsSeparateTask INTEGER NOT NULL DEFAULT 0,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

    const theMovieDbKey = process.env.THEMOVIEDB_API_KEY?.trim()
    const theMovieDbActiveDefault = theMovieDbKey ? 1 : 0
    const showPostersDefault = theMovieDbKey ? 1 : 0
    const rootLibraryPathDefault = process.env.TRANSLATION_ROOT_DIR?.trim() || null
    const scanLibraryPathsDefault = rootLibraryPathDefault ? 1 : 0
    const rawEnvLang = process.env.APP_DEFAULT_LANGUAGE?.trim() ?? ""
    const defaultLanguage = isSupportedLocale(rawEnvLang) ? rawEnvLang : "en"

    db.prepare(
      `INSERT INTO config (id, defaultChunkSize, theMovieDbActive, showPosters, rootLibraryPath, scanLibraryPaths, defaultLanguage, whisperModel, whisperTimestampsLength)
       VALUES (1, 12, ?, ?, ?, ?, ?, 'large-v3-turbo', 60)
       ON CONFLICT(id) DO NOTHING`,
    ).run(theMovieDbActiveDefault, showPostersDefault, rootLibraryPathDefault, scanLibraryPathsDefault, defaultLanguage)

    db.exec(`CREATE TABLE IF NOT EXISTS configTranslationLanguage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    languageId INTEGER NOT NULL,
    orderNumber INTEGER NOT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (languageId),

    FOREIGN KEY (languageId) REFERENCES language(id) ON DELETE CASCADE
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS userConfigTranslationLanguage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    languageId INTEGER NOT NULL,
    orderNumber INTEGER NOT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (userId, languageId),

    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (languageId) REFERENCES language(id) ON DELETE CASCADE
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS secret (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    secretName TEXT NOT NULL UNIQUE,
    encryptedValue TEXT NOT NULL,
    iv TEXT NOT NULL,
    authTag TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    setByEnv INTEGER NOT NULL DEFAULT 0,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taskName TEXT NOT NULL,

    enabled INTEGER NOT NULL DEFAULT 0,

    dayOfTheWeek INTEGER NOT NULL CHECK (dayOfTheWeek BETWEEN 0 AND 6),
    startTimeHour INTEGER NOT NULL,
    startTimeMinute INTEGER NOT NULL,
    durationMinutes INTEGER NOT NULL CHECK (durationMinutes > 0),

    repeatUnit TEXT NOT NULL DEFAULT 'week'
      CHECK (repeatUnit IN ('day', 'week', 'month')),

    repeatInterval INTEGER NOT NULL DEFAULT 1
      CHECK (repeatInterval > 0),

    lastRunAt DATETIME DEFAULT NULL,
    firstStartAt DATETIME DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS mediaItem (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    type TEXT NOT NULL CHECK (type IN ('movie', 'series', 'unknown')),
    title TEXT NOT NULL,
    originalTitle TEXT DEFAULT NULL,
    year INTEGER DEFAULT NULL,

    theMovieDbId TEXT DEFAULT NULL,
    isAnime INTEGER DEFAULT NULL,
    genres TEXT DEFAULT NULL,
    mediaItemPhotoPath TEXT DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS libraryPath (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      path TEXT NOT NULL UNIQUE,
      autoTranslate INTEGER NOT NULL DEFAULT 0,
      autoExtract INTEGER NOT NULL DEFAULT 0,
      sourceLangId INTEGER NOT NULL,
      lastRunAt DATETIME DEFAULT NULL,
      state TEXT NOT NULL DEFAULT 'idle'
          CHECK (state IN ('idle', 'scanning', 'error')),
      type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
      initialScanCompleted INTEGER NOT NULL DEFAULT 0,
      scanMode TEXT NOT NULL DEFAULT 'hourly'
          CHECK (scanMode IN ('hourly', 'custom', 'never')),
      scanRepeatInterval INTEGER NOT NULL DEFAULT 1,
      scanRepeatUnit TEXT NOT NULL DEFAULT 'day'
          CHECK (scanRepeatUnit IN ('day', 'week', 'month')),
      scanDayOfWeek INTEGER NOT NULL DEFAULT 0,
      scanStartTimeHour INTEGER NOT NULL DEFAULT 0,
      scanStartTimeMinute INTEGER NOT NULL DEFAULT 0,
      scanDurationMinutes INTEGER NOT NULL DEFAULT 60,
      scanFirstStartAt DATETIME DEFAULT NULL,
      initialScanDurationMs INTEGER DEFAULT NULL,
      postInitialScanCount INTEGER NOT NULL DEFAULT 0,
      postInitialScanTotalMs INTEGER NOT NULL DEFAULT 0,
      lastScanDurationMs INTEGER DEFAULT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS libraryPathItem (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      libraryPathId INTEGER NOT NULL,
      mediaItemId INTEGER,
      status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (status IN ('not_started', 'queued', 'no_srts_found', 'completed', 'failed', 'no_media_item')),
      season INTEGER DEFAULT NULL,
      episode INTEGER DEFAULT NULL,
      isExtra INTEGER NOT NULL DEFAULT 0,
      path TEXT NOT NULL,
      extractFileName TEXT NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (libraryPathId, path),
      FOREIGN KEY (libraryPathId) REFERENCES libraryPath(id) ON DELETE CASCADE,
      FOREIGN KEY (mediaItemId) REFERENCES mediaItem(id) ON DELETE CASCADE
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS libraryPathItemBlacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      libraryPathItemId INTEGER NOT NULL,
      blacklistedByUserId INTEGER DEFAULT NULL,
      reason TEXT DEFAULT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(libraryPathItemId),
      FOREIGN KEY(libraryPathItemId) REFERENCES libraryPathItem(id) ON DELETE CASCADE,
      FOREIGN KEY(blacklistedByUserId) REFERENCES user(id) ON DELETE SET NULL
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS libraryPathItemCandidate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      libraryPathItemId INTEGER NOT NULL,
      path TEXT NOT NULL,
      mediaItemId INTEGER NOT NULL,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (libraryPathItemId) REFERENCES libraryPathItem(id) ON DELETE CASCADE,
      FOREIGN KEY (mediaItemId) REFERENCES mediaItem(id) ON DELETE CASCADE
    )`)

    // Pre-computed subtitle source list (SubtitleSourceCandidate[] as JSON) for a
    // library path item, populated by the library scanner so the source picker
    // reads from cache instead of probing/extracting the media file on every
    // open. 1:1 with libraryPathItem; cascade-deleted with the item. fileMtimeMs
    // + fileSize are the staleness key: if the media file changes (re-mux) the
    // cached row is ignored and recomputed.
    db.exec(`CREATE TABLE IF NOT EXISTS libraryPathItemSubtitleSource (
      libraryPathItemId INTEGER PRIMARY KEY,
      sourcesJson TEXT NOT NULL,
      fileMtimeMs INTEGER NOT NULL,
      fileSize INTEGER NOT NULL,
      scannedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (libraryPathItemId) REFERENCES libraryPathItem(id) ON DELETE CASCADE
    )`)

    // Background OCR queue. When an image-based subtitle track (PGS/VobSub) is
    // queued for translation from the Library Requests page, the work is
    // enqueued here instead of run synchronously behind a blocking HTTP request.
    // A dedicated worker (ocrWorker) picks the next 'queued' row, runs the
    // extract+OCR+createSubtitleTask pipeline, and on success DELETES the row
    // (removes itself from the queue); on failure it stays for retry. See
    // src/repositories/ocrJobRepository.ts.
    db.exec(`CREATE TABLE IF NOT EXISTS libraryPathOcrJob (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      libraryPathItemId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      name TEXT,
      sourceOverrideJson TEXT NOT NULL,
      sourceLanguageHint TEXT,
      resetStatus INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'failed')),
      progress INTEGER NOT NULL DEFAULT 0,
      errorMessage TEXT,
      orderNumber INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      startedAt DATETIME,
      finishedAt DATETIME,
      FOREIGN KEY (libraryPathItemId) REFERENCES libraryPathItem(id) ON DELETE CASCADE
    )`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_libraryPathOcrJob_status ON libraryPathOcrJob(status, orderNumber)`)

    db.exec(`CREATE TABLE IF NOT EXISTS bcsubExportedFile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      libraryPathId INTEGER NOT NULL,
      path TEXT NOT NULL,
      subtitleId INTEGER DEFAULT NULL,
      isWhisper INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(libraryPathId, path),
      FOREIGN KEY (libraryPathId) REFERENCES libraryPath(id) ON DELETE CASCADE,
      FOREIGN KEY (subtitleId) REFERENCES subtitle(id) ON DELETE SET NULL
    )`)

    // Provenance for .sub/.sup-derived subtitles. sourceFormat stays 'srt' (the
    // .sub/.sup is converted to an SRT intermediate before storage); textOrigin +
    // originalSourceFormat record that the source was a .sub or .sup (PGS) and
    // whether the text came from parsing or OCR. (Comment kept outside the SQL
    // string — SQLite does not understand // comments.)
    db.exec(`CREATE TABLE IF NOT EXISTS subtitle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    userId INTEGER NOT NULL,
    sourceLangId INTEGER NOT NULL,
    mediaItemId INTEGER DEFAULT NULL,
    libraryPathItem INTEGER DEFAULT NULL,

    name TEXT NOT NULL,
    originalFileHash TEXT NOT NULL,
    originalTextSRTName TEXT NOT NULL,
    originalText TEXT NOT NULL,
    sourceFormat TEXT NOT NULL DEFAULT 'srt'
      CHECK (sourceFormat IN ('srt', 'ass', 'ssa')),
    textOrigin TEXT DEFAULT NULL
      CHECK (textOrigin IN (NULL, 'ocr', 'parsed')),
    originalSourceFormat TEXT DEFAULT NULL
      CHECK (originalSourceFormat IN (NULL, 'sub', 'sup')),

    orderNumber INTEGER NOT NULL DEFAULT 0,
    whisperOrderNumber INTEGER,
    hide INTEGER NOT NULL DEFAULT 0,

    source TEXT DEFAULT NULL
      CHECK (source IN (NULL, 'upload', 'library', 'whisper')),
    sourcePath TEXT DEFAULT NULL,
    mediaPath TEXT DEFAULT NULL,

    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'paused')),

    whisperTranscriptionStatus TEXT DEFAULT NULL
      CHECK (whisperTranscriptionStatus IN (NULL, 'queued_for_transcription', 'transcribing', 'transcription_failed', 'transcription_completed', 'queued_for_translation', 'translating')),
    whisperModel TEXT DEFAULT NULL,
    whisperTimestampsLength INTEGER DEFAULT NULL,
    whisperUseCuda INTEGER DEFAULT NULL,
    season INTEGER DEFAULT NULL,
    episode INTEGER DEFAULT NULL,
    whisperProgress INTEGER NOT NULL DEFAULT 0,
    whisperPositionMs INTEGER NOT NULL DEFAULT 0,
    whisperDurationMs INTEGER NOT NULL DEFAULT 0,

    whisperResumeSrt TEXT DEFAULT NULL,
    whisperResumeMs INTEGER NOT NULL DEFAULT 0,

    finishedAt DATETIME DEFAULT NULL,
    cancelledAt DATETIME DEFAULT NULL,
    cancelledByUserId INTEGER DEFAULT NULL,

    deletedAt DATETIME DEFAULT NULL,
    deletedByUserId INTEGER DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (userId) REFERENCES user(id),
    FOREIGN KEY (libraryPathItem) REFERENCES libraryPathItem(id) ON DELETE SET NULL,
    FOREIGN KEY (sourceLangId) REFERENCES language(id),
    FOREIGN KEY (mediaItemId) REFERENCES mediaItem(id) ON DELETE SET NULL,
    FOREIGN KEY (cancelledByUserId) REFERENCES user(id) ON DELETE SET NULL,
    FOREIGN KEY (deletedByUserId) REFERENCES user(id) ON DELETE SET NULL
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS subtitleJob (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    subtitleId INTEGER NOT NULL,
    userId INTEGER NOT NULL,
    targetLangId INTEGER NOT NULL,

    chunkSetting INTEGER NOT NULL DEFAULT 10,
    chunkSizeTotal INTEGER NOT NULL DEFAULT 0,
    chunkCurrent INTEGER NOT NULL DEFAULT 0,

    season INTEGER DEFAULT NULL,
    episode INTEGER DEFAULT NULL,

    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'paused')),

    orderNumber INTEGER NOT NULL DEFAULT 0,

    translatedText TEXT DEFAULT NULL,
    outputFilePath TEXT DEFAULT NULL,
    outputHash TEXT DEFAULT NULL,

    finishedAt DATETIME DEFAULT NULL,
    cancelledAt DATETIME DEFAULT NULL,
    cancelledByUserId INTEGER DEFAULT NULL,

    deletedAt DATETIME DEFAULT NULL,
    deletedByUserId INTEGER DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (subtitleId, targetLangId),

    FOREIGN KEY (subtitleId) REFERENCES subtitle(id) ON DELETE CASCADE,
    FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
    FOREIGN KEY (targetLangId) REFERENCES language(id),
    FOREIGN KEY (cancelledByUserId) REFERENCES user(id) ON DELETE SET NULL,
    FOREIGN KEY (deletedByUserId) REFERENCES user(id) ON DELETE SET NULL
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS subtitleChunk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    subtitleId INTEGER NOT NULL,
    subtitleJobId INTEGER NOT NULL,
    targetLangId INTEGER NOT NULL,

    chunkIndex INTEGER NOT NULL,

    srtIdFrom INTEGER NOT NULL,
    srtIdTo INTEGER NOT NULL,

    chunkTextRaw TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'retrying', 'waiting_for_judge')),

    judgeModelId INTEGER DEFAULT NULL,
    judgeReason TEXT DEFAULT NULL,

    selectedCandidateId INTEGER DEFAULT NULL,
    durationMs INTEGER DEFAULT NULL,

    retryCount INTEGER NOT NULL DEFAULT 0,
    errorMessage TEXT DEFAULT NULL,

    startedAt DATETIME DEFAULT NULL,
    finishedAt DATETIME DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (subtitleJobId, chunkIndex),

    FOREIGN KEY (subtitleId) REFERENCES subtitle(id) ON DELETE CASCADE,
    FOREIGN KEY (subtitleJobId) REFERENCES subtitleJob(id) ON DELETE CASCADE,
    FOREIGN KEY (targetLangId) REFERENCES language(id),
    FOREIGN KEY (judgeModelId) REFERENCES model(id),
    FOREIGN KEY (selectedCandidateId) REFERENCES subtitleChunkCandidate(id) ON DELETE SET NULL
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS subtitleChunkCandidate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    subtitleChunkId INTEGER NOT NULL,

    modelId INTEGER DEFAULT NULL,
    promptId INTEGER DEFAULT NULL,
    promptVersionId INTEGER DEFAULT NULL,

    promptTextSnapshot TEXT DEFAULT NULL,
    translatedText TEXT DEFAULT NULL,

    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'validation_failed')),

    validationPassed INTEGER DEFAULT NULL,

    selected INTEGER NOT NULL DEFAULT 0,

    retryCount INTEGER NOT NULL DEFAULT 0,
    durationMs INTEGER DEFAULT NULL,
    errorMessage TEXT DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (subtitleChunkId) REFERENCES subtitleChunk(id) ON DELETE CASCADE,
    FOREIGN KEY (modelId) REFERENCES model(id) ON DELETE SET NULL,
    FOREIGN KEY (promptId) REFERENCES prompt(id) ON DELETE SET NULL,
    FOREIGN KEY (promptVersionId) REFERENCES promptVersion(id) ON DELETE SET NULL
    )`)

    db.exec(`CREATE TABLE IF NOT EXISTS log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      level TEXT NOT NULL DEFAULT 'info'
        CHECK (level IN ('debug', 'info', 'warning', 'error')),

      type TEXT DEFAULT NULL,
      entityType TEXT DEFAULT NULL,
      entityId INTEGER DEFAULT NULL,

      message TEXT NOT NULL,
      metadata TEXT DEFAULT NULL,

      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deletedAt DATETIME DEFAULT NULL
  )`)

    db.exec(`CREATE TABLE IF NOT EXISTS migration (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    path TEXT DEFAULT NULL,
    appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

    db.exec(`
      INSERT INTO migration (name, version)
      VALUES ('initial', '0.0.1')
      ON CONFLICT(name) DO NOTHING
    `)
  })

  setup()
}

const validateDb = (db: Database.Database) => {
  try {
    const config = db.prepare(`SELECT * FROM config`).all()
    if (config.length === 0) {
      createTables(db)
    }
  } catch {
    createTables(db)
  }
}

// Idempotently add columns introduced after the initial schema. CREATE TABLE
// only runs for brand-new databases, so existing DBs need ALTER TABLE to pick
// up new columns. PRAGMA table_info is checked first so re-runs are no-ops.
const COLUMN_MIGRATIONS: { table: string; column: string; definition: string }[] = [
  { table: "config", column: "whisperRunAsSeparateTask", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "subtitle", column: "whisperOrderNumber", definition: "INTEGER" },
  { table: "subtitle", column: "sourceFormat", definition: "TEXT NOT NULL DEFAULT 'srt'" },
  // .sub provenance metadata (see subtitle table). Nullable so existing rows
  // and existing-DB migrations are safe (ALTER TABLE ADD COLUMN with no NOT
  // NULL is always valid). The CHECK constraints only apply on fresh DBs.
  { table: "subtitle", column: "textOrigin", definition: "TEXT DEFAULT NULL" },
  { table: "subtitle", column: "originalSourceFormat", definition: "TEXT DEFAULT NULL" },
  { table: "subtitle", column: "whisperResumeSrt", definition: "TEXT DEFAULT NULL" },
  { table: "subtitle", column: "whisperResumeMs", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "log", column: "type", definition: "TEXT DEFAULT NULL" },
  { table: "libraryPathItem", column: "isExtra", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "libraryPath", column: "scanMode", definition: "TEXT NOT NULL DEFAULT 'hourly'" },
  { table: "libraryPath", column: "scanRepeatInterval", definition: "INTEGER NOT NULL DEFAULT 1" },
  { table: "libraryPath", column: "scanRepeatUnit", definition: "TEXT NOT NULL DEFAULT 'day'" },
  { table: "libraryPath", column: "scanDayOfWeek", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "libraryPath", column: "scanStartTimeHour", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "libraryPath", column: "scanStartTimeMinute", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "libraryPath", column: "scanDurationMinutes", definition: "INTEGER NOT NULL DEFAULT 60" },
  { table: "libraryPath", column: "scanFirstStartAt", definition: "DATETIME DEFAULT NULL" },
  { table: "libraryPath", column: "initialScanDurationMs", definition: "INTEGER DEFAULT NULL" },
  { table: "libraryPath", column: "postInitialScanCount", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "libraryPath", column: "postInitialScanTotalMs", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "libraryPath", column: "lastScanDurationMs", definition: "INTEGER DEFAULT NULL" },
]

function applyColumnMigrations(db: Database.Database): void {
  for (const { table, column, definition } of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (cols.some((c) => c.name === column)) continue
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    } catch {
      /* column may have been added concurrently by another connection */
    }
  }
}

export function getDb(): Database.Database {
  const dbExists = fs.existsSync(dbName)
  const db = new Database(dbName)

  // Pragmas applied on every connection (main process + worker_threads).
  // WAL allows concurrent readers + a writer across threads/processes without
  // SQLITE_BUSY errors; synchronous=NORMAL is the safe pairing for WAL.
  // foreign_keys + busy_timeout were previously only set on new-DB creation —
  // setting them here fixes existing-DB connections too.
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")

  if (!dbExists) {
    createTables(db)
  } else {
    validateDb(db)
  }

  applyColumnMigrations(db)

  return db
}
