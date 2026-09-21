import { Router } from "express"
import multer from "multer"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import Database from "better-sqlite3"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"
import { getActiveTheme } from "../repositories/themeRepository"
import {
  getLibraryPaths,
  getLibraryPathById,
  getLibraryPathItemById,
  getLibraryPathsWithFilesystemPath,
  getLibraryMediaItemsForOffset,
} from "../repositories/libraryPathRepository"
import { applyOffsetToEntries, MAX_OFFSET_MS, msToSrtTime, parseSrt, serializeSrt, validateOffsetMs } from "../services/srtService"
import { addCreditToSrt } from "../services/subtitleExportService"
import { createLog } from "../repositories/logRepository"
import { getLanguages, getLanguageById, getLanguageByIso } from "../repositories/languageRepository"
import { CREDIT_TEXT } from "../constants/keys"
import { CREDIT_DURATION_MS } from "../constants/timer"

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

export function offsetRouter(db: Database.Database) {
  const router = Router()

  router.use(requireAuth, requirePermission("canViewOffsetPage"))

  // GET / - render the page
  router.get("/", (req, res) => {
    const user = res.locals.user!
    const libraryPaths = getLibraryPaths(db).filter((lp) => lp.enabled)
    const theme = getActiveTheme(db, user.id)
    const languages = getLanguages(db)

    res.render("offset", {
      user,
      activeNav: "offset",
      libraryPaths,
      languages,
      maxOffsetMs: MAX_OFFSET_MS,
      creditText: CREDIT_TEXT,
      creditDurationMs: CREDIT_DURATION_MS,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      theme,
    })
  })

  // POST /parse - parse an SRT file (uploaded) and return entries + suggested offset options
  router.post("/parse", requirePermission("canEditSubtitleOffsets"), upload.single("srt"), (req, res) => {
    try {
      let raw: string | null = null
      if (req.file) {
        raw = req.file.buffer.toString("utf-8")
      } else if (req.body && typeof req.body.content === "string") {
        raw = req.body.content
      }
      if (!raw) return res.json({ success: false, msg: "No SRT content provided" })

      const entries = parseSrt(raw)
      if (entries.length === 0) return res.json({ success: false, msg: "SRT contains no entries" })

      return res.json({ success: true, entries, count: entries.length })
    } catch (e) {
      return res.json({ success: false, msg: (e as Error).message || "Failed to parse SRT" })
    }
  })

  // POST /preview - apply offset to entries and return the result without persisting
  router.post("/preview", requirePermission("canEditSubtitleOffsets"), (req, res) => {
    try {
      const body = req.body as { entries?: any[]; offsetMs?: number; scope?: any }
      const offsetMs = validateOffsetMs(parseInt(String(body.offsetMs ?? "0")))
      const rawEntries = Array.isArray(body.entries) ? body.entries : []
      const entries = rawEntries.map((e) => ({
        id: String(e.id),
        startMs: parseInt(String(e.startMs)) || 0,
        endMs: parseInt(String(e.endMs)) || 0,
        startTime: String(e.startTime ?? ""),
        endTime: String(e.endTime ?? ""),
        text: String(e.text ?? ""),
      }))
      const scope = body.scope || { type: "all" }
      const result = applyOffsetToEntries(entries, offsetMs, scope)
      const newSrt = serializeSrt(result)
      return res.json({ success: true, entries: result, srt: newSrt, offsetMs })
    } catch (e) {
      return res.json({ success: false, msg: (e as Error).message || "Failed to apply offset" })
    }
  })

  // POST /parse-library - parse an SRT file from the local filesystem (server-side read)
  router.post("/parse-library", requirePermission("canEditSubtitleOffsets"), (req, res) => {
    try {
      const body = req.body as { path?: string; libraryPathId?: string | number }
      const filePath = body.path
      if (!filePath) return res.json({ success: false, msg: "No file path provided" })

      // Allow only .srt files
      if (!filePath.toLowerCase().endsWith(".srt")) {
        return res.json({ success: false, msg: "Only .srt files are supported" })
      }

      // Constrain to a configured library path
      const libraryPathId = body.libraryPathId ? parseInt(String(body.libraryPathId)) : null
      if (!libraryPathId) return res.json({ success: false, msg: "Missing libraryPathId" })
      const lp = getLibraryPathById(db, libraryPathId)
      if (!lp) return res.json({ success: false, msg: "Library path not found" })
      if (!lp.path) return res.json({ success: false, msg: "Library path has no filesystem path" })
      const root = path.resolve(lp.path)
      const target = path.resolve(filePath)
      if (!target.startsWith(root + path.sep) && target !== root) {
        return res.json({ success: false, msg: "File is outside the library path" })
      }

      if (!fs.existsSync(target)) return res.json({ success: false, msg: "File not found" })
      const raw = fs.readFileSync(target, "utf-8")
      const entries = parseSrt(raw)
      if (entries.length === 0) return res.json({ success: false, msg: "SRT contains no entries" })

      // Detect target language from filename suffix (e.g. "movie.da.srt" → "da")
      const baseName = path.basename(filePath).replace(/\.srt$/i, "")
      const parts = baseName.split(".")
      const lastPart = parts.length > 0 ? parts[parts.length - 1].toLowerCase() : ""
      const targetLangRow = lastPart ? getLanguageByIso(db, lastPart) : null
      const sourceLangRow = lp.sourceLangId ? getLanguageById(db, lp.sourceLangId) : null

      const toLang = (r: any) =>
        r ? { name: r.name, iso639: r.iso639, locale: r.locale } : null

      return res.json({
        success: true,
        entries,
        count: entries.length,
        sourceLang: toLang(sourceLangRow),
        targetLang: toLang(targetLangRow),
      })
    } catch (e) {
      return res.json({ success: false, msg: (e as Error).message || "Failed to parse SRT" })
    }
  })

  // GET /library-media/:lpId - list media items for a library path (deduplicated by mediaItem)
  router.get("/library-media/:lpId", (req, res) => {
    const lpId = parseInt(String(req.params.lpId))
    const lp = getLibraryPathById(db, lpId)
    if (!lp || !lp.path) return res.json({ items: [] })

    const rows = getLibraryMediaItemsForOffset(db, lpId)

    const seen = new Set<number>()
    const items: any[] = []
    for (const row of rows) {
      if (!seen.has(row.mediaItemId)) {
        seen.add(row.mediaItemId)
        items.push({
          lpiId: row.lpiId,
          mediaItemId: row.mediaItemId,
          title: row.title || "(Unknown)",
          type: row.type || "unknown",
          year: row.year ?? null,
          season: row.season ?? null,
          episode: row.episode ?? null,
        })
      }
    }
    return res.json({ items })
  })

  // GET /library-srt-files/:lpiId - list SRT files in the same directory as the library path item's video
  router.get("/library-srt-files/:lpiId", (req, res) => {
    const lpiId = parseInt(String(req.params.lpiId))
    const lpi = getLibraryPathItemById(db, lpiId)
    if (!lpi) return res.json({ files: [], libraryPathId: null })

    const lp = getLibraryPathById(db, lpi.libraryPathId)
    if (!lp || !lp.path) return res.json({ files: [], libraryPathId: lpi.libraryPathId })

    const root = path.resolve(lp.path)
    const videoDir = path.resolve(path.dirname(lpi.path))

    if (!videoDir.startsWith(root + path.sep) && videoDir !== root) {
      return res.json({ files: [], libraryPathId: lpi.libraryPathId })
    }

    const files: { name: string; path: string }[] = []
    try {
      const dirents = fs.readdirSync(videoDir, { withFileTypes: true })
      for (const d of dirents) {
        if (d.isFile() && d.name.toLowerCase().endsWith(".srt")) {
          files.push({ name: d.name, path: path.join(videoDir, d.name) })
        }
      }
      files.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      // unreadable directory — return empty
    }
    return res.json({ files, libraryPathId: lpi.libraryPathId })
  })

  // POST /save-to-library-path - save final entries to a file in the library
  router.post("/save-to-library-path", requirePermission("canEditSubtitleOffsets"), (req, res) => {
    try {
      const body = req.body as {
        targetPath?: string
        entries?: any[]
        addCredit?: boolean
      }

      const rawEntries = Array.isArray(body.entries) ? body.entries : []
      if (rawEntries.length === 0) return res.json({ success: false, msg: "No entries provided" })

      const entries = rawEntries.map((e) => ({
        id: String(e.id ?? ""),
        startMs: Math.max(0, parseInt(String(e.startMs)) || 0),
        endMs: Math.max(0, parseInt(String(e.endMs)) || 0),
        startTime: String(e.startTime ?? ""),
        endTime: String(e.endTime ?? ""),
        text: String(e.text ?? ""),
      }))

      // Ensure endMs > startMs
      for (const e of entries) {
        if (e.endMs <= e.startMs) e.endMs = e.startMs + 1
        if (!e.startTime) e.startTime = msToSrtTime(e.startMs)
        if (!e.endTime) e.endTime = msToSrtTime(e.endMs)
      }

      let srt = serializeSrt(entries)
      if (body.addCredit) srt = addCreditToSrt(srt)

      const targetPath = body.targetPath
      if (!targetPath) return res.json({ success: false, msg: "No target path" })

      const libraries = getLibraryPathsWithFilesystemPath(db)
      const root = libraries
        .map((l) => path.resolve(l.path))
        .find((r) => path.resolve(targetPath).startsWith(r + path.sep) || path.resolve(targetPath) === r)
      if (!root) return res.json({ success: false, msg: "Target is outside any library path" })

      fs.writeFileSync(targetPath, srt, "utf-8")
      const user = res.locals.user!
      createLog(db, "info", "offset", "offset", user.id, `Wrote edited subtitle to ${targetPath}`, { targetPath })
      return res.json({ success: true, msg: "Saved", fileName: path.basename(targetPath), path: targetPath })
    } catch (e) {
      return res.json({ success: false, msg: (e as Error).message || "Failed to save" })
    }
  })

  // POST /save - apply offset and download the result
  router.post("/save", requirePermission("canEditSubtitleOffsets"), (req, res) => {
    try {
      const body = req.body as { entries?: any[]; offsetMs?: number; scope?: any; fileName?: string; addCredit?: boolean }
      const offsetMs = validateOffsetMs(parseInt(String(body.offsetMs ?? "0")))
      const rawEntries = Array.isArray(body.entries) ? body.entries : []
      const entries = rawEntries.map((e) => ({
        id: String(e.id),
        startMs: parseInt(String(e.startMs)) || 0,
        endMs: parseInt(String(e.endMs)) || 0,
        startTime: String(e.startTime ?? ""),
        endTime: String(e.endTime ?? ""),
        text: String(e.text ?? ""),
      }))
      const scope = body.scope || { type: "all" }
      const result = applyOffsetToEntries(entries, offsetMs, scope)
      let srt = serializeSrt(result)
      if (body.addCredit) srt = addCreditToSrt(srt)

      const user = res.locals.user!
      createLog(db, "info", "offset", "offset", user.id, `Applied offset ${offsetMs}ms to ${result.length} entries`, {
        offsetMs,
        count: result.length,
        scope,
      })

      // Send as SRT file download
      const safeName = (body.fileName || "subtitle.srt").replace(/[/\\:*?"<>|]/g, "_")
      res.setHeader("Content-Type", "application/x-subrip; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`)
      return res.send(srt)
    } catch (e) {
      return res.json({ success: false, msg: (e as Error).message || "Failed to save offset" })
    }
  })

  return router
}
