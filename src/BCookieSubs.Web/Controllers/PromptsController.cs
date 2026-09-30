using System.Text.Json;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

public record PromptPageItem(long Id, string Name, PromptKind Kind, bool Active, List<PromptVersionItem> Versions);

public class CreatePromptInput
{
    public string? Name { get; set; }
    public string? PromptText { get; set; }
}

public class AddVersionInput
{
    public string? PromptText { get; set; }
}

public class PromptToggleInput
{
    public string? Active { get; set; }
}

[Authorize(Policy = "Perm:" + Permissions.CanViewPromptsPage)]
[Route("[controller]")]
public class PromptsController(PromptService prompts, CurrentUserContext currentUser) : Controller
{
    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        ViewBag.CanManage = currentUser.HasPermission(Permissions.CanManagePrompts);

        var entities = await prompts.GetListAsync();
        var items = new List<PromptPageItem>();
        foreach (var p in entities)
        {
            items.Add(new PromptPageItem(p.Id, p.Name, p.Kind, p.Active,
                await prompts.GetVersionsAsync(p.Id)));
        }

        ViewBag.Prompts = items
            .OrderBy(i => KindText(i.Kind))
            .ThenBy(i => i.Name)
            .ToList();
        ViewBag.ToastError = Request.Query["toast"] == "error" ? Request.Query["msg"].FirstOrDefault() : null;
        return View();
    }

    [HttpPost("create")]
    [Authorize(Policy = "Perm:" + Permissions.CanManagePrompts)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Create(CreatePromptInput input)
    {
        if (string.IsNullOrWhiteSpace(input.Name) || string.IsNullOrWhiteSpace(input.PromptText))
        {
            return ToastError("Name and prompt text are required");
        }

        await currentUser.EnsureLoadedAsync();
        var (ok, error, _) = await prompts.CreateAsync(currentUser.Id, input.Name, input.PromptText);
        if (!ok)
        {
            return ToastError(error ?? "Failed to create prompt");
        }

        return ToastSuccess("Prompt created");
    }

    [HttpPost("add-version/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManagePrompts)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> AddVersion(long id, AddVersionInput input)
    {
        if (string.IsNullOrWhiteSpace(input.PromptText))
        {
            return ToastError("Prompt text is required");
        }

        await currentUser.EnsureLoadedAsync();
        var (ok, error, _) = await prompts.AddVersionAsync(currentUser.Id, id, input.PromptText, null);
        if (!ok)
        {
            return ToastError(error ?? "Failed to add version");
        }

        return ToastSuccess("Prompt version added");
    }

    [HttpPost("set-version/{promptId:long}/{versionId:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManagePrompts)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> SetVersion(long promptId, long versionId)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await prompts.SetActiveVersionAsync(currentUser.Id, promptId, versionId);
        if (!ok)
        {
            return ToastError(error ?? "Failed to set version");
        }

        return ToastSuccess("Active version updated");
    }

    [HttpPost("toggle/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManagePrompts)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Toggle(long id, PromptToggleInput input)
    {
        var target = input.Active == "1";
        var current = (await prompts.GetListAsync()).FirstOrDefault(p => p.Id == id);
        if (current is null)
        {
            return ToastError("Prompt not found");
        }

        await currentUser.EnsureLoadedAsync();
        if (current.Active != target)
        {
            var (ok, error) = await prompts.ToggleActiveAsync(currentUser.Id, id);
            if (!ok)
            {
                return ToastError(error ?? "Failed to toggle prompt");
            }
        }

        return ToastSuccess("Prompt updated");
    }

    private IActionResult ToastError(string message) =>
        Redirect($"/prompts?toast=error&msg={Uri.EscapeDataString(message)}");

    private IActionResult ToastSuccess(string message) =>
        Redirect($"/prompts?toast=success&msg={Uri.EscapeDataString(message)}");

    private static string KindText(PromptKind k) =>
        JsonNamingPolicy.CamelCase.ConvertName(k.ToString());
}