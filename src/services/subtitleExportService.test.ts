import assert from "node:assert/strict"
import { test } from "node:test"
import { finalizeSubtitleForOutput, subtitleExportExtension } from "./subtitleExportService"
import { detectSubtitleFormat } from "./subtitleFormatDetector"
import { getExportFileName } from "../repositories/subtitleRepository"

const FIXTURE = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Roboto Medium,26,&H00FFFFFF
Style: Signs,Arial,20,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,สวัสดีค่ะ
Dialogue: 0,0:00:03.00,0:00:05.00,Signs,,0,0,0,,{\\fnComic Sans MS\\pos(320,100)}ข้อความภาษาไทย
`

test("subtitleExportExtension maps every stored format to its correct extension", () => {
  assert.equal(subtitleExportExtension("ass"), ".ass")
  assert.equal(subtitleExportExtension("ssa"), ".ssa")
  assert.equal(subtitleExportExtension("srt"), ".srt")
})

test("getExportFileName (download/API filename) uses .ass for ass output", () => {
  const name = getExportFileName("Show", 1, 2, 2020, "th", "ass")
  assert.equal(name, "[BCookieSub]Show.S01E02.(2020).th.ass")
})

test("getExportFileName defaults to .ssa only for genuinely-detected legacy ssa", () => {
  const name = getExportFileName("Show", null, null, null, "en", "ssa")
  assert.equal(name, "[BCookieSub]Show.en.ssa")
})

test("end-to-end: a companion file named .ssa but containing v4.00+ content produces a .ass download/export path", () => {
  const detected = detectSubtitleFormat("Show.S01E01.ssa", FIXTURE)
  assert.equal(detected, "ass")
  assert.equal(subtitleExportExtension(detected), ".ass")
  assert.equal(getExportFileName("Show", 1, 1, null, "th", detected), "[BCookieSub]Show.S01E01.th.ass")
})

test("finalizeSubtitleForOutput credits and applies the Thai font policy together", () => {
  const result = finalizeSubtitleForOutput(FIXTURE, "ass", "th", "Thai", null)
  assert.match(result, /Translated by BCookieSubs/)
  assert.match(result, /Style: Default,Garuda,26,&H00FFFFFF/)
  assert.match(result, /\{\\fnGaruda\\pos\(320,100\)\}/)
  assert.match(result, /Title: Thai/)
})

test("finalizeSubtitleForOutput credits non-Thai output without touching its fonts", () => {
  const result = finalizeSubtitleForOutput(FIXTURE, "ass", "en", "English", null)
  assert.match(result, /Translated by BCookieSubs/)
  assert.match(result, /Roboto Medium/)
  assert.match(result, /Arial/)
  assert.doesNotMatch(result, /Garuda/)
})

test("finalizeSubtitleForOutput respects a configured Thai font override end-to-end", () => {
  const result = finalizeSubtitleForOutput(FIXTURE, "ass", "th", "Thai", "TH Sarabun New")
  assert.match(result, /Style: Default,TH Sarabun New,26,&H00FFFFFF/)
})
