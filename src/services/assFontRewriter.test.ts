import assert from "node:assert/strict"
import { test } from "node:test"
import { rewriteAssFontnames, rewriteAssInlineFontOverrides, setAssScriptInfoTitle } from "./assFontRewriter"

// Representative fixture, matching the reported bug: modern v4.00+ content
// (mislabeled or not), Latin-only style fonts, and an inline \fn override on a
// signs event, with real Thai dialogue text.
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

function fullRewrite(content: string, font: string): string {
  return rewriteAssInlineFontOverrides(rewriteAssFontnames(content, font), font)
}

test("rewriteAssFontnames sets every Style's Fontname and preserves every other field", () => {
  const result = rewriteAssFontnames(FIXTURE, "Garuda")
  assert.match(result, /Style: Default,Garuda,26,&H00FFFFFF/)
  assert.match(result, /Style: Signs,Garuda,20,&H00FFFFFF/)
  assert.doesNotMatch(result, /Roboto Medium|Arial/)
  // Fontsize and PrimaryColour survive untouched.
  assert.match(result, /,26,&H00FFFFFF/)
  assert.match(result, /,20,&H00FFFFFF/)
})

test("rewriteAssFontnames is idempotent", () => {
  const once = rewriteAssFontnames(FIXTURE, "Garuda")
  const twice = rewriteAssFontnames(once, "Garuda")
  assert.equal(twice, once)
})

test("rewriteAssInlineFontOverrides replaces \\fn inside override blocks only", () => {
  const result = rewriteAssInlineFontOverrides(FIXTURE, "Garuda")
  assert.match(result, /\{\\fnGaruda\\pos\(320,100\)\}/)
  assert.doesNotMatch(result, /Comic Sans MS/)
  // Ordinary dialogue text (including the line with no override block at all)
  // is untouched.
  assert.match(result, /,,สวัสดีค่ะ\n/)
  assert.match(result, /ข้อความภาษาไทย/)
})

test("rewriteAssInlineFontOverrides is idempotent", () => {
  const once = rewriteAssInlineFontOverrides(FIXTURE, "Garuda")
  const twice = rewriteAssInlineFontOverrides(once, "Garuda")
  assert.equal(twice, once)
})

test("setAssScriptInfoTitle inserts a Title line when none exists", () => {
  const result = setAssScriptInfoTitle(FIXTURE, "Thai")
  assert.match(result, /\[Script Info\]\r?\nTitle: Thai\r?\nScriptType: v4\.00\+/)
})

test("setAssScriptInfoTitle replaces an existing stale Title line", () => {
  const withTitle = FIXTURE.replace("[Script Info]\n", "[Script Info]\nTitle: English (US)\n")
  const result = setAssScriptInfoTitle(withTitle, "Thai")
  assert.match(result, /Title: Thai/)
  assert.doesNotMatch(result, /English \(US\)/)
})

test("setAssScriptInfoTitle is idempotent", () => {
  const once = setAssScriptInfoTitle(FIXTURE, "Thai")
  const twice = setAssScriptInfoTitle(once, "Thai")
  assert.equal(twice, once)
})

test("full font rewrite preserves timing and colours, keeps Thai UTF-8 text intact, and leaves no source-font references", () => {
  const result = fullRewrite(FIXTURE, "Garuda")
  assert.match(result, /0:00:01\.00,0:00:03\.00/)
  assert.match(result, /0:00:03\.00,0:00:05\.00/)
  assert.match(result, /&H00FFFFFF/)
  assert.match(result, /สวัสดีค่ะ/)
  assert.match(result, /ข้อความภาษาไทย/)
  assert.doesNotMatch(result, /Roboto Medium|Arial|Comic Sans MS|Times New Roman|Arial Black|Noto Sans Thai/)
})

test("full font rewrite is idempotent end-to-end", () => {
  const once = fullRewrite(FIXTURE, "Garuda")
  const twice = fullRewrite(once, "Garuda")
  assert.equal(twice, once)
})
