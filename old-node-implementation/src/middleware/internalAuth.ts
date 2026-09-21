import { Request, Response, NextFunction } from "express"
import * as crypto from "crypto"

const HEADER = "x-internal-token"

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export const requireInternalToken = (req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env.INTERNAL_API_TOKEN?.trim()
  if (!expected) {
            res.status(503).json({ error: "INTERNAL_API_TOKEN is not configured on this server" })
    return
  }

  const provided = req.header(HEADER)
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    res.status(401).json({ error: "Invalid or missing internal token" })
    return
  }

  next()
}
