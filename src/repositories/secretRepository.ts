import Database from "better-sqlite3"
import { DBUser, DBSecret } from "../types/dbTypes"
import { DefaultResponse, secretResponse } from "../types/modelTypes"
import { ollamaApiSecretKey, theMovieDBSecretKey, openAIApiSecretKey, anthropicApiSecretKey } from "../constants/keys"
import { decryptKey } from "./shared"
import { userHasPermission } from "./userRepository"

export const getSecretByName = (db: Database.Database, secretName: string): string | null => {
  const s = db.prepare(`SELECT * FROM secret WHERE secretName = ?`).get(secretName) as DBSecret | undefined
  if (!s) return null

  try {
    return decryptKey(s.encryptedValue, s.iv, s.authTag)
  } catch (error) {
    console.error(`Failed to decrypt secret ${secretName}: ${error}`)
    return null
  }
}

export const getSecrets = (
  db: Database.Database,
  user: DBUser,
): { secrets: secretResponse[] | null } & DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSecrets")
  if (!perm) return { success: false, msg: "Permission denied", secrets: null }

  const secrets = db.prepare(`SELECT * FROM secret`).all() as DBSecret[]
  const decryptedSecrets = secrets.map((s) => {
    try {
      const decryptedValue = decryptKey(s.encryptedValue, s.iv, s.authTag)
      return { secretName: s.secretName, value: decryptedValue }
    } catch (error) {
      console.error(`Failed to decrypt secret ${s.secretName}: ${error}`)
      return { secretName: s.secretName, value: null }
    }
  })
  return { success: true, msg: null, secrets: decryptedSecrets }
}

export const getListOfSecretsToAdd = () => {
  return [
    {
      secretName: theMovieDBSecretKey,
      displayName: "The Movie DB API Key",
      description: "API key for The Movie DB integration (used for automatic media item name detection and more)",
    },
    {
      secretName: ollamaApiSecretKey,
      displayName: "Ollama API Key",
      description: "API key for Ollama for using cloud-hosted models (if not using local Ollama)",
    },
    {
      secretName: openAIApiSecretKey,
      displayName: "OpenAI API Key",
      description: "API key for OpenAI (ChatGPT) models",
    },
    {
      secretName: anthropicApiSecretKey,
      displayName: "Anthropic API Key",
      description: "API key for Anthropic (Claude) models",
    },
  ]
}
