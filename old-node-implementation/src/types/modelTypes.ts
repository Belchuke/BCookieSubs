import { DBModelRole, DBRole, DBUser } from "./dbTypes"
import { PermissionKey } from "../constants/permissions"

export type { PermissionKey }

export type DefaultResponse = {
  success: boolean
  msg: string | null
}

export type ValidateSessionResult = DefaultResponse & {
  user: DBUser | null
}

export type ParsedChunkRow = { id: string; text: string }
export type ParsedChunk = { rows: ParsedChunkRow[]; xml: string }

export type UserWithRoles = DBUser & {
  roles: DBRole[]
  highestRole: DBRole | null
  highestLevel: number
}

export type OllamaModel = {
  model: string
  size: number | null
  parameterSize: string | null
  modifiedAt: string | null
}

export type ModelWithRoles = {
  id: number
  name: string
  modelName: string
  size: string | null
  parameterSize: string | null
  modelUpdatedAt: string | null
  closeAfterUse: boolean
  roles: DBModelRole[]
  active: boolean
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ShouldRunResult = {
  shouldRun: boolean
  scheduleActive: boolean
  scheduleId: number | null
}

export type PromptsWithVersions = {
  id: number
  name: string
  active: boolean
  versions: {
    id: number
    version: number
    promptText: string
    active: boolean
    createdAt: string
  }[]
  type: "translation" | "judge" | "nameFormatter"
  createdAt: string
  updatedAt: string
}

export type NameFormatterResult = {
  name: string
  type: "series" | "movie"
  year: number | null
  season: number | null
  episode: number | null
  theMovieDbRequestResult?: TheMovieDBRequestResult[]
}

export type secretResponse = {
  secretName: string
  value: string | null
}

export type PromptStatListItem = {
  id: number
  promptName: string
  promptVersionId: number
  modelName: string
  languageName: string | null
  requestCount: number
  failedCount: number
  successCount: number
  selectedCount: number
  createdAt: string
  updatedAt: string
}

export type MovieDbResultFormat = {
  page: number
  total_pages: number
  total_results: number
  results: MovieDbResponse[]
}

export type MovieDbResponse = {
  id: number
  original_language: string | null
  original_name?: string
  original_title?: string
  poster_path: string | null
  release_date?: string
  first_air_date?: string
  title?: string
  name?: string
  video?: boolean
  genre_ids: number[]
}

export type TheMovieDBRequestResult = {
  id: number
  name: string | undefined
  originalTitle: string | undefined
  isAnime: boolean
  releaseDate: string | undefined
  posterBase64: string | null
  posterUrl: string
  genres: string | null
}

export type FinishedSubtitle = {
  subtitleId: number
  jobId: number
  subtitleName: string
  targetLang: string
  sourceLang: string
  season: number | null
  episode: number | null
  mediaItemPhotoPath: string | null
  year: number | null
  status: "completed" | "failed"
  finishedAt: string | null
  earliestChunkStartedAt: string | null
}

export type TmdbMovieDetails = {
  genres: TmdbGenre[]
  id: number
}

export type TmdbGenre = {
  id: number
  name: string
}
