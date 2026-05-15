
const CREDIT_TEXT = "Translated by BCookieSubs"
const CREDIT_DURATION_MS = 3000

function srtToMs(ts: string): number {
  const [hms, ms] = ts.split(",")
  const [h, m, s] = hms.split(":").map(Number)
  return h * 3600000 + m * 60000 + s * 1000 + Number(ms)
}

function msToSrt(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`
}

function parseFirstStartMs(srt: string): number | null {
  const match = srt.match(/\d+\r?\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->/)
  return match ? srtToMs(match[1]) : null
}

export function addCreditToSrt(srt: string): string {
  if (!srt.trim()) return srt

  const firstStartMs = parseFirstStartMs(srt)

    let creditEndMs = CREDIT_DURATION_MS
  if (firstStartMs !== null) {
    const safeEnd = firstStartMs - 100
    if (safeEnd <= 0) {
            return shiftSrtIds(srt)
    }
    creditEndMs = Math.min(CREDIT_DURATION_MS, safeEnd)
  }

  const creditBlock = `1\n${msToSrt(0)} --> ${msToSrt(creditEndMs)}\n${CREDIT_TEXT}\n`
  return creditBlock + "\n" + shiftSrtIds(srt)
}

function shiftSrtIds(srt: string): string {
    return srt.replace(/^(\d+)(\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->)/gm, (_, id, rest) => {
    return `${parseInt(id) + 1}${rest}`
  })
}
