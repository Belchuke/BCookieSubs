import assert from "node:assert/strict"
import { test } from "node:test"
import { detectSubtitleFormat, isSubtitleExtension, subtitleExtensionOf } from "./subtitleFormatDetector"

const MODERN_ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour
Style: Default,Roboto Medium,26,&H00FFFFFF

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello
`

const LEGACY_SSA = `[Script Info]
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,26,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,0,0,1,2,2,2,10,10,10,0,0

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello
`

test("a .ssa file that actually contains v4.00+ content is detected as ass", () => {
  assert.equal(detectSubtitleFormat("movie.ssa", MODERN_ASS), "ass")
})

test("an unknown extension with v4.00+ content is detected as ass", () => {
  assert.equal(detectSubtitleFormat("movie.txt", MODERN_ASS), "ass")
})

test("a .ass file with genuine legacy v4.00/[V4 Styles] content is detected as ssa", () => {
  assert.equal(detectSubtitleFormat("movie.ass", LEGACY_SSA), "ssa")
})

test("a .ssa file with genuine legacy content stays ssa", () => {
  assert.equal(detectSubtitleFormat("movie.ssa", LEGACY_SSA), "ssa")
})

test("content sniffing never reclassifies a real .srt file", () => {
  assert.equal(detectSubtitleFormat("movie.srt", MODERN_ASS), "srt")
})

test("extension is the fallback when content carries no ASS/SSA marker", () => {
  assert.equal(detectSubtitleFormat("movie.ass"), "ass")
  assert.equal(detectSubtitleFormat("movie.ssa"), "ssa")
  assert.equal(detectSubtitleFormat("movie.ass", "just some text"), "ass")
})

test(".ass and .ssa are both discoverable as subtitle files, case-insensitively", () => {
  assert.equal(isSubtitleExtension("Show.S01E01.ASS"), true)
  assert.equal(isSubtitleExtension("Show.S01E01.ssa"), true)
  assert.equal(subtitleExtensionOf("Show.S01E01.ASS"), ".ass")
  assert.equal(subtitleExtensionOf("Show.S01E01.SSA"), ".ssa")
})
