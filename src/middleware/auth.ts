import { Request, Response, NextFunction } from "express"
import { validateSession } from "../repositories/sessionRepository"
import { DBUser, DBConfig } from "../types/dbTypes"

declare module "express-serve-static-core" {
  interface Locals {
    user?: DBUser
    sessionToken?: string
    appConfig?: DBConfig
  }
}

export const loadSession = (req: Request, res: Response, next: NextFunction): void => {
  const db = req.app.locals.db
  const token = req.cookies?.st_session
  if (token) {
    const session = validateSession(db, token)
    if (session.success) {
      res.locals.user = session.user as DBUser
      res.locals.sessionToken = token
    } else {
      res.clearCookie("st_session")
    }
  }
    try {
    res.locals.appConfig = db.prepare(`SELECT * FROM config LIMIT 1`).get() as DBConfig | undefined
  } catch {
      }
  next()
}

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!res.locals.user) {
    const wantsJson =
      req.xhr ||
      (req.get("accept") || "").includes("application/json") ||
      req.path.endsWith("/poll")
    if (wantsJson) {
      res.status(401).json({ success: false, msg: "Session expired", redirect: "/login" })
      return
    }
    const next_ = encodeURIComponent(req.originalUrl)
    res.redirect(`/login?next=${next_}`)
    return
  }
  next()
}

export const requireNoAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (res.locals.user) {
    res.redirect("/dashboard")
    return
  }
  next()
}
