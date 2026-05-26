import { Request, Response, NextFunction } from "express"
import { validateSession } from "../repositories/sessionRepository"
import { DBUser, DBConfig } from "../types/dbTypes"
import { getUserPermissions } from "../services/permissionService"
import { PermissionKey } from "../constants/permissions"
import { resolveLocale, translate, SUPPORTED_LOCALES, LOCALE_LABELS, LOCALE_FLAGS, SupportedLocale } from "../i18n"

declare module "express-serve-static-core" {
  interface Locals {
    user?: DBUser
    sessionToken?: string
    appConfig?: DBConfig
    userPermissions?: Set<string>
    can: (key: PermissionKey) => boolean
    __: (key: string) => string
    locale: SupportedLocale
    supportedLocales: typeof SUPPORTED_LOCALES
    localeLabels: typeof LOCALE_LABELS
    localeFlags: typeof LOCALE_FLAGS
  }
}

export const loadSession = (req: Request, res: Response, next: NextFunction): void => {
  const db = req.app.locals.db

  res.locals.can = () => false

  const token = req.cookies?.st_session
  if (token) {
    const session = validateSession(db, token)
    if (session.success) {
      res.locals.user = session.user as DBUser
      res.locals.sessionToken = token
      const perms = getUserPermissions(db, (session.user as DBUser).id)
      res.locals.userPermissions = perms
      res.locals.can = (key: PermissionKey) => perms.has(key)
    } else {
      res.clearCookie("st_session")
    }
  }

  try {
    res.locals.appConfig = db.prepare(`SELECT * FROM config LIMIT 1`).get() as DBConfig | undefined
  } catch {
  }

  const locale = resolveLocale(
    res.locals.user?.language,
    res.locals.appConfig?.defaultLanguage,
  )
  res.locals.locale = locale
  res.locals.__ = (key: string) => translate(locale, key)
  res.locals.supportedLocales = SUPPORTED_LOCALES
  res.locals.localeLabels = LOCALE_LABELS
  res.locals.localeFlags = LOCALE_FLAGS

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

export const requireNoAuth = (_req: Request, res: Response, next: NextFunction): void => {
  if (res.locals.user) {
    res.redirect("/dashboard")
    return
  }
  next()
}
