import { Router } from "express"
import Database from "better-sqlite3"
import multer from "multer"
import { getActiveTheme } from "../repositories/themeRepository"
import {
  createUser,
  createRole,
  getRolesWithPermissions,
  updateRole,
  deleteRole,
  deleteUser,
  getUsers,
  updateUserPassword,
  updateUserRoles,
} from "../repositories/userRepository"
import { requireAuth } from "../middleware/auth"
import { requirePermission } from "../services/permissionService"
import { PERMISSIONS } from "../constants/permissions"

const upload = multer()

export function usersRouter(db: Database.Database) {
  const router = Router()

  router.get("/", requireAuth, requirePermission("canViewUsers"), (req, res) => {
    const user = res.locals.user!
    const { users, success, msg } = getUsers(db, user)
    const theme = getActiveTheme(db, user.id)
    const rolesWithPermissions = getRolesWithPermissions(db)
    const roles = rolesWithPermissions

    res.render("users", {
      user,
      activeNav: "users",
      users: success ? users : [],
      roles,
      rolesWithPermissions,
      permissions: PERMISSIONS,
      toast: req.query.toast ?? null,
      msg: req.query.msg ?? null,
      error: success ? null : msg,
      theme,
      supportedLocales: res.locals.supportedLocales,
      localeLabels: res.locals.localeLabels,
    })
  })

  router.post("/create", requireAuth, requirePermission("canAddUser"), upload.none(), (req, res) => {
    const { username, password, password2, roleId, language } = req.body as {
      username: string
      password: string
      password2: string
      roleId: string
      language: string
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

    const parsedRoleId = parseInt(roleId)
    if (isNaN(parsedRoleId)) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("A role must be selected"))
    }

    const parsedLanguage = language === "system" || !language ? null : language

    const result = createUser(db, res.locals.user!, username.trim(), password, parsedRoleId, parsedLanguage)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create user"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent(`User "${username}" created`))
  })

  router.post("/update-roles/:id", requireAuth, requirePermission("canManageRoles"), upload.none(), (req, res) => {
    const targetUserId = parseInt(String(req.params.id))
    const rawRoleIds = req.body.roleIds
    const roleIds: number[] = (Array.isArray(rawRoleIds) ? rawRoleIds : rawRoleIds ? [rawRoleIds] : [])
      .map((v: string) => parseInt(v))
      .filter((n: number) => !isNaN(n))

    const result = updateUserRoles(db, res.locals.user!, targetUserId, roleIds)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Update failed"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent("Roles updated"))
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

  router.post("/delete/:id", requireAuth, requirePermission("canAddUser"), (req, res) => {
    const result = deleteUser(db, res.locals.user!, parseInt(String(req.params.id)))
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Delete failed"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent("User deleted"))
  })

  router.post("/roles/create", requireAuth, requirePermission("canManageRoles"), upload.none(), (req, res) => {
    const { name, level, description } = req.body as { name: string; level: string; description: string }
    const rawKeys = req.body.permissionKeys
    const permissionKeys: string[] = Array.isArray(rawKeys) ? rawKeys : rawKeys ? [rawKeys] : []

    if (!name || !name.trim()) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Role name is required"))
    }
    const parsedLevel = parseInt(level)
    if (isNaN(parsedLevel) || parsedLevel < 1) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Level must be a number ≥ 1"))
    }

    const result = createRole(db, res.locals.user!, name.trim(), parsedLevel, description ?? "", permissionKeys)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to create role"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent(`Role "${name}" created`))
  })

  router.post("/roles/update/:id", requireAuth, requirePermission("canManageRoles"), upload.none(), (req, res) => {
    const roleId = parseInt(String(req.params.id))
    const { name, level, description } = req.body as { name: string; level: string; description: string }
    const rawKeys = req.body.permissionKeys
    const permissionKeys: string[] = Array.isArray(rawKeys) ? rawKeys : rawKeys ? [rawKeys] : []

    if (!name || !name.trim()) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Role name is required"))
    }
    const parsedLevel = parseInt(level)
    if (isNaN(parsedLevel) || parsedLevel < 1) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent("Level must be a number ≥ 1"))
    }

    const result = updateRole(db, res.locals.user!, roleId, name.trim(), parsedLevel, description ?? "", permissionKeys)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to update role"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent(`Role "${name}" updated`))
  })

  router.post("/roles/delete/:id", requireAuth, requirePermission("canManageRoles"), (req, res) => {
    const roleId = parseInt(String(req.params.id))
    const result = deleteRole(db, res.locals.user!, roleId)
    if (!result.success) {
      return res.redirect("/users?toast=error&msg=" + encodeURIComponent(result.msg ?? "Failed to delete role"))
    }
    res.redirect("/users?toast=success&msg=" + encodeURIComponent("Role deleted"))
  })

  return router
}
