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
} from "./seed/defaultPrompts"
import { seedLanguages } from "./seed/defaultLangs"
import { recommendedSeeds } from "./seed/recommendedModels"

export const dbName = process.env.DBPATH || "subtitles.db"

const createTables = (db: Database.Database) => {
  console.log("Creating new database...")

  const setup = db.transaction(() => {
    db.pragma("foreign_keys = ON")
    db.pragma("busy_timeout = 5000")

    db.exec(`CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    isAdmin INTEGER NOT NULL DEFAULT 0,

    canManageUsers INTEGER NOT NULL DEFAULT 0,
    canViewModels INTEGER NOT NULL DEFAULT 0,
    canManageModels INTEGER NOT NULL DEFAULT 0,
    canViewPrompts INTEGER NOT NULL DEFAULT 0,
    canManagePrompts INTEGER NOT NULL DEFAULT 0,
    canManageLanguages INTEGER NOT NULL DEFAULT 0,
    canManageConfig INTEGER NOT NULL DEFAULT 0,
    canAddSubtitles INTEGER NOT NULL DEFAULT 0,
    canStopSubtitles INTEGER NOT NULL DEFAULT 0,
    canDeleteSubtitles INTEGER NOT NULL DEFAULT 0,
    canViewLogs INTEGER NOT NULL DEFAULT 0,
    canManageSchedules INTEGER NOT NULL DEFAULT 0,
    pauseWorker INTEGER NOT NULL DEFAULT 0,
    downloadSubtitles INTEGER NOT NULL DEFAULT 0,
    canViewStats INTEGER NOT NULL DEFAULT 0,
    canManageSecret INTEGER NOT NULL DEFAULT 0,
    canManageLibraryPath INTEGER NOT NULL DEFAULT 0,
    canManageRootLibraryPath INTEGER NOT NULL DEFAULT 0,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deletedAt DATETIME DEFAULT NULL
  )`)

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

    defaultChunkSize INTEGER NOT NULL DEFAULT 14,
    maxRetriesPerChunk INTEGER NOT NULL DEFAULT 5,

    showPosters INTEGER NOT NULL DEFAULT 0,
    nameDetectionActive INTEGER NOT NULL DEFAULT 0,
    theMovieDbActive INTEGER NOT NULL DEFAULT 0,
    finishSingleSubtitleFirst INTEGER NOT NULL DEFAULT 1,
    scanLibraryPaths INTEGER NOT NULL DEFAULT 0,

    scheduleConfigured INTEGER NOT NULL DEFAULT 0,

    clearLogs INTEGER NOT NULL DEFAULT 0,
    clearLogsOlderThanDays INTEGER NOT NULL DEFAULT 30,

    version TEXT NOT NULL DEFAULT '0.0.1',

    sessionTimeoutMinutes INTEGER NOT NULL DEFAULT 240,

    selectedThemeId INTEGER NOT NULL DEFAULT 1,

    rootLibraryPath TEXT DEFAULT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)

            const theMovieDbKey = process.env.THEMOVIEDB_API_KEY?.trim()
    const theMovieDbActiveDefault = theMovieDbKey ? 1 : 0
    const rootLibraryPathDefault = process.env.TRANSLATION_ROOT_DIR?.trim() || null

    db.prepare(
      `INSERT INTO config (id, defaultChunkSize, theMovieDbActive, rootLibraryPath)
       VALUES (1, 10, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(theMovieDbActiveDefault, rootLibraryPathDefault)

    db.exec(`CREATE TABLE IF NOT EXISTS configTranslationLanguage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    languageId INTEGER NOT NULL,
    orderNumber INTEGER NOT NULL,

    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (languageId),

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
    posterBase64 TEXT DEFAULT NULL,

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

    orderNumber INTEGER NOT NULL DEFAULT 0,
    hide INTEGER NOT NULL DEFAULT 0,

    source TEXT DEFAULT NULL,
    sourcePath TEXT DEFAULT NULL,
    mediaPath TEXT DEFAULT NULL,

    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'paused')),

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

const runMigrations = (db: Database.Database): void => {
  const userCols = (db.pragma("table_info(user)") as { name: string }[]).map((c) => c.name)
  if (!userCols.includes("canManageRootLibraryPath")) {
    db.exec(`ALTER TABLE user ADD COLUMN canManageRootLibraryPath INTEGER NOT NULL DEFAULT 0`)
    console.log("Migration: added canManageRootLibraryPath to user")
  }

  const configCols = (db.pragma("table_info(config)") as { name: string }[]).map((c) => c.name)
  if (!configCols.includes("rootLibraryPath")) {
    db.exec(`ALTER TABLE config ADD COLUMN rootLibraryPath TEXT DEFAULT NULL`)
    console.log("Migration: added rootLibraryPath to config")
  }

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
    (t) => t.name,
  )
  if (!tables.includes("libraryPathItemBlacklist")) {
    db.exec(`CREATE TABLE libraryPathItemBlacklist (
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
    console.log("Migration: added libraryPathItemBlacklist table")
  }
}

export function getDb(): Database.Database {
  const dbExists = fs.existsSync(dbName)
  const db = new Database(dbName)

  if (!dbExists) {
    createTables(db)
  } else {
    validateDb(db)
  }

  runMigrations(db)

  return db
}

export const promptRules = [
  { note: "source language replacement rule", replaceText: "//sourceLang//" },
  { note: "source language short form replacement rule", replaceText: "//sourceShortLang//" },
  { note: "target language replacement rule", replaceText: "//targetLang//" },
  { note: "target language short form replacement rule", replaceText: "//targetShortLang//" },
  { note: "series or movie name replacement rule", replaceText: "//name//" },
  { note: "media type replacement rule", replaceText: "//mediaType//" },
  { note: "genres replacement rule", replaceText: "//genres//" },
  { note: "anime detection replacement rule", replaceText: "//isAnime//" },
  { note: "source subtitles text replacement rule for judge prompt", replaceText: "//sourceText//" },
  { note: "total candidates count replacement rule for judge prompt", replaceText: "//total//" },
  { note: "total candidates count minus one replacement rule for judge prompt", replaceText: "//totalMinusOne//" },
  { note: "translation candidates list replacement rule for judge prompt", replaceText: "//candidateList//" },
  { note: "movie or show name replacement rule for name formatter prompt", replaceText: "//filename//" },
]

export const theMovieDBSecretKey = "theMovieDBApiKey"
export const ollamaApiSecretKey = "ollamaApiKey"
export const openAIApiSecretKey = "openAIApiKey"
export const anthropicApiSecretKey = "anthropicApiKey"
export const apiKey = "apiKey"

export const LIBRARY_SCAN_INTERVAL_MS = 12_000
export const STUCK_SCAN_THRESHOLD_MINUTES = 10
