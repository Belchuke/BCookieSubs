import { Router } from "express"
import Database from "better-sqlite3"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"
import { getConfig } from "../repositories/configRepository"
import { getLibraryPaths, getLibraryPathItemsWithDetails } from "../repositories/libraryPathRepository"
import { getUserConfigTranslationLanguages } from "../repositories/languageRepository"
import { getActiveTheme } from "../repositories/themeRepository"

type RequestGroupItem = {
  itemId: number
  season: number | null
  episode: number | null
  fileName: string
  libraryPathName: string
  libraryPathId: number
}

type RequestGroup = {
  key: string
  title: string
  year: number | null
  genres: string | null
  posterPath: string | null
  type: "movie" | "series"
  items: RequestGroupItem[]
}

export function libraryRequestsRouter(db: Database.Database) {
  const router = Router()

  router.use(requireAuth, requirePermission("canAddSubtitleToTranslateFromLibrary"))

  router.get("/", (req, res) => {
    const user = res.locals.user!
    const libraryPaths = getLibraryPaths(db).filter((lp) => lp.enabled)
    const userTargetLangs = getUserConfigTranslationLanguages(db, user.id)
    const userTargetLangIds = userTargetLangs.map((tl) => tl.languageId)
    const theme = getActiveTheme(db, user.id)
    const config = getConfig(db)
    const showPosters = !!config.showPosters && user.showPosters !== 0

    const groupsMap = new Map<string, RequestGroup>()

    function addItemToGroup(
      lpType: "movie" | "series",
      mediaItem: any | null,
      item: any,
    ) {
      const key = mediaItem?.id ? String(mediaItem.id) : `unmatched-${item.id}`
      const existing = groupsMap.get(key)
      const groupItem: RequestGroupItem = {
        itemId: item.id,
        season: item.season,
        episode: item.episode,
        fileName: item.path.split("/").pop() ?? "",
        libraryPathName: lpType === "movie" ? "" : "",
        libraryPathId: item.libraryPathId ?? 0,
      }
      if (existing) {
        existing.items.push(groupItem)
        existing.items.sort((a, b) => {
          if (a.season != null && b.season != null) {
            if (a.season !== b.season) return a.season - b.season
            return (a.episode ?? 0) - (b.episode ?? 0)
          }
          return a.fileName.localeCompare(b.fileName)
        })
        return
      }
      groupsMap.set(key, {
        key,
        title: mediaItem?.title ?? item.path.split("/").pop() ?? "Untitled",
        year: mediaItem?.year ?? null,
        genres: mediaItem?.genres ?? null,
        posterPath: mediaItem?.mediaItemPhotoPath ?? null,
        type: lpType,
        items: [groupItem],
      })
    }

    for (const lp of libraryPaths) {
      const items = getLibraryPathItemsWithDetails(db, lp.id)
      for (const item of items) {
        if (item.blacklist) continue
        if (item.status === "not_started") {
          addItemToGroup(lp.type, item.mediaItem, item)
          continue
        }

        if (item.subtitleInfo && !item.subtitleInfo.deleted) {
          const jobRows = db
            .prepare(
              `SELECT sj.targetLangId, sj.status
               FROM subtitle s
               JOIN subtitleJob sj ON sj.subtitleId = s.id AND sj.deletedAt IS NULL
               WHERE s.libraryPathItem = ? AND s.deletedAt IS NULL`,
            )
            .all(item.id) as { targetLangId: number; status: string }[]

          const completedLangIds = new Set(
            jobRows.filter((r) => r.status === "completed").map((r) => r.targetLangId),
          )

          const hasMissing = userTargetLangIds.length === 0 || userTargetLangIds.some((id) => !completedLangIds.has(id))
          if (hasMissing) {
            addItemToGroup(lp.type, item.mediaItem, item)
          }
        }
      }
    }

    const allGroups = Array.from(groupsMap.values())
    allGroups.sort((a, b) => a.title.localeCompare(b.title))

    const allGenres: string[] = []
    for (const group of allGroups) {
      if (group.genres) {
        group.genres.split(",").forEach((g) => {
          const trimmed = g.trim()
          if (trimmed && allGenres.indexOf(trimmed) === -1) allGenres.push(trimmed)
        })
      }
    }
    allGenres.sort()

    const movieGroups = allGroups.filter((g) => g.type === "movie")
    const seriesGroups = allGroups.filter((g) => g.type === "series")

    res.render("libraryrequests", {
      user,
      activeNav: "library-requests",
      movieGroups,
      seriesGroups,
      allGenres,
      showPosters,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  return router
}
