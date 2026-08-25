import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyAssFontPolicy,
  isThaiLanguageCode,
  normalizeLanguageCode,
  resolveAssFontForLanguage,
} from "./subtitleFontPolicy"

const FIXTURE = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Roboto Medium,26,&H00FFFFFF
Style: Signs,Arial,20,&H00FFFFFF

[Events]
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,สวัสดีค่ะ
Dialogue: 0,0:00:03.00,0:00:05.00,Signs,,0,0,0,,{\\fnComic Sans MS\\pos(320,100)}ข้อความภาษาไทย
`

test("Thai language aliases normalize to 'th' case-insensitively", () => {
  for (const code of ["th", "TH", "tha", "THA", "th-TH", "th_TH", "Th-th"]) {
    assert.equal(normalizeLanguageCode(code), "th", `expected ${code} to normalize to th`)
    assert.equal(isThaiLanguageCode(code), true, `expected ${code} to be recognized as Thai`)
  }
})

test("non-Thai codes are not recognized as Thai", () => {
  for (const code of ["en", "EN-US", "de", "fr-FR", null, undefined, ""]) {
    assert.equal(isThaiLanguageCode(code as any), false)
  }
})

test("resolveAssFontForLanguage defaults Thai to Garuda", () => {
  assert.equal(resolveAssFontForLanguage("th"), "Garuda")
  assert.equal(resolveAssFontForLanguage("th-TH"), "Garuda")
})

test("resolveAssFontForLanguage respects a configured Thai font override", () => {
  assert.equal(resolveAssFontForLanguage("th", "TH Sarabun New"), "TH Sarabun New")
})

test("resolveAssFontForLanguage falls back to the default when the configured font is blank", () => {
  assert.equal(resolveAssFontForLanguage("th", "   "), "Garuda")
  assert.equal(resolveAssFontForLanguage("th", null), "Garuda")
})

test("resolveAssFontForLanguage returns null for every non-Thai language, even with a configured font", () => {
  assert.equal(resolveAssFontForLanguage("en", "SomeFont"), null)
  assert.equal(resolveAssFontForLanguage(null), null)
})

test("applyAssFontPolicy forces Garuda and fixes the title for Thai ASS output", () => {
  const result = applyAssFontPolicy(FIXTURE, "ass", "th", "Thai")
  assert.match(result, /Style: Default,Garuda,26,&H00FFFFFF/)
  assert.match(result, /Style: Signs,Garuda,20,&H00FFFFFF/)
  assert.match(result, /\{\\fnGaruda\\pos\(320,100\)\}/)
  assert.match(result, /Title: Thai/)
  assert.doesNotMatch(result, /Roboto Medium|Arial|Comic Sans MS/)
})

test("applyAssFontPolicy leaves non-Thai ASS output completely unchanged", () => {
  const result = applyAssFontPolicy(FIXTURE, "ass", "en", "English")
  assert.equal(result, FIXTURE)
})

test("applyAssFontPolicy is a no-op for SRT regardless of language", () => {
  const srt = "1\n00:00:01,000 --> 00:00:03,000\nHello\n"
  assert.equal(applyAssFontPolicy(srt, "srt", "th", "Thai"), srt)
})

test("applyAssFontPolicy also applies to genuine legacy ssa Thai output", () => {
  const result = applyAssFontPolicy(FIXTURE, "ssa", "tha", "Thai")
  assert.match(result, /Style: Default,Garuda,26,&H00FFFFFF/)
})

test("applyAssFontPolicy is idempotent", () => {
  const once = applyAssFontPolicy(FIXTURE, "ass", "th", "Thai")
  const twice = applyAssFontPolicy(once, "ass", "th", "Thai")
  assert.equal(twice, once)
})
