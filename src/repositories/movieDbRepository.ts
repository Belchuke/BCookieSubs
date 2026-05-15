import Database from "better-sqlite3"
import { DBUser, DBSecret } from "../types/dbTypes"
import { DefaultResponse, MovieDbResultFormat, TheMovieDBRequestResult } from "../types/modelTypes"
import { ollamaApiSecretKey, theMovieDBSecretKey, openAIApiSecretKey, anthropicApiSecretKey } from "../setup"
import { encryptKey, decryptKey } from "./shared"
import { createLog } from "./logRepository"
import { userHasPermission } from "./userRepository"
import { getConfig } from "./configRepository"

export const getTheMovieDbGenres: { id: number; name: string }[] = [
  { id: 28, name: "Action" },
  { id: 12, name: "Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 14, name: "Fantasy" },
  { id: 36, name: "History" },
  { id: 27, name: "Horror" },
  { id: 10402, name: "Music" },
  { id: 9648, name: "Mystery" },
  { id: 10749, name: "Romance" },
  { id: 878, name: "Science Fiction" },
  { id: 10770, name: "TV Movie" },
  { id: 53, name: "Thriller" },
  { id: 10752, name: "War" },
  { id: 37, name: "Western" },
  {
    id: 10759,
    name: "Action & Adventure",
  },
  {
    id: 10762,
    name: "Kids",
  },
  {
    id: 10763,
    name: "News",
  },
  {
    id: 10764,
    name: "Reality",
  },
  {
    id: 10765,
    name: "Sci-Fi & Fantasy",
  },
  {
    id: 10766,
    name: "Soap",
  },
  {
    id: 10767,
    name: "Talk",
  },
  {
    id: 10768,
    name: "War & Politics",
  },
]

export const isAdmin = (original_language: string, genreIds: number[]) => {
  return genreIds.some((id) => [16].includes(id)) && ["ja", "zh", "ko"].includes(original_language)
}

export const requestSearchTheMovieDb = async (
  query: string,
  type: "movie" | "series",
  year: number | null,
  apiKey: string,
): Promise<{ items: TheMovieDBRequestResult[]; success: boolean; msg: string | null }> => {
  try {
    let url = `https://api.themoviedb.org/3/search/${type === "movie" ? "movie" : "tv"}?api_key=${apiKey}&query=${encodeURIComponent(query)}`
    if (year) {
      url += `&year=${year}`
    }
    url += "&append_to_response=overview"

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`The Movie DB API error: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as MovieDbResultFormat

    const results = await Promise.all(
      data.results.map(async (item) => {
        let posterBase64: string | null = null
        let posterUrl: string = "https://image.tmdb.org/t/p/w600_and_h900_face/" + item.poster_path

        try {
          const posterResponse = await fetch(posterUrl)
          if (posterResponse.ok) {
            const buffer = await posterResponse.arrayBuffer()
            posterBase64 = `data:${posterResponse.headers.get("content-type")};base64,${Buffer.from(buffer).toString("base64")}`
          }
        } catch (error) {
                  }

        const genres = getTheMovieDbGenres
          .filter((g) => item.genre_ids.includes(g.id))
          .map((g) => g.name)
          .join(", ")

        return {
          id: item.id,
          name: type === "movie" ? item.title : item.name,
          originalTitle: type === "movie" ? item.original_title : item.original_name,
          releaseDate: type === "movie" ? item.release_date : item.first_air_date,
          posterBase64,
          posterUrl,
          genres,
          isAnime: isAdmin(item.original_language as string, item.genre_ids),
        } as TheMovieDBRequestResult
      }),
    )
    return { items: results, success: true, msg: null }
  } catch (error) {
    if (error instanceof Error) {
      return { items: [], success: false, msg: error.message }
    }
    return { items: [], success: false, msg: "An unknown error occurred" }
  }
}

export const searchMediaItemInTheMovieDb = async (
  db: Database.Database,
  name: string,
  type: "movie" | "series",
  year: number | null,
) => {
  const config = getConfig(db)
  if (!config.theMovieDbActive) return { items: [], success: false, msg: "The Movie DB API key not configured" }

  const secret = db.prepare(`SELECT * FROM secret WHERE secretName = ?`).get(theMovieDBSecretKey) as
    | DBSecret
    | undefined

  if (!secret) return { items: [], success: false, msg: "The Movie DB API key not configured" }

  try {
    const decryptedKey = decryptKey(secret.encryptedValue, secret.iv, secret.authTag)

    return await requestSearchTheMovieDb(name, type, year, decryptedKey)
  } catch (error) {
    if (error instanceof Error) {
      return { items: [], success: false, msg: error.message }
    }

    return {
      items: [],
      success: false,
      msg: "An unknown error occurred",
    }
  }
}

export const setOrUpdateSecret = (
  db: Database.Database,
  user: DBUser,
  secretName: string,
  secretValue: string,
  deleteKey: boolean,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageConfig")
  if (!perm) return { success: false, msg: "User does not have permission to manage config" }

  if (secretName !== theMovieDBSecretKey && secretName !== ollamaApiSecretKey) {
    return { success: false, msg: "Invalid secret name" }
  }

  const secretExist = db.prepare(`SELECT * FROM secret WHERE secretName = ?`).get(secretName) as DBSecret | undefined

  if (deleteKey) {
    if (secretExist) {
      db.prepare(`DELETE FROM secret WHERE secretName = ?`).run(secretName)
      createLog(db, "info", "config", null, `Deleted ${secretName}`, {})
      return { success: true, msg: `${secretName} deleted successfully` }
    } else {
      return { success: false, msg: `${secretName} does not exist` }
    }
  }

  const encrypted = encryptKey(secretValue)

  if (secretExist) {
    db.prepare(
      `UPDATE secret SET encryptedValue = ?, iv = ?, authTag = ?, setByEnv = 0, updatedAt = datetime('now') WHERE secretName = ?`,
    ).run(encrypted.encryptedValue, encrypted.iv, encrypted.authTag, secretName)
    createLog(db, "info", "config", null, `Updated ${secretName}`, {})
    return { success: true, msg: `${secretName} updated successfully` }
  }
  db.prepare(
    `INSERT INTO secret (secretName, encryptedValue, iv, authTag, algorithm, setByEnv) VALUES (?, ?, ?, ?, 'aes-256-gcm', 0)`,
  ).run(secretName, encrypted.encryptedValue, encrypted.iv, encrypted.authTag)
  createLog(db, "info", "config", null, `Set ${secretName}`, {})
  return { success: true, msg: `${secretName} set successfully` }
}

const ENV_SECRET_MAP: [string, string][] = [
  ["THEMOVIEDB_API_KEY", theMovieDBSecretKey],
  ["OLLAMA_API_KEY", ollamaApiSecretKey],
  ["OPENAI_API_KEY", openAIApiSecretKey],
  ["ANTHROPIC_API_KEY", anthropicApiSecretKey],
]

export const syncSecretsFromEnv = (db: Database.Database): void => {
  for (const [envKey, secretName] of ENV_SECRET_MAP) {
    const envValue = process.env[envKey]
    if (!envValue) continue

    const existing = db.prepare(`SELECT * FROM secret WHERE secretName = ?`).get(secretName) as DBSecret | undefined

    if (!existing) {
            const enc = encryptKey(envValue)
      db.prepare(
        `INSERT INTO secret (secretName, encryptedValue, iv, authTag, algorithm, setByEnv) VALUES (?, ?, ?, ?, 'aes-256-gcm', 1)`,
      ).run(secretName, enc.encryptedValue, enc.iv, enc.authTag)
      console.log(`[secrets] Created ${secretName} from env`)
      continue
    }

    if (!existing.setByEnv) {
            console.log(`[secrets] Skipped ${secretName} (user-managed)`)
      continue
    }

        try {
      const current = decryptKey(existing.encryptedValue, existing.iv, existing.authTag)
      if (current === envValue) continue
    } catch {
          }

    const enc = encryptKey(envValue)
    db.prepare(
      `UPDATE secret SET encryptedValue = ?, iv = ?, authTag = ?, setByEnv = 1, updatedAt = datetime('now') WHERE secretName = ?`,
    ).run(enc.encryptedValue, enc.iv, enc.authTag, secretName)
    console.log(`[secrets] Updated ${secretName} from env`)
  }
}
