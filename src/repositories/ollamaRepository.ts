import Database from "better-sqlite3"
import axios from "axios"
import { DBModel } from "../types/dbTypes"
import { ollamaApiSecretKey, openAIApiSecretKey, anthropicApiSecretKey } from "../setup"
import { Ollama, ModelResponse } from "ollama"
import { getSecretByName } from "./secretRepository"

const OLLAMA_HOST = process.env.OLLAMA_BASE_URL?.trim() || process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434"
const ollama = new Ollama({ host: OLLAMA_HOST })

export async function getModelsFromOllama(): Promise<{
  models: ModelResponse[]
  error: string | null
  ollamaRunning: boolean | null
}> {
  try {
    const ollamaModels = await ollama.list()
    return { models: ollamaModels.models, error: null, ollamaRunning: true }
  } catch (err: unknown) {
    if (err instanceof Error) {
      if ((err as any).cause?.code === "ECONNREFUSED") {
        return { models: [], error: (err as Error).message, ollamaRunning: false }
      } else {
        return { models: [], error: (err as Error).message, ollamaRunning: null }
      }
    }
    return { models: [], error: String(err), ollamaRunning: null }
  }
}

export async function getActiveRunningOllamaModels(): Promise<{
  models: ModelResponse[]
  error: string | null
  ollamaRunning: boolean | null
}> {
  try {
    const ollamaModels = await ollama.ps()
    return { models: ollamaModels.models, error: null, ollamaRunning: true }
  } catch (err: unknown) {
    if (err instanceof Error) {
      if ((err as any).cause?.code === "ECONNREFUSED") {
        return { models: [], error: (err as Error).message, ollamaRunning: false }
      } else {
        return { models: [], error: (err as Error).message, ollamaRunning: null }
      }
    }
    return { models: [], error: String(err), ollamaRunning: null }
  }
}

class RateLimitError extends Error {
  public readonly code = "rate_limited" as const
  constructor(message: string) {
    super(message)
    this.name = "RateLimitError"
  }
}

function wrapRateLimitError(err: unknown, model: DBModel): never {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (
      msg.includes("429") ||
      msg.includes("rate limit") ||
      msg.includes("rate_limit") ||
      msg.includes("too many requests")
    ) {
      throw new RateLimitError(`Rate limited on model ${model.name}: ${err.message}`)
    }
    const e = err as unknown as Record<string, unknown>
    if (e.status === 429 || e.statusCode === 429) {
      throw new RateLimitError(`Rate limited (429) on model ${model.name}`)
    }
  }
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>
    if (e.status === 429 || e.statusCode === 429 || e.code === 429) {
      throw new RateLimitError(`Rate limited (429) on model ${model.name}`)
    }
  }
  throw err
}

export async function sendPrompt(
  db: Database.Database,
  model: DBModel,
  prompt: string,
): Promise<{ message: { content: string } }> {
  try {
    if (model.provider === "ollama cloud") {
      const key = getSecretByName(db, ollamaApiSecretKey)
      const host = model.baseUrl || "http://localhost:11434"
      const customOllama = new Ollama({ host, headers: { Authorization: `Bearer ${key}` } })
      const response = await customOllama.chat({
        model: model.modelName,
        messages: [{ role: "user", content: prompt }],
      })
      return response
    }

    if (model.provider === "chatgpt") {
      const key = getSecretByName(db, openAIApiSecretKey)
      const baseUrl = model.baseUrl || "https://api.openai.com/v1"
      const res = await axios.post(
        `${baseUrl}/chat/completions`,
        { model: model.modelName, messages: [{ role: "user", content: prompt }] },
        { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } },
      )
      return { message: { content: res.data.choices[0].message.content } }
    }

    if (model.provider === "claude") {
      const key = getSecretByName(db, anthropicApiSecretKey)
      const baseUrl = model.baseUrl || "https://api.anthropic.com"
      const res = await axios.post(
        `${baseUrl}/v1/messages`,
        { model: model.modelName, max_tokens: 4096, messages: [{ role: "user", content: prompt }] },
        {
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
        },
      )
      return { message: { content: res.data.content[0].text } }
    }

        const response = await ollama.chat({
      model: model.modelName,
      messages: [{ role: "user", content: prompt }],
      keep_alive: model.closeAfterUse ? 0 : undefined,
    })
    return response
  } catch (err) {
    wrapRateLimitError(err, model)
  }
}

export async function downloadModel(modelName: string) {
  try {
    return await ollama.pull({ model: modelName, stream: true })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function removeOllamaModel(modelName: string): Promise<{ success: boolean; error?: string }> {
  try {
    await ollama.delete({ model: modelName })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
