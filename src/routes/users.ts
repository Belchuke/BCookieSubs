import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import { getActiveTheme } from "../repositories/themeRepository"
import { createUser, deleteUser, getUsers, updateUserPassword, updateUserPermissions } from "../repositories/userRepository"
import { requireAuth } from "../middleware/auth"
import { UserPermissions, UserPermission } from "../types/modelTypes"

const upload = multer()

export function usersRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, (req, res) => {
    const user = res.locals.user!
    const { users, success, msg } = getUsers(db, user)
    const theme = getActiveTheme(db)

    res.render("users", {
      user,
      activeNav: "users",
      users: success ? users : [],
      permissionKeys: Object.keys(UserPermissions) as UserPermission[],
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      error: success ? null : msg,
      theme,
    })
  })

  
  router.post("/create", requireAuth, upload.none(), (req, res) => {
    const { username, password, password2, isAdmin } = req.body as {
      username: string
      password: string
      password2: string
      isAdmin?: string
    }

    if (!username || !password) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Username and password are required"))
    }
    if (password !== password2) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Passwords do not match"))
    }
    if (password.length < 8) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Password must be at least 8 characters"))
    }

    const giveAdmin = isAdmin === "1"
    const permissions: Partial<Record<UserPermission, boolean>> = {}

    if (!giveAdmin) {
      for (const key of Object.keys(UserPermissions) as UserPermission[]) {
        permissions[key] = req.body[key] === "1"
      }
    }

    const result = createUser(db, res.locals.user!, username.trim(), password, giveAdmin, permissions)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create user"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent(`User "${username}" created`))
  })

  
  router.post("/update/:id", requireAuth, upload.none(), (req, res) => {
    const userId = parseInt(String(req.params.id))
    const { isAdmin } = req.body as { isAdmin?: string }

    const giveAdmin = isAdmin === "1"
    const permissions: Partial<Record<UserPermission, boolean>> = {}

    if (!giveAdmin) {
      for (const key of Object.keys(UserPermissions) as UserPermission[]) {
        permissions[key] = req.body[key] === "1"
      }
    }

    const result = updateUserPermissions(db, res.locals.user!, userId, giveAdmin, permissions)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Update failed"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent("Permissions updated"))
  })

  
  router.post("/change-password/:id", requireAuth, upload.none(), (req, res) => {
    const userId = parseInt(String(req.params.id))
    const { password, password2 } = req.body as { password: string; password2: string }

    if (!password) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Password is required"))
    }
    if (password !== password2) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Passwords do not match"))
    }
    if (password.length < 8) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Password must be at least 8 characters"))
    }

    const result = updateUserPassword(db, res.locals.user!, userId, password)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to update password"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent("Password updated"))
  })

  
  router.post("/delete/:id", requireAuth, (req, res) => {
    const result = deleteUser(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Delete failed"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent("User deleted"))
  })

  return router
}
