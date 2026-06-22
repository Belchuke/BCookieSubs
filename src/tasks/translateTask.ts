import Database from "better-sqlite3"
import SrtParser2 from "srt-parser-2"
import * as fs from "fs"
// parentPort is `null` when this module runs outside a worker_threads Worker
// (e.g. if ever imported on the main thread), so the calls below are no-ops there.
import { parentPort } from "worker_threads"
import { getConfig, isWhisperGpuAvailable } from "../repositories/configRepository"
import { cleanupWhisperTempDir, transcribeMediaWithWhisper } from "../services/whisperService"
import {
  getConfigTranslationLanguages,
  getLanguageById,
  getUserConfigTranslationLanguages,
} from "../repositories/languageRepository"
import { createLog, deleteLogsJob } from "../repositories/logRepository"
import { getMediaItemById } from "../repositories/mediaRepository"
import { getActiveModelsByRole, isModelActive, modelExists } from "../repositories/modelRepository"
import { getHighestRoleUser, getUserById } from "../repositories/userRepository"
import { sendPrompt } from "../repositories/ollamaRepository"
import {
  formatJudgePrompt,
  formatTranslationPrompt,
  insertJudgeEvaluation,
} from "../repositories/promptFormattingRepository"
import {
  createOrUpdatePromptStat,
  getJudgePromptVersion,
  getTranslationPromptVersions,
} from "../repositories/promptRepository"
import { getShouldRunNowBySchedule } from "../repositories/scheduleRepository"
import { parseLLMResponse, sleep, srtFormatterForModel, validateChunkIntegrity } from "../repositories/shared"
import {
  assembleAndFinishSubtitleJob,
  createChunkCandidate,
  createTranslationJobsForSubtitle,
  finalizeWhisperTranscription,
  getChunksByJobId,
  getNextQueuedChunkForWorker,
  getNextWhisperSubtitleForTranscription,
  countCompletedChunks,
  releaseRunningChunks,
  getSubtitleById,
  getSubtitleJobById,
  getSubtitleJobsBySubtitleId,
  incrementChunkRetry,
  markCandidateSelected,
  markChunkFailed,
  markChunkStarted,
  setSelectedCandidateForChunk,
  setWhisperTranscriptionStatus,
  setWhisperProgress,
  resetWhisperProgress,
  updateSubtitleJobProgress,
  updateSubtitleJobStatus,
  updateSubtitleStatus,
} from "../repositories/subtitleRepository"
import { DBModel, DBSubtitleChunk, DBSubtitleJob, DBSubtitle, DBLanguage, DBUser } from "../types/dbTypes"
import { IDLE_INTERVAL_MS, MODEL_REQUEST_TIMEOUT_MS, TASK_INTERVAL_MS } from "../constants/timer"

type TranslationErrorCode = "timeout" | "cancelled" | "rate_limited" | "model_error" | "validation_error"

class TranslationError extends Error {
  constructor(
    public code: TranslationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "TranslationError"
  }
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof TranslationError && err.code === "rate_limited") return true
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("too many requests")
    )
      return true
  }
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>
    if (e.status === 429 || e.statusCode === 429 || e.code === 429 || e.code === "rate_limited") return true
  }
  return false
}

function classifyRequestError(
  err: unknown,
  cancelSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): TranslationErrorCode {
  if (err instanceof DOMException && err.name === "AbortError") {
    if (cancelSignal.aborted) return "cancelled"
    if (timeoutSignal.aborted) return "timeout"
    return "cancelled"
  }
  if (err instanceof TranslationError) return err.code
  if (isRateLimitError(err)) return "rate_limited"
  return "model_error"
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200)
  return String(err).slice(0, 200)
}

let taskRunning = false
let currentScheduleId: number | null = null
const claimedChunkIds = new Set<number>()
let workerPaused = false
let currentAbortController: AbortController | null = null

// Push paused-state changes to the main thread so the control bridge can mirror
// `workerPaused` without polling. No-op when not running inside a Worker.
function notifyPausedState(paused: boolean): void {
  if (parentPort) parentPort.postMessage({ type: "state", paused })
}

export function cleanupRunningChunks(db: Database.Database): void {
  if (claimedChunkIds.size === 0) return
  const ids = Array.from(claimedChunkIds)
  releaseRunningChunks(db, ids)
  claimedChunkIds.clear()
  console.log(`[worker] Released ${ids.length} running chunk(s) back to queue`)
}

export function pauseWorker(db: Database.Database, actingUsername: string | null = null): void {
  workerPaused = true
  if (currentAbortController) {
    currentAbortController.abort()
  }
  cleanupRunningChunks(db)
  const who = actingUsername ?? "unknown user"
  createLog(db, "info", "worker", null, `Worker paused by user: ${who}`, { username: actingUsername })
  console.log(`[worker] Worker paused by user: ${who}`)
  notifyPausedState(true)
}

export function resumeWorker(db?: Database.Database, actingUsername: string | null = null): void {
  workerPaused = false
  const who = actingUsername ?? "unknown user"
  if (db) {
    createLog(db, "info", "worker", null, `Worker resumed by user: ${who}`, { username: actingUsername })
  }
  console.log(`[worker] Worker resumed by user: ${who}`)
  notifyPausedState(false)
}

export function isWorkerPaused(): boolean {
  return workerPaused
}

export async function taskMain(db: Database.Database): Promise<void> {
  createLog(db, "info", "worker", null, "Translation worker started", {})
  console.log("[worker] Translation worker started")

  while (true) {
    try {
      await runOnce(db)
    } catch (err) {
      createLog(db, "error", "worker", null, `Translation worker loop crashed: ${summarizeError(err)}`, {
        error: String(err),
      })
      console.error("[worker] Unexpected error:", err)
    }
    await sleep(TASK_INTERVAL_MS)
  }
}

async function runOnce(db: Database.Database): Promise<void> {
  if (workerPaused) return

  const scheduleResult = getShouldRunNowBySchedule(db, currentScheduleId)
  currentScheduleId = scheduleResult.scheduleId

  if (!scheduleResult.shouldRun) {
    if (taskRunning) {
      taskRunning = false
      createLog(db, "info", "worker", null, "Worker paused automatically: outside configured schedule window", {
        scheduleId: scheduleResult.scheduleId,
      })
      console.log("[worker] Paused — outside schedule window")
      notifyPausedState(true)
    }
    await sleep(IDLE_INTERVAL_MS - TASK_INTERVAL_MS)
    return
  }

  if (!taskRunning) {
    taskRunning = true
    createLog(db, "info", "worker", null, "Worker resumed: inside configured schedule window", {
      scheduleId: scheduleResult.scheduleId,
      scheduleActive: scheduleResult.scheduleActive,
    })
    console.log("[worker] Active")
    notifyPausedState(false)
  }

  const config = getConfig(db)

  deleteLogsJob(db)

  const whisperSubtitle = getNextWhisperSubtitleForTranscription(db)
  if (whisperSubtitle) {
    await processWhisperTranscription(db, whisperSubtitle)
    return
  }

  const chunk = getNextQueuedChunkForWorker(db, !!config.finishSingleSubtitleFirst)
  if (!chunk) {
    return
  }

  await processChunk(db, chunk)
}

async function abortableSendPrompt(
  db: Database.Database,
  model: DBModel,
  promptText: string,
  cancelSignal: AbortSignal,
): Promise<{ message: { content: string } }> {
  const timeoutSignal = AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)
  const combinedSignal = AbortSignal.any([cancelSignal, timeoutSignal])

  return new Promise((resolve, reject) => {
    if (combinedSignal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"))
    combinedSignal.addEventListener("abort", onAbort, { once: true })
    sendPrompt(db, model, promptText).then(
      (result) => {
        combinedSignal.removeEventListener("abort", onAbort)
        resolve(result)
      },
      (err) => {
        combinedSignal.removeEventListener("abort", onAbort)
        reject(err)
      },
    )
  })
}

async function processChunk(db: Database.Database, chunk: DBSubtitleChunk): Promise<void> {
  const config = getConfig(db)

  currentAbortController = new AbortController()
  const signal = currentAbortController.signal

  markChunkStarted(db, chunk.id)
  claimedChunkIds.add(chunk.id)

  const job = getSubtitleJobById(db, chunk.subtitleJobId)
  if (!job) {
    markChunkFailed(db, chunk.id, "subtitleJob not found")
    return
  }

  if (job.status === "queued") {
    updateSubtitleJobStatus(db, job.id, "running")
  }

  const subtitle = getSubtitleById(db, chunk.subtitleId)
  if (!subtitle) {
    markChunkFailed(db, chunk.id, "subtitle not found")
    return
  }

  if (subtitle.status === "queued") {
    updateSubtitleStatus(db, subtitle.id, "running")
  }

  const sourceLang = getLanguageById(db, subtitle.sourceLangId)
  const targetLang = getLanguageById(db, chunk.targetLangId)

  if (!sourceLang || !targetLang) {
    markChunkFailed(db, chunk.id, "Source or target language not found")
    createLog(
      db,
      "error",
      "chunk",
      chunk.id,
      `Chunk ${chunk.chunkIndex} failed: source or target language missing in database`,
      {
        subtitleId: chunk.subtitleId,
        sourceLangId: subtitle.sourceLangId,
        targetLangId: chunk.targetLangId,
      },
    )
    return
  }

  const mediaItem = subtitle.mediaItemId ? getMediaItemById(db, subtitle.mediaItemId) : null
  const mediaName = mediaItem?.title ?? subtitle.name

  const srtParser = new SrtParser2()
  const allLines = srtParser.fromSrt(subtitle.originalText)
  const chunkLines = allLines.filter((l) => {
    const id = parseInt(l.id)
    return id >= chunk.srtIdFrom && id <= chunk.srtIdTo
  })

  if (chunkLines.length === 0) {
    markChunkFailed(db, chunk.id, "No SRT lines found for this chunk range")
    return
  }

  const sourceRows = chunkLines.map((l) => ({ id: l.id, text: l.text }))
  const chunkXml = srtFormatterForModel(sourceRows)

  const translationModels = getActiveModelsByRole(db, "translation")
  const translationPromptVersions = getTranslationPromptVersions(db)

  if (translationModels.length === 0) {
    markChunkFailed(db, chunk.id, "No active translation models configured")
    createLog(
      db,
      "error",
      "chunk",
      chunk.id,
      `Chunk ${chunk.chunkIndex} failed: no active translation models configured — add one in the Models page`,
      {
        subtitleId: chunk.subtitleId,
        jobId: chunk.subtitleJobId,
      },
    )
    return
  }

  if (translationPromptVersions.length === 0) {
    markChunkFailed(db, chunk.id, "No active translation prompt versions configured")
    createLog(
      db,
      "error",
      "chunk",
      chunk.id,
      `Chunk ${chunk.chunkIndex} failed: no active translation prompt versions — activate at least one in the Prompts page`,
      {
        subtitleId: chunk.subtitleId,
        jobId: chunk.subtitleJobId,
      },
    )
    return
  }

  const startTime = new Date()
  console.log(
    `[worker] ${new Date().toISOString()} Processing chunk ${chunk.chunkIndex} of job ${job.id} (${subtitle.name} ${mediaItem?.type === `series` ? `S${job.season}E${job.episode}` : ""} → ${targetLang.name}) retry=${chunk.retryCount}`,
  )

  const validCandidates: {
    candidateId: number
    modelId: number
    promptVersionId: number
    promptId: number
    rows: { id: string; text: string }[]
  }[] = []

  const mediaType = mediaItem?.isAnime
    ? "anime"
    : mediaItem?.type === "series"
      ? "series"
      : mediaItem?.type === "movie"
        ? "movie"
        : "unknown"

  for (const model of translationModels) {
    if (workerPaused) return

    if (!isModelActive(db, model.id)) {
      createLog(
        db,
        "warning",
        "chunk",
        chunk.id,
        `Translation candidate skipped because model was deleted during processing: modelId=${model.id}, chunkId=${chunk.id}`,
        { modelId: model.id, modelName: model.name, chunkId: chunk.id, jobId: chunk.subtitleJobId },
      )
      console.log(`[worker] Skipping deleted model ${model.name} (id=${model.id}) for chunk ${chunk.id}`)
      continue
    }

    for (const promptVersion of translationPromptVersions) {
      let candidateAttempts = 0

      while (candidateAttempts < config.maxRetriesPerChunk) {
        if (workerPaused) return

        const startMs = Date.now()
        const promptText = formatTranslationPrompt(
          promptVersion.promptText,
          sourceLang,
          targetLang,
          mediaName,
          mediaItem?.genres || null,
          mediaType,
          chunkXml,
        )

        try {
          createOrUpdatePromptStat(
            db,
            promptVersion.promptId,
            promptVersion.id,
            model.id,
            targetLang.id,
            true,
            false,
            false,
            false,
          )

          const response = await abortableSendPrompt(db, model, promptText, signal)
          const content = response.message.content
          const durationMs = Date.now() - startMs

          const parsed = parseLLMResponse(content)
          if (parsed && validateChunkIntegrity(sourceRows, parsed.rows)) {
            const rows = parsed.rows

            const candidateId = createChunkCandidate(
              db,
              chunk.id,
              model.id,
              promptVersion.promptId,
              promptVersion.id,
              promptText,
              JSON.stringify(rows),
              true,
              "completed",
              durationMs,
              null,
            )

            validCandidates.push({
              candidateId,
              modelId: model.id,
              promptVersionId: promptVersion.id,
              promptId: promptVersion.promptId,
              rows,
            })

            createOrUpdatePromptStat(
              db,
              promptVersion.promptId,
              promptVersion.id,
              model.id,
              targetLang.id,
              false,
              false,
              true,
              false,
            )
            break
          } else {
            const reason = !parsed ? "Could not parse XML response" : "Chunk integrity validation failed"
            candidateAttempts++

            if (candidateAttempts >= config.maxRetriesPerChunk) {
              createChunkCandidate(
                db,
                chunk.id,
                model.id,
                promptVersion.promptId,
                promptVersion.id,
                promptText,
                null,
                false,
                "validation_failed",
                durationMs,
                reason,
              )
              createOrUpdatePromptStat(
                db,
                promptVersion.promptId,
                promptVersion.id,
                model.id,
                targetLang.id,
                false,
                true,
                false,
                false,
              )
              console.log(
                `[worker] Candidate (model=${model.name}, prompt=${promptVersion.id}) validation failed after ${candidateAttempts} attempts: ${reason}`,
              )
              break
            }

            console.log(
              `[worker] Retrying candidate (model=${model.name}, prompt=${promptVersion.id}) attempt ${candidateAttempts + 1}/${config.maxRetriesPerChunk}: ${reason}`,
            )
          }
        } catch (err) {
          if (workerPaused || (currentAbortController && currentAbortController.signal.aborted)) {
            return
          }

          const timeoutSignal = AbortSignal.timeout(0)
          const errorCode = classifyRequestError(err, signal, timeoutSignal)
          const errorSummary = summarizeError(err)
          const durationMs = Date.now() - startMs

          if (errorCode === "cancelled") {
            return
          }

          if (errorCode === "rate_limited") {
            createChunkCandidate(
              db,
              chunk.id,
              model.id,
              promptVersion.promptId,
              promptVersion.id,
              promptText,
              null,
              false,
              "failed",
              durationMs,
              `rate_limited: ${errorSummary}`,
            )
            createOrUpdatePromptStat(
              db,
              promptVersion.promptId,
              promptVersion.id,
              model.id,
              targetLang.id,
              false,
              true,
              false,
              false,
            )
            console.log(`[worker] Rate limited on model ${model.name} with prompt ${promptVersion.id}: ${errorSummary}`)
            createLog(db, "warning", "model", model.id, `Rate limited during translation using model ${model.name}`, {
              modelName: model.name,
              provider: model.provider,
              chunkId: chunk.id,
              subtitleId: chunk.subtitleId,
              jobId: chunk.subtitleJobId,
              promptId: promptVersion.promptId,
              promptVersionId: promptVersion.id,
              error: errorSummary,
            })
            break
          }

          candidateAttempts++

          if (candidateAttempts >= config.maxRetriesPerChunk) {
            createChunkCandidate(
              db,
              chunk.id,
              model.id,
              promptVersion.promptId,
              promptVersion.id,
              promptText,
              null,
              false,
              "failed",
              durationMs,
              errorSummary,
            )
            createOrUpdatePromptStat(
              db,
              promptVersion.promptId,
              promptVersion.id,
              model.id,
              targetLang.id,
              false,
              true,
              false,
              false,
            )
            console.error(
              `[worker] Candidate (model=${model.name}, prompt=${promptVersion.id}) failed after ${candidateAttempts} attempts: ${errorSummary}`,
            )
            createLog(
              db,
              "error",
              "chunk",
              chunk.id,
              `Translation candidate failed after ${candidateAttempts} retries (model ${model.name}, prompt v${promptVersion.id}): ${errorSummary}`,
              {
                modelName: model.name,
                provider: model.provider,
                modelId: model.id,
                chunkId: chunk.id,
                subtitleId: chunk.subtitleId,
                jobId: chunk.subtitleJobId,
                promptId: promptVersion.promptId,
                promptVersionId: promptVersion.id,
                attempts: candidateAttempts,
                failureCategory: errorCode,
                error: errorSummary,
              },
            )
            break
          }

          console.log(
            `[worker] Retrying candidate (model=${model.name}, prompt=${promptVersion.id}) attempt ${candidateAttempts + 1}/${config.maxRetriesPerChunk}: ${errorCode} — ${errorSummary}`,
          )
          createLog(
            db,
            "warning",
            "chunk",
            chunk.id,
            `Retrying translation candidate (${errorCode}) — model ${model.name}, attempt ${candidateAttempts + 1}/${config.maxRetriesPerChunk}: ${errorSummary}`,
            {
              modelName: model.name,
              provider: model.provider,
              modelId: model.id,
              chunkId: chunk.id,
              subtitleId: chunk.subtitleId,
              jobId: chunk.subtitleJobId,
              promptId: promptVersion.promptId,
              promptVersionId: promptVersion.id,
              attempt: candidateAttempts + 1,
              failureCategory: errorCode,
              error: errorSummary,
            },
          )
        }
      }
    }
  }

  if (workerPaused) return

  if (validCandidates.length === 0) {
    markChunkFailed(db, chunk.id, `No valid candidates after all retries exhausted`)
    createLog(
      db,
      "error",
      "chunk",
      chunk.id,
      `Chunk ${chunk.chunkIndex} failed: no valid translation candidates produced after ${config.maxRetriesPerChunk} retries per model+prompt`,
      {
        subtitleId: chunk.subtitleId,
        jobId: chunk.subtitleJobId,
        chunkIndex: chunk.chunkIndex,
        maxRetries: config.maxRetriesPerChunk,
      },
    )
    console.log(`[worker] Chunk ${chunk.chunkIndex} failed — no valid candidates`)

    await checkAndFinalizeJob(db, job, subtitle)
    return
  }

  if (workerPaused) return
  const winnerCandidate = await judgeAndSelectCandidate(
    db,
    validCandidates,
    sourceRows,
    sourceLang,
    targetLang,
    mediaName,
    mediaItem?.genres || null,
    mediaType,
    signal,
    config.maxRetriesPerChunk,
    chunk.id,
    job.id,
  )

  if (!winnerCandidate) {
    if (chunk.retryCount + 1 >= config.maxRetriesPerChunk) {
      markChunkFailed(db, chunk.id, "Judge failed to select a candidate after max retries")
      createLog(
        db,
        "error",
        "chunk",
        chunk.id,
        `Chunk ${chunk.chunkIndex} failed — judge could not select after ${config.maxRetriesPerChunk} retries`,
        {
          chunkIndex: chunk.chunkIndex,
          jobId: job.id,
          subtitleId: chunk.subtitleId,
        },
      )
      await checkAndFinalizeJob(db, job, subtitle)
    } else {
      incrementChunkRetry(db, chunk.id, "Judge failed to select a candidate")
    }
    return
  }

  const durationMs = new Date().getTime() - startTime.getTime()

  try {
    markCandidateSelected(db, winnerCandidate.candidateId)
    setSelectedCandidateForChunk(
      db,
      chunk.id,
      winnerCandidate.candidateId,
      winnerCandidate.judgeModelId,
      winnerCandidate.judgeReason,
      durationMs,
    )
    if (winnerCandidate.judgePromptText) {
      insertJudgeEvaluation(
        db,
        chunk.id,
        winnerCandidate.judgeModelId,
        winnerCandidate.judgePromptText,
        winnerCandidate.candidateId,
        winnerCandidate.judgeReason,
      )
    }

    const winner = validCandidates.find((c) => c.candidateId === winnerCandidate.candidateId)
    if (winner) {
      if (modelExists(db, winner.modelId)) {
        createOrUpdatePromptStat(
          db,
          winner.promptId,
          winner.promptVersionId,
          winner.modelId,
          targetLang.id,
          false,
          false,
          false,
          true,
        )
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    createLog(
      db,
      "warning",
      "chunk",
      chunk.id,
      `Chunk ${chunk.chunkIndex + 1} finalization skipped due to error (likely deleted model): ${msg.slice(0, 200)}`,
      {
        chunkId: chunk.id,
        jobId: job.id,
        error: msg,
      },
    )
    console.warn(`[worker] Chunk ${chunk.id} finalization error (possibly deleted model): ${msg.slice(0, 200)}`)
  }

  createLog(
    db,
    "info",
    "chunk",
    chunk.id,
    `Chunk ${chunk.chunkIndex + 1} completed for ${mediaName} ${mediaItem?.type === `series` ? `S${job.season}E${job.episode}` : ""}`,
    {
      chunkIndex: chunk.chunkIndex,
      jobId: job.id,
      judgeReason: winnerCandidate.judgeReason,
    },
  )
  console.log(
    `[worker] ${new Date().toISOString()} Chunk ${chunk.chunkIndex + 1} completed for ${mediaName} ${mediaItem?.type === `series` ? `S${job.season}E${job.episode}` : ""}`,
  )

  if (workerPaused) return

  updateSubtitleJobProgress(db, job.id, countCompletedChunks(db, job.id))

  await checkAndFinalizeJob(db, job, subtitle)
}

type JudgeRunStatus =
  | { status: "selected"; candidateId: number; judgeModelId: number; judgeReason: string }
  | { status: "rejected" }
  | { status: "failed" }

async function runJudgeModel(
  db: Database.Database,
  judgeModel: DBModel,
  judgePromptText: string,
  signal: AbortSignal,
  maxRetries: number,
  candidates: { candidateId: number }[],
  chunkId: number,
  jobId: number,
): Promise<JudgeRunStatus> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await abortableSendPrompt(db, judgeModel, judgePromptText, signal)
      const jsonMatch = response.message.content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        createLog(
          db,
          "warning",
          "chunk",
          chunkId,
          `Judge returned no valid JSON (model ${judgeModel.name}, attempt ${attempt + 1}/${maxRetries})`,
          {
            judgeModel: judgeModel.name,
            judgeModelId: judgeModel.id,
            chunkId,
            jobId,
            attempt: attempt + 1,
            failureCategory: "invalid_response",
            responseSample: response.message.content.slice(0, 200),
          },
        )
        if (attempt + 1 >= maxRetries) return { status: "failed" }
        console.log(`[worker] Retrying judge attempt ${attempt + 2}/${maxRetries}: no valid JSON`)
        continue
      }

      const result = JSON.parse(jsonMatch[0]) as { winnerIndex: number; reason?: string }

      if (result.winnerIndex === -1) {
        createLog(db, "warning", "chunk", chunkId, `Judge rejected all candidates (model ${judgeModel.name})`, {
          judgeModel: judgeModel.name,
          judgeModelId: judgeModel.id,
          chunkId,
          jobId,
          reason: result.reason,
        })
        return { status: "rejected" }
      }

      if (result.winnerIndex < 0 || result.winnerIndex >= candidates.length) {
        createLog(
          db,
          "warning",
          "chunk",
          chunkId,
          `Judge returned out-of-range index ${result.winnerIndex} (model ${judgeModel.name}, ${candidates.length} candidates)`,
          {
            judgeModel: judgeModel.name,
            judgeModelId: judgeModel.id,
            chunkId,
            jobId,
            winnerIndex: result.winnerIndex,
            total: candidates.length,
            failureCategory: "out_of_range_index",
          },
        )
        if (attempt + 1 >= maxRetries) return { status: "failed" }
        console.log(`[worker] Retrying judge attempt ${attempt + 2}/${maxRetries}: out-of-range index`)
        continue
      }

      return {
        status: "selected",
        candidateId: candidates[result.winnerIndex].candidateId,
        judgeModelId: judgeModel.id,
        judgeReason: result.reason ?? `Selected candidate ${result.winnerIndex}`,
      }
    } catch (err) {
      const errorSummary = summarizeError(err)
      const failureCategory = isRateLimitError(err) ? "rate_limited" : "api_error"
      createLog(
        db,
        "error",
        "chunk",
        chunkId,
        `Judge call failed (model ${judgeModel.name}, attempt ${attempt + 1}/${maxRetries}, ${failureCategory}): ${errorSummary}`,
        {
          judgeModel: judgeModel.name,
          judgeModelId: judgeModel.id,
          provider: judgeModel.provider,
          chunkId,
          jobId,
          attempt: attempt + 1,
          failureCategory,
          error: errorSummary,
        },
      )
      if (attempt + 1 >= maxRetries) return { status: "failed" }
      console.log(`[worker] Retrying judge attempt ${attempt + 2}/${maxRetries}: API error — ${errorSummary}`)
    }
  }
  return { status: "failed" }
}

async function judgeAndSelectCandidate(
  db: Database.Database,
  candidates: {
    candidateId: number
    modelId: number
    promptVersionId: number
    promptId: number
    rows: { id: string; text: string }[]
  }[],
  sourceRows: { id: string; text: string }[],
  sourceLang: DBLanguage,
  targetLang: DBLanguage,
  mediaName: string,
  genres: string | null,
  mediaType: string,
  signal: AbortSignal,
  maxRetries: number,
  chunkId: number,
  jobId: number,
): Promise<{
  candidateId: number
  judgeModelId: number | null
  judgeReason: string | null
  judgePromptText: string
} | null> {
  if (candidates.length === 1) {
    return {
      candidateId: candidates[0].candidateId,
      judgeModelId: null,
      judgeReason: "Only candidate",
      judgePromptText: "",
    }
  }

  const judgePromptVersion = getJudgePromptVersion(db)
  const judgeModels = getActiveModelsByRole(db, "judge")

  if (!judgePromptVersion || judgeModels.length === 0) {
    createLog(db, "info", "chunk", chunkId, "No judge configured — using first valid candidate", { jobId })
    return {
      candidateId: candidates[0].candidateId,
      judgeModelId: null,
      judgeReason: "No judge configured",
      judgePromptText: "",
    }
  }

  const judgeModel = judgeModels[0]
  const sourceChunkXml = srtFormatterForModel(sourceRows)

  const judgePromptText = formatJudgePrompt(
    judgePromptVersion.promptText,
    sourceLang,
    targetLang,
    mediaName,
    sourceChunkXml,
    genres,
    mediaType,
    candidates.map((c, i) => ({ index: i, translatedRows: c.rows })),
  )

  const runResult = await runJudgeModel(db, judgeModel, judgePromptText, signal, maxRetries, candidates, chunkId, jobId)

  if (runResult.status === "selected") {
    return {
      candidateId: runResult.candidateId,
      judgeModelId: runResult.judgeModelId,
      judgeReason: runResult.judgeReason,
      judgePromptText,
    }
  }

  const fallbackModels = getActiveModelsByRole(db, "fallbackJudge")
  if (fallbackModels.length > 0) {
    const reason = runResult.status === "rejected" ? "rejected all candidates" : "failed"
    createLog(
      db,
      "info",
      "chunk",
      chunkId,
      `Primary judge ${reason} (model ${judgeModel.name}) — falling back to ${fallbackModels[0].name}`,
      {
        primaryJudgeModel: judgeModel.name,
        primaryJudgeModelId: judgeModel.id,
        fallbackJudgeModel: fallbackModels[0].name,
        fallbackJudgeModelId: fallbackModels[0].id,
        jobId,
      },
    )
    const fallbackResult = await runJudgeModel(
      db,
      fallbackModels[0],
      judgePromptText,
      signal,
      maxRetries,
      candidates,
      chunkId,
      jobId,
    )
    if (fallbackResult.status === "selected") {
      createLog(db, "info", "chunk", chunkId, `Fallback judge selected candidate (model ${fallbackModels[0].name})`, {
        fallbackJudgeModel: fallbackModels[0].name,
        fallbackJudgeModelId: fallbackModels[0].id,
        jobId,
      })
      return {
        candidateId: fallbackResult.candidateId,
        judgeModelId: fallbackResult.judgeModelId,
        judgeReason: `[fallback judge] ${fallbackResult.judgeReason}`,
        judgePromptText,
      }
    }
    createLog(db, "warning", "chunk", chunkId, `Fallback judge also failed (model ${fallbackModels[0].name})`, {
      fallbackJudgeModel: fallbackModels[0].name,
      fallbackJudgeModelId: fallbackModels[0].id,
      jobId,
    })
    if (fallbackResult.status === "rejected") {
      return null
    }
  }

  if (runResult.status === "rejected") {
    return null
  }

  return {
    candidateId: candidates[0].candidateId,
    judgeModelId: null,
    judgeReason: "Judge failed — using first candidate",
    judgePromptText,
  }
}

async function checkAndFinalizeJob(db: Database.Database, job: DBSubtitleJob, subtitle: DBSubtitle): Promise<void> {
  const allChunks = getChunksByJobId(db, job.id)
  const pendingChunks = allChunks.filter(
    (c) =>
      c.status === "queued" || c.status === "running" || c.status === "retrying" || c.status === "waiting_for_judge",
  )
  const failedChunks = allChunks.filter((c) => c.status === "failed")

  if (pendingChunks.length > 0) return

  if (failedChunks.length > 0) {
    updateSubtitleJobStatus(db, job.id, "failed")
    createLog(
      db,
      "error",
      "subtitleJob",
      job.id,
      `Subtitle job ${job.id} failed: ${failedChunks.length}/${allChunks.length} chunks could not be translated`,
      {
        subtitleId: job.subtitleId,
        failedChunks: failedChunks.length,
        totalChunks: allChunks.length,
      },
    )
    console.log(`[worker] Job ${job.id} failed (${failedChunks.length} failed chunks)`)
  } else {
    assembleAndFinishSubtitleJob(db, job, subtitle, "output")
    console.log(`[worker] Job ${job.id} completed`)
  }

  await checkAndFinalizeSubtitle(db, subtitle)
}

async function processWhisperTranscription(db: Database.Database, subtitle: DBSubtitle): Promise<void> {
  if (workerPaused) return

  const config = getConfig(db)
  if (!config.whisperEnabled) {
    setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
    updateSubtitleStatus(db, subtitle.id, "failed")
    createLog(db, "warning", "subtitle", subtitle.id, "Whisper is disabled in settings; skipping transcription", {})
    return
  }

  const mediaPath = subtitle.mediaPath
  if (!mediaPath || !fs.existsSync(mediaPath)) {
    setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
    updateSubtitleStatus(db, subtitle.id, "failed")
    createLog(db, "error", "subtitle", subtitle.id, "Whisper transcription failed: source media file not found", {
      mediaPath,
    })
    return
  }

  setWhisperTranscriptionStatus(db, subtitle.id, "transcribing")
  resetWhisperProgress(db, subtitle.id)
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
    )

    if (workerPaused) {
      cleanupWhisperTempDir()
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
        "subtitle",
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
        "subtitle",
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
        "subtitle",
        subtitle.id,
        `Failed to create translation jobs from Whisper SRT: ${jobResult.msg}`,
        {},
      )
      return
    }

    setWhisperTranscriptionStatus(db, subtitle.id, null)
    updateSubtitleStatus(db, subtitle.id, "queued")
    createLog(db, "info", "subtitle", subtitle.id, "Whisper-generated SRT imported and translation jobs created", {
      targetLangCount: targetLangIds.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setWhisperTranscriptionStatus(db, subtitle.id, "transcription_failed")
    updateSubtitleStatus(db, subtitle.id, "failed")
    createLog(db, "error", "subtitle", subtitle.id, `Whisper transcription failed: ${msg.slice(0, 200)}`, {
      error: msg.slice(0, 200),
    })
    console.error(`[worker] Whisper transcription failed for subtitle ${subtitle.id}:`, msg)
  } finally {
    cleanupWhisperTempDir()
  }
}

async function checkAndFinalizeSubtitle(db: Database.Database, subtitle: DBSubtitle): Promise<void> {
  const allJobs = getSubtitleJobsBySubtitleId(db, subtitle.id)
  const pendingJobs = allJobs.filter((j) => j.status === "queued" || j.status === "running")

  if (pendingJobs.length > 0) return

  const failedJobs = allJobs.filter((j) => j.status === "failed")
  if (failedJobs.length > 0) {
    updateSubtitleStatus(db, subtitle.id, "failed")
    createLog(
      db,
      "error",
      "subtitle",
      subtitle.id,
      `Subtitle "${subtitle.name}" completed with failures: ${failedJobs.length}/${allJobs.length} target languages failed`,
      {
        name: subtitle.name,
        failedJobs: failedJobs.length,
        totalJobs: allJobs.length,
      },
    )
  } else {
    updateSubtitleStatus(db, subtitle.id, "completed")
    createLog(
      db,
      "info",
      "subtitle",
      subtitle.id,
      `Subtitle "${subtitle.name}" fully translated to ${allJobs.length} target language${allJobs.length === 1 ? "" : "s"}`,
      {
        name: subtitle.name,
        jobs: allJobs.length,
      },
    )
    console.log(`[worker] Subtitle "${subtitle.name}" fully completed`)
  }
}
