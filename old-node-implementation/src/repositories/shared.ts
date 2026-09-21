import * as crypto from "crypto"
import { ParsedChunk, ParsedChunkRow } from "../types/modelTypes"

export const hashToken = (token: string): string => {
  return crypto.createHash("sha256").update(token).digest("hex")
}

const getKey = (): Buffer => {
  const secret = process.env.AES_KEY
  if (!secret) {
    throw new Error("AES_KEY is missing")
  }

  return crypto.createHash("sha256").update(secret).digest()
}
export const encryptKey = (plainText: string): { encryptedValue: string; iv: string; authTag: string } => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv)

  let encrypted = cipher.update(plainText, "utf8", "base64")
  encrypted += cipher.final("base64")

  const authTag = cipher.getAuthTag()

  return {
    encryptedValue: encrypted,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  }
}
export const decryptKey = (encryptedValue: string, iv: string, authTag: string): string => {
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"))

  decipher.setAuthTag(Buffer.from(authTag, "base64"))

  let decrypted = decipher.update(encryptedValue, "base64", "utf8")
  decrypted += decipher.final("utf8")

  return decrypted
}

export const stripMarkdownFences = (input: string): string => {
  return input
    .replace(/^`{3}[a-zA-Z0-9_-]*\s*\n/, "")
    .replace(/\n```$/, "")
    .replace(/^`{3}[\r\n]?/, "")
    .replace(/```$/, "")
    .trim()
}
export const escapeAttribute = (value: string): string => {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}
export const parseLLMResponse = (response: string): ParsedChunk | null => {
  const cleaned = stripMarkdownFences(response).trim()

  if (!cleaned.startsWith("<trcnk>") || !cleaned.endsWith("</trcnk>")) {
    return null
  }

  const outsideTagsRemoved = cleaned.replace(/^<trcnk>\s*/, "").replace(/\s*<\/trcnk>$/, "")

  const blockRegex = /<txtcnk id="([^"]+)">([\s\S]*?)<\/txtcnk>/g
  const rows: ParsedChunkRow[] = []

  let match: RegExpExecArray | null
  let reconstructed = ""

  while ((match = blockRegex.exec(outsideTagsRemoved)) !== null) {
    reconstructed += match[0]
    rows.push({
      id: match[1],
      text: match[2].replaceAll("<breakcnk>", "\n"),
    })
  }

  if (rows.length === 0) return null

  const normalizedOriginal = outsideTagsRemoved.replace(/\s+/g, "")
  const normalizedReconstructed = reconstructed.replace(/\s+/g, "")
  if (normalizedOriginal !== normalizedReconstructed) {
    return null
  }

  return { rows, xml: cleaned }
}
export const validateChunkIntegrity = (
  originalRows: { id: string; text: string }[],
  parsedRows: { id: string; text: string }[],
): boolean => {
  if (originalRows.length !== parsedRows.length) return false

  const seen = new Set<string>()

  for (let i = 0; i < originalRows.length; i++) {
    const original = originalRows[i]
    const parsed = parsedRows[i]

    if (parsed.id !== original.id) return false
    if (seen.has(parsed.id)) return false
    seen.add(parsed.id)

    if (!parsed.text || !parsed.text.trim()) return false
  }

  for (let i = 0; i < originalRows.length; i++) {
    const originalBreaks = (originalRows[i].text.match(/\n/g) || []).length
    const parsedBreaks = (parsedRows[i].text.match(/\n/g) || []).length

    if (Math.abs(originalBreaks - parsedBreaks) > 2) return false
  }

  return true
}
export const srtFormatterForModel = (chunk: { id: string; text: string }[]): string => {
  const lines = ["<trcnk>"]
  for (const row of chunk) {
    if (!row?.id) continue
    const normalizedText = String(row.text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
      .replaceAll("\n", "<breakcnk>")
    lines.push(`<txtcnk id="${escapeAttribute(row.id)}">${normalizedText}</txtcnk>`)
  }
  lines.push("</trcnk>")
  return lines.join("\n")
}

export const getFileHash = (content: string): string => {
  return crypto.createHash("sha256").update(content).digest("hex")
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
