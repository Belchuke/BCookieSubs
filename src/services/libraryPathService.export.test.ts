// Integration test for exportSubtitleToLibraryFolder: a fresh in-memory DB
// (via setup.ts's own createTables, triggered by getDb()) plus a real temp
// directory on disk. process.env.DBPATH must be set to ":memory:" before
// setup.ts is first required (its `dbName` is read once at module load), so
// this file uses require() in document order instead of static imports for
// anything that touches the DB.
process.env.DBPATH = ":memory:"

import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const { getDb } = require("../setup") as typeof import("../setup")
const { getLanguageByIso } = require("../repositories/languageRepository") as typeof import("../repositories/languageRepository")
const { exportSubtitleToLibraryFolder } = require("./libraryPathService") as typeof import("./libraryPathService")

const ORIGINAL_EN_ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Roboto Medium,26,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there
`

const TRANSLATED_TH_ASS = `[Script Info]
Title: English (US)
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Roboto Medium,26,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\fnComic Sans MS}สวัสดีค่ะ
`

test("exportSubtitleToLibraryFolder writes .ass, applies the Thai font policy only to Thai output, records the .ass path, and never overwrites an existing export", async () => {
  const db = getDb()

  const enLang = getLanguageByIso(db, "en")
  const thLang = getLanguageByIso(db, "th")
  assert.ok(enLang, "expected a seeded English language row")
  assert.ok(thLang, "expected a seeded Thai language row")

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bcookiesubs-test-"))
  const videoPath = path.join(tmpDir, "Show - S01E01.mkv")

  const userId = Number(db.prepare(`INSERT INTO user (username, passwordHash) VALUES ('tester', 'x')`).run().lastInsertRowid)
  const libraryPathId = Number(
    db
      .prepare(`INSERT INTO libraryPath (name, path, autoExtract, sourceLangId, type) VALUES ('test-lib', ?, 1, ?, 'series')`)
      .run(tmpDir, enLang.id).lastInsertRowid,
  )
  const itemId = Number(
    db
      .prepare(`INSERT INTO libraryPathItem (libraryPathId, path, extractFileName) VALUES (?, ?, '')`)
      .run(libraryPathId, videoPath).lastInsertRowid,
  )
  const subtitleId = Number(
    db
      .prepare(
        `INSERT INTO subtitle (userId, sourceLangId, libraryPathItem, name, originalFileHash, originalTextSRTName, originalText, sourceFormat, source)
         VALUES (?, ?, ?, 'Show', 'hash', 'orig.ass', ?, 'ass', 'library')`,
      )
      .run(userId, enLang.id, itemId, ORIGINAL_EN_ASS).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO subtitleJob (subtitleId, userId, targetLangId, status, translatedText) VALUES (?, ?, ?, 'completed', ?)`,
  ).run(subtitleId, userId, thLang.id, TRANSLATED_TH_ASS)

  const subtitle = db.prepare(`SELECT * FROM subtitle WHERE id = ?`).get(subtitleId) as any

  await exportSubtitleToLibraryFolder(db, subtitle, { includeOriginal: true, includeTranslated: true, markCompleted: true })

  const enPath = path.join(tmpDir, "Show - S01E01.en.ass")
  const thPath = path.join(tmpDir, "Show - S01E01.th.ass")
  assert.ok(fs.existsSync(enPath), "expected the .ass (not .ssa) original export to exist")
  assert.ok(fs.existsSync(thPath), "expected the .ass (not .ssa) translated export to exist")

  const enContent = fs.readFileSync(enPath, "utf-8")
  assert.match(enContent, /Roboto Medium/, "non-Thai export must keep its original font")
  assert.doesNotMatch(enContent, /Garuda/)

  const thContent = fs.readFileSync(thPath, "utf-8")
  assert.match(thContent, /Style: Default,Garuda,26,&H00FFFFFF/)
  assert.match(thContent, /\{\\fnGaruda\}/)
  assert.match(thContent, /Title: Thai/)
  assert.doesNotMatch(thContent, /English \(US\)|Comic Sans MS/)
  assert.match(thContent, /สวัสดีค่ะ/, "Thai UTF-8 text must survive the rewrite")

  const item = db.prepare(`SELECT extractFileName FROM libraryPathItem WHERE id = ?`).get(itemId) as { extractFileName: string }
  assert.match(item.extractFileName, /\.ass$/, "the recorded output path must be .ass, not .ssa")

  // Tamper with the already-exported Thai file, then export again: the
  // project's existing safety convention is "never overwrite an existing
  // export", which this change must not weaken.
  fs.writeFileSync(thPath, "SENTINEL-DO-NOT-OVERWRITE", "utf-8")
  await exportSubtitleToLibraryFolder(db, subtitle, { includeOriginal: true, includeTranslated: true, markCompleted: true })
  assert.equal(fs.readFileSync(thPath, "utf-8"), "SENTINEL-DO-NOT-OVERWRITE")

  fs.rmSync(tmpDir, { recursive: true, force: true })
})
