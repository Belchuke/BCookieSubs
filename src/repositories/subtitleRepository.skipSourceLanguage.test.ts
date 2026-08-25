// Verifies that every subtitle job-creation entry point drops a requested
// target language that matches the subtitle's source language, instead of
// queuing a pointless self-to-self translation. Uses a fresh in-memory DB (see
// libraryPathService.export.test.ts for why process.env.DBPATH must be set
// before setup.ts is first required, and why require() is used in document
// order instead of static imports here).
process.env.DBPATH = ":memory:"

import assert from "node:assert/strict"
import { test } from "node:test"

const { getDb } = require("../setup") as typeof import("../setup")
const { getLanguageByIso } = require("../repositories/languageRepository") as typeof import("../repositories/languageRepository")
const {
  createSubtitleTask,
  addMissingTargetLanguageJobs,
  createPlaceholderTranslationJobs,
  getSubtitleJobsBySubtitleId,
} = require("./subtitleRepository") as typeof import("./subtitleRepository")

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello there
`

function grantOwnerRole(db: any, userId: number): void {
  db.prepare(
    `INSERT INTO userRole (userId, roleId) SELECT ?, id FROM role WHERE name = 'Owner'`,
  ).run(userId)
}

function makeUser(db: any, username: string): any {
  const userId = Number(
    db.prepare(`INSERT INTO user (username, passwordHash) VALUES (?, 'x')`).run(username).lastInsertRowid,
  )
  grantOwnerRole(db, userId)
  return db.prepare(`SELECT * FROM user WHERE id = ?`).get(userId)
}

test("createSubtitleTask never creates a job for a target language equal to the source language", () => {
  const db = getDb()
  const user = makeUser(db, "task-user")
  const en = getLanguageByIso(db, "en")!
  const th = getLanguageByIso(db, "th")!

  const result = createSubtitleTask(db, user, null, en.id, [en.id, th.id], SRT, 10, null, null, "show.srt")
  assert.equal(result.success, true)

  const subtitle = db.prepare(`SELECT id FROM subtitle ORDER BY id DESC LIMIT 1`).get() as { id: number }
  const jobs = getSubtitleJobsBySubtitleId(db, subtitle.id)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].targetLangId, th.id)
})

test("addMissingTargetLanguageJobs skips the source language among the requested additions", () => {
  const db = getDb()
  const user = makeUser(db, "missing-lang-user")
  const en = getLanguageByIso(db, "en")!
  const th = getLanguageByIso(db, "th")!
  const de = getLanguageByIso(db, "de")!

  const created = createSubtitleTask(db, user, null, en.id, [th.id], SRT, 10, null, null, "show2.srt")
  assert.equal(created.success, true)
  const subtitle = db.prepare(`SELECT id FROM subtitle ORDER BY id DESC LIMIT 1`).get() as { id: number }

  const result = addMissingTargetLanguageJobs(db, user, subtitle.id, [en.id, de.id])
  assert.equal(result.success, true)

  const jobs = getSubtitleJobsBySubtitleId(db, subtitle.id)
  const targetLangIds = jobs.map((j) => j.targetLangId).sort((a, b) => a - b)
  assert.deepEqual(targetLangIds, [th.id, de.id].sort((a, b) => a - b))
})

test("createPlaceholderTranslationJobs (Whisper workflow) skips the source language", () => {
  const db = getDb()
  const user = makeUser(db, "whisper-user")
  const en = getLanguageByIso(db, "en")!
  const th = getLanguageByIso(db, "th")!

  const subtitleId = Number(
    db
      .prepare(
        `INSERT INTO subtitle (userId, sourceLangId, name, originalFileHash, originalTextSRTName, originalText, sourceFormat, source)
         VALUES (?, ?, 'Show', 'hash-whisper', 'orig.srt', ?, 'srt', 'whisper')`,
      )
      .run(user.id, en.id, SRT).lastInsertRowid,
  )

  const result = createPlaceholderTranslationJobs(db, user, subtitleId, [en.id, th.id], null, null)
  assert.equal(result.success, true)

  const jobs = getSubtitleJobsBySubtitleId(db, subtitleId)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].targetLangId, th.id)
})
