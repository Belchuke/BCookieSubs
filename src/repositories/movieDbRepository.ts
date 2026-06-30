import Database from "better-sqlite3"
import { DBUser, DBSecret } from "../types/dbTypes"
import { DefaultResponse, MovieDbResultFormat, TheMovieDBRequestResult } from "../types/modelTypes"
import { ollamaApiSecretKey, theMovieDBSecretKey, openAIApiSecretKey, anthropicApiSecretKey } from "../constants/keys"
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

// TMDB rate-limit backoff. When any request returns 429 we wait 1 minute (or
// the server's Retry-After, clamped to 5 min) and retry the same request once.
// The gate also makes concurrent requests wait out the window before firing, so
// a burst of scan-time lookups doesn't hammer the API while it's limiting us.
let tmdbRateLimitedUntil = 0

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function fetchTheMovieDb(db: Database.Database | null, url: string): Promise<Response> {
  const now = Date.now()
  if (tmdbRateLimitedUntil > now) await sleepMs(tmdbRateLimitedUntil - now)
  let response = await fetch(url)
  if (response.status === 429) {
    const retryAfterRaw = response.headers.get("retry-after")
    const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN
    const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 300 ? retryAfter : 60
    tmdbRateLimitedUntil = Date.now() + waitSeconds * 1000
    if (db) {
      createLog(db, "warning", "tmdbRateLimit", "tmdb", null, `TMDB returned 429; waiting ${waitSeconds}s before retrying`, {
        url: url.slice(0, 200),
      })
    }
    await sleepMs(waitSeconds * 1000)
    response = await fetch(url) // one retry
  }
  return response
}

export const requestSearchTheMovieDb = async (
  query: string,
  type: "movie" | "series",
  year: number | null,
  apiKey: string,
  db: Database.Database | null = null,
): Promise<{ items: TheMovieDBRequestResult[]; success: boolean; msg: string | null }> => {
  try {
    let url = `https://api.themoviedb.org/3/search/${type === "movie" ? "movie" : "tv"}?api_key=${apiKey}&query=${encodeURIComponent(query)}`
    if (year) {
      url += `&year=${year}`
    }

    const response = await fetchTheMovieDb(db, url)
    if (!response.ok) {
      throw new Error(`The Movie DB API error: ${response.status} ${response.statusText}`)
    }

    const data = (await response.json()) as MovieDbResultFormat

    const results = data.results.map((item) => {
      const posterUrl: string = item.poster_path
        ? "https://image.tmdb.org/t/p/w600_and_h900_face/" + item.poster_path
        : ""

      const genres = getTheMovieDbGenres
        .filter((g) => item.genre_ids.includes(g.id))
        .map((g) => g.name)
        .join(", ")

      return {
        id: item.id,
        name: type === "movie" ? item.title : item.name,
        originalTitle: type === "movie" ? item.original_title : item.original_name,
        releaseDate: type === "movie" ? item.release_date : item.first_air_date,
        posterBase64: null,
        posterUrl,
        genres,
        isAnime: isAdmin(item.original_language as string, item.genre_ids),
      } as TheMovieDBRequestResult
    })
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

    return await requestSearchTheMovieDb(name, type, year, decryptedKey, db)
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

export const fetchTheMovieDbDetailsById = async (
  db: Database.Database,
  tmdbId: number,
  type: "movie" | "series",
): Promise<TheMovieDBRequestResult | null> => {
  const config = getConfig(db)
  if (!config.theMovieDbActive) return null

  const secret = db.prepare(`SELECT * FROM secret WHERE secretName = ?`).get(theMovieDBSecretKey) as
    | DBSecret
    | undefined
  if (!secret) return null

  try {
    const apiKey = decryptKey(secret.encryptedValue, secret.iv, secret.authTag)
    const endpoint = type === "movie" ? "movie" : "tv"
    const url = `https://api.themoviedb.org/3/${endpoint}/${tmdbId}?api_key=${apiKey}`

    const response = await fetchTheMovieDb(db, url)
    if (!response.ok) return null

    const item = (await response.json()) as any

    const posterUrl: string = item.poster_path
      ? "https://image.tmdb.org/t/p/w600_and_h900_face/" + item.poster_path
      : ""
    const genreList: { id: number; name: string }[] = item.genres ?? []
    const genres = genreList.map((g) => g.name).join(", ")
    const genreIds = genreList.map((g) => g.id)

    return {
      id: item.id,
      name: type === "movie" ? item.title : item.name,
      originalTitle: type === "movie" ? item.original_title : item.original_name,
      releaseDate: type === "movie" ? item.release_date : item.first_air_date,
      posterBase64: null,
      posterUrl,
      genres,
      isAnime: isAdmin(item.original_language as string, genreIds),
    } as TheMovieDBRequestResult
  } catch {
    return null
  }
}

export const setOrUpdateSecret = (
  db: Database.Database,
  user: DBUser,
  secretName: string,
  secretValue: string,
  deleteKey: boolean,
): DefaultResponse => {
  const { hasPermission: perm } = userHasPermission(db, user.id, "canManageSecrets")
  if (!perm) return { success: false, msg: "User does not have permission to manage config" }

  if (secretName !== theMovieDBSecretKey && secretName !== ollamaApiSecretKey) {
    return { success: false, msg: "Invalid secret name" }
  }

  const secretExist = db.prepare(`SELECT * FROM secret WHERE secretName = ?`).get(secretName) as DBSecret | undefined

  if (deleteKey) {
    if (secretExist) {
      db.prepare(`DELETE FROM secret WHERE secretName = ?`).run(secretName)
      createLog(db, "info", "configUpdate", "config", null, `Deleted ${secretName}`, {})
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
    createLog(db, "info", "configUpdate", "config", null, `Updated ${secretName}`, {})
    return { success: true, msg: `${secretName} updated successfully` }
  }
  db.prepare(
    `INSERT INTO secret (secretName, encryptedValue, iv, authTag, algorithm, setByEnv) VALUES (?, ?, ?, ?, 'aes-256-gcm', 0)`,
  ).run(secretName, encrypted.encryptedValue, encrypted.iv, encrypted.authTag)
  createLog(db, "info", "configUpdate", "config", null, `Set ${secretName}`, {})
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
    } catch {}

    const enc = encryptKey(envValue)
    db.prepare(
      `UPDATE secret SET encryptedValue = ?, iv = ?, authTag = ?, setByEnv = 1, updatedAt = datetime('now') WHERE secretName = ?`,
    ).run(enc.encryptedValue, enc.iv, enc.authTag, secretName)
    console.log(`[secrets] Updated ${secretName} from env`)
  }
}
