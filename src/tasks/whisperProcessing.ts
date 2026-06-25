// Shared Whisper-transcription logic used by both the translation worker
// (when `whisperRunAsSeparateTask` is off) and the dedicated Whisper worker
// (when it is on). Each worker passes its own `isPaused` callback so this
// module holds no worker-state of its own.
import Database from "better-sqlite3"
import * as fs from "fs"
import { getConfig, isWhisperGpuAvailable } from "../repositories/configRepository"
import { cleanupWhisperTempDir, transcribeMediaWithWhisper, WhisperRunHandle } from "../services/whisperService"
import {
  getConfigTranslationLanguages,
  getUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import { createLog } from "../repositories/logRepository"
import { getMediaItemById } from "../repositories/mediaRepository"
import { getHighestRoleUser, getUserById } from "../repositories/userRepository"
import {
  createTranslationJobsForSubtitle,
  finalizeWhisperTranscription,
  getSubtitleById,
  saveWhisperCheckpoint,
  setWhisperProgress,
  setWhisperTranscriptionStatus,
  resetWhisperProgress,
  updateSubtitleStatus,
} from "../repositories/subtitleRepository"
import { exportSubtitleToLibraryFolder } from "../services/libraryPathService"
import { parseSrt, serializeSrt } from "../services/srtService"
import { DBSubtitle, DBUser } from "../types/dbTypes"

// Transcribe one whisper-source subtitle, persist the generated SRT, spawn the
// per-target-language translation jobs, and (if the subtitle belongs to a
// library path with auto-extract on) write the original-language SRT into the
// library folder.
//
// `handle`, when provided (dedicated whisper worker only), makes the run
// abortable: Stop/preempt kills the whisper-cli process mid-run and the
// partial result is saved as a checkpoint (`whisperResumeSrt`/`whisperResumeMs`).
// On the next pick the checkpoint is read back and only the tail past
// `whisperResumeMs` is re-transcribed, then merged with the checkpoint. The
// non-separate translation-worker path passes no handle, so it behaves exactly
// as before (no abort, no checkpoint).
export async function transcribeSubtitleAndCreateJobs(
  db: Database.Database,
  subtitle: DBSubtitle,
  isPaused: () => boolean,
  handle?: WhisperRunHandle | null,
): Promise<void> {
  if (isPaused()) return

  const config = getConfig(db)
  if (!config.whisperEnabled) {
    setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
    updateSubtitleStatus(db, subtitle.id, "failed")
    createLog(db, "warning", "whisperTranscription", "subtitle", subtitle.id, "Whisper is disabled in settings; skipping transcription", {})
    return
  }

  const mediaPath = subtitle.mediaPath
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
    updateSubtitleStatus(db, subtitle.id, "failed")
    createLog(db, "error", "whisperTranscription", "subtitle", subtitle.id, "Whisper transcription failed: source media file not found", {
      mediaPath,
    })
    return
  }

  // Resume checkpoint: serialized SRT of the segments already transcribed + the
  // ms they end at. Present only when a previous run was stopped/preempted.
  const resumeMs = Math.max(0, Math.round(subtitle.whisperResumeMs ?? 0))
  const resumeEntries = resumeMs > 0 && subtitle.whisperResumeSrt ? parseSrt(subtitle.whisperResumeSrt) : []
  const fullDurationMs = Math.max(0, Math.round(subtitle.whisperDurationMs ?? 0))
  const isResume = resumeMs > 0 && resumeEntries.length > 0

  setWhisperTranscriptionStatus(db, subtitle.id, "transcribing")
  if (isResume) {
    // Show the bar continuing from the checkpoint rather than jumping back to 0.
    setWhisperProgress(
      db,
      subtitle.id,
      fullDurationMs > 0 ? Math.floor((resumeMs / fullDurationMs) * 100) : 0,
      resumeMs,
      fullDurationMs,
    )
  } else {
    resetWhisperProgress(db, subtitle.id)
  }
  const useCuda = isWhisperGpuAvailable() && config.whisperUseCuda === 1

  try {
    const onWhisperProgress = (progress: number, positionMs: number, durationMs: number): void => {
      setWhisperProgress(db, subtitle.id, progress, positionMs, durationMs)
    }
    const whisperMediaItem = subtitle.mediaItemId ? getMediaItemById(db, subtitle.mediaItemId) : null
    const whisperDisplayName = whisperMediaItem?.title ?? subtitle.name
    const result = await transcribeMediaWithWhisper(
      db,
      mediaPath,
      subtitle.mediaItemId ?? subtitle.id,
      config.whisperModel,
      onWhisperProgress,
      whisperDisplayName,
      { handle, resumeMs, fullDurationMs, resumeEntries },
    )

    // Aborted (Stop/preempt): persist the checkpoint and bail before finalizing.
    // Status stays "transcribing" so the item remains in the whisper queue and
    // is resumed from the checkpoint next time it reaches the top.
    if ("aborted" in result && result.aborted) {
      saveWhisperCheckpoint(db, subtitle.id, serializeSrt(result.checkpoint.entries), result.checkpoint.ms)
      createLog(
        db,
        "info",
        "whisperTranscription", "subtitle",
        subtitle.id,
        `Whisper transcription paused at ${result.checkpoint.ms}ms; will resume from there`,
        { checkpointMs: result.checkpoint.ms, segments: result.checkpoint.entries.length },
      )
      return
    }

    if (!result.success) {
      setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
      updateSubtitleStatus(db, subtitle.id, "failed")
      return
    }

    finalizeWhisperTranscription(
      db,
      subtitle.id,
      result.rawSrt,
      result.entries,
      subtitle.originalTextSRTName || "whisper.srt",
    )

    // The original-language SRT is now available — write it to the library
    // folder immediately (translated SRTs land as jobs complete). No-op when
    // the subtitle isn't tied to an auto-extract library path. Don't mark the
    // item completed: translation hasn't happened yet.
    const refreshed = getSubtitleById(db, subtitle.id)
    if (refreshed) {
      await exportSubtitleToLibraryFolder(db, refreshed, {
        includeOriginal: true,
        includeTranslated: true,
        markCompleted: false,
      })
    }

    // Resolve the user who created the workflow and their target languages.
    let actingUser: DBUser | null = getUserById(db, subtitle.userId)
    if (!actingUser) {
      actingUser = getHighestRoleUser(db)
    }
    if (!actingUser) {
      setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
      updateSubtitleStatus(db, subtitle.id, "failed")
      createLog(
        db,
        "error",
        "whisperTranscription", "subtitle",
        subtitle.id,
        "Whisper transcription failed: no valid user to attribute jobs to",
        {},
      )
      return
    }

    const userTargetLangs = getUserConfigTranslationLanguages(db, actingUser.id)
    const targetLangIds =
      userTargetLangs.length > 0
        ? userTargetLangs.map((tl) => tl.languageId)
        : getConfigTranslationLanguages(db).map((cl) => cl.languageId)

    if (targetLangIds.length === 0) {
      setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
      updateSubtitleStatus(db, subtitle.id, "failed")
      createLog(
        db,
        "error",
        "subtitleCompleted", "subtitle",
        subtitle.id,
        "Whisper transcription completed but no target languages configured; cannot create translation jobs",
        {},
      )
      return
    }

    setWhisperTranscriptionStatus(db, subtitle.id, "queued_for_translation")
    const jobResult = createTranslationJobsForSubtitle(
      db,
      actingUser,
      subtitle.id,
      targetLangIds,
      config.defaultChunkSize,
      null,
      null,
    )

    if (!jobResult.success) {
      setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
      updateSubtitleStatus(db, subtitle.id, "failed")
      createLog(
        db,
        "error",
        "whisperTranscription", "subtitle",
        subtitle.id,
        `Failed to create translation jobs from Whisper SRT: ${jobResult.msg}`,
        {},
      )
      return
    }

    setWhisperTranscriptionStatus(db, subtitle.id, null)
    updateSubtitleStatus(db, subtitle.id, "queued")
    createLog(db, "info", "subtitleCreate", "subtitle", subtitle.id, "Whisper-generated SRT imported and translation jobs created", {
      targetLangCount: targetLangIds.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
    updateSubtitleStatus(db, subtitle.id, "failed")
    createLog(db, "error", "whisperTranscription", "subtitle", subtitle.id, `Whisper transcription failed: ${msg.slice(0, 200)}`, {
      error: msg.slice(0, 200),
    })
    console.error(`[worker] Whisper transcription failed for subtitle ${subtitle.id}:`, msg)
  } finally {
    cleanupWhisperTempDir()
  }
}