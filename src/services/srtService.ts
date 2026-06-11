import SrtParser2 from "srt-parser-2"

export type SrtEntry = {
  id: string
  startMs: number
  endMs: number
  startTime: string
  endTime: string
  text: string
}

export const MAX_OFFSET_MS = 300_000 // +/- 5 minutes

function srtTimeToMs(ts: string): number {
  const m = ts.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!m) return 0
  const h = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  const ms = parseInt(m[4].padEnd(3, "0"), 10)
  return h * 3600000 + mm * 60000 + s * 1000 + ms
}

export function msToSrtTime(ms: number): string {
  if (ms < 0) ms = 0
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const millis = ms % 1000
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`
}

export function parseSrt(raw: string): SrtEntry[] {
  if (!raw || !raw.trim()) return []
  const parser = new SrtParser2()
  const parsed = parser.fromSrt(raw)
  return parsed.map((p) => {
    const startMs = srtTimeToMs(p.startTime)
    const endMs = srtTimeToMs(p.endTime)
    return {
      id: String(p.id),
      startMs,
      endMs,
      startTime: msToSrtTime(startMs),
      endTime: msToSrtTime(endMs),
      text: p.text,
    }
  })
}

export function serializeSrt(entries: SrtEntry[]): string {
  const out: string[] = []
  entries.forEach((e, idx) => {
    out.push(String(idx + 1))
    out.push(`${msToSrtTime(e.startMs)} --> ${msToSrtTime(Math.max(e.endMs, e.startMs + 1))}`)
    out.push(e.text ?? "")
    out.push("")
  })
  return out.join("\n")
}

export function validateOffsetMs(offsetMs: number): number {
  if (!Number.isFinite(offsetMs)) return 0
  if (offsetMs > MAX_OFFSET_MS) return MAX_OFFSET_MS
  if (offsetMs < -MAX_OFFSET_MS) return -MAX_OFFSET_MS
  return Math.trunc(offsetMs)
}

export function applyOffsetToEntries(
  entries: SrtEntry[],
  offsetMs: number,
  scope: { type: "all" } | { type: "from"; startIndex: number } | { type: "range"; fromIndex: number; toIndex: number } | { type: "single"; index: number },
): SrtEntry[] {
  const delta = validateOffsetMs(offsetMs)
  if (delta === 0) return entries.map((e) => ({ ...e }))

  return entries.map((e, idx) => {
    let inScope = false
    if (scope.type === "all") inScope = true
    else if (scope.type === "from") inScope = idx >= scope.startIndex
    else if (scope.type === "single") inScope = idx === scope.index
    else if (scope.type === "range") inScope = idx >= scope.fromIndex && idx <= scope.toIndex

    if (!inScope) return { ...e }

    const startMs = e.startMs + delta
    const endMs = e.endMs + delta
    const safeStart = Math.max(0, startMs)
    const safeEnd = Math.max(safeStart + 1, endMs)
    return {
      ...e,
      startMs: safeStart,
      endMs: safeEnd,
      startTime: msToSrtTime(safeStart),
      endTime: msToSrtTime(safeEnd),
    }
  })
}

export type SubtitleSourceOption = {
  type: "embedded" | "external"
  label: string
  detail: string
  path: string
  isTemp: boolean
  language?: string | null
  codec?: string | null
  filename?: string | null
}

export function listCompanionSrtPaths(videoFilePath: string): string[] {
  const dir = videoFilePath.replace(/[\\/][^\\/]+$/, "")
  const stem = (videoFilePath.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "").toLowerCase()
  if (!dir || !stem) return []
  // Reading filesystem is done in service-layer helpers; this fallback returns []
  return []
}
