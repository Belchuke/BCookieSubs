using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using BCookieSubs.Web.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace BCookieSubs.Web.Controllers;

public class AddModelInput
{
    [Required] public string ModelName { get; set; } = "";
    public string? Name { get; set; }
    public string? CloseAfterUse { get; set; }
    public string? Active { get; set; }
    public string Provider { get; set; } = "ollama";
    public string? BaseUrl { get; set; }
    public List<string> Roles { get; set; } = [];
}

public class UpdateModelInput
{
    [Required] public string Name { get; set; } = "";
    public string? CloseAfterUse { get; set; }
    public string? Active { get; set; }
    public string Provider { get; set; } = "ollama";
    public string? BaseUrl { get; set; }
}

public class SyncModelInput
{
    [Required] public string ModelName { get; set; } = "";
    public string? Name { get; set; }
    public string? CloseAfterUse { get; set; }
    public string? Active { get; set; }
    public List<string> Roles { get; set; } = [];
    public string? RecommendedModelId { get; set; }
}

public class RemoveOllamaInput
{
    public string? ModelName { get; set; }
}

// Route shapes, messages, and checkbox semantics are fixed by the models page JS.
[Authorize(Policy = "Perm:" + Permissions.CanViewModelsPage)]
[Route("[controller]")]
public class ModelsController(
    ModelService models,
    OllamaService ollama,
    AuditService audit,
    CurrentUserContext currentUser) : Controller
{
    public async Task<IActionResult> Index()
    {
        await currentUser.EnsureLoadedAsync();
        ViewBag.CanAdd = currentUser.HasPermission(Permissions.CanAddOrInstallAModel);
        ViewBag.CanEdit = currentUser.HasPermission(Permissions.CanEditModels);
        ViewBag.CanManageRoles = currentUser.HasPermission(Permissions.CanManageModelRoles);
        ViewBag.CanDelete = currentUser.HasPermission(Permissions.CanRemoveAndDeleteModels);
        ViewBag.Models = await models.GetListAsync();
        ViewBag.Ollama = await models.GetOllamaCatalogAsync();
        ViewBag.Recommended = await models.GetUninstalledRecommendedAsync();
        ViewBag.ToastError = Request.Query["toast"] == "error" ? Request.Query["msg"].FirstOrDefault() : null;
        return View();
    }

    [HttpPost("add")]
    [Authorize(Policy = "Perm:" + Permissions.CanAddOrInstallAModel)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Add(AddModelInput input)
    {
        if (!ModelState.IsValid)
        {
            return ToastError("Model name is required");
        }

        await currentUser.EnsureLoadedAsync();
        var (_, error, _) = await models.AddAsync(currentUser.Id,
            (string.IsNullOrWhiteSpace(input.Name) ? input.ModelName : input.Name).Trim(),
            input.ModelName.Trim(), ParseProvider(input.Provider), input.BaseUrl?.Trim(),
            input.CloseAfterUse != "0", ParseRoles(input.Roles),
            active: input.Active != "0");
        if (error is not null)
        {
            return ToastError(error);
        }

        return ToastSuccess("Model added");
    }

    [HttpPost("sync")]
    [Authorize(Policy = "Perm:" + Permissions.CanAddOrInstallAModel)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Sync(SyncModelInput input)
    {
        if (!ModelState.IsValid)
        {
            return ToastError("Model name is required");
        }

        var catalog = await models.GetOllamaCatalogAsync();
        var entry = catalog.Entries.FirstOrDefault(m => m.Name == input.ModelName);
        if (entry is null)
        {
            return ToastError($"Model \"{input.ModelName}\" not found in Ollama");
        }

        await currentUser.EnsureLoadedAsync();
        long? recommendedModelId = long.TryParse(input.RecommendedModelId, out var recId) ? recId : null;
        var (_, error, _) = await models.AddAsync(currentUser.Id,
            (string.IsNullOrWhiteSpace(input.Name) ? input.ModelName : input.Name).Trim(),
            input.ModelName.Trim(), ModelProvider.Ollama, null, input.CloseAfterUse != "0",
            ParseRoles(input.Roles.Count > 0 ? input.Roles : ["translation"]),
            size: entry.Size, parameterSize: entry.ParameterSize, modelUpdatedAt: entry.ModifiedAt,
            recommendedModelId: recommendedModelId, active: input.Active != "0");
        if (error is not null)
        {
            return ToastError(error);
        }

        return ToastSuccess("Model synced from Ollama");
    }

    [HttpPost("update/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanEditModels)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Update(long id, UpdateModelInput input)
    {
        if (!ModelState.IsValid)
        {
            return ToastError("Model name is required");
        }

        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await models.UpdateAsync(currentUser.Id, id, input.Name.Trim(),
            input.CloseAfterUse == "1", input.Active != "0", ParseProvider(input.Provider), input.BaseUrl?.Trim());
        if (!ok)
        {
            return ToastError(error ?? "Update failed");
        }

        return ToastSuccess("Model updated");
    }

    [HttpPost("role/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanManageModelRoles)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Role(long id, string? role, string? action)
    {
        if (!Enum.TryParse<ModelRoleKind>(role, ignoreCase: true, out var kind))
        {
            return ToastError("Invalid role");
        }

        await currentUser.EnsureLoadedAsync();
        var model = await models.GetAsync(id);
        if (model is null)
        {
            return ToastError("Model not found");
        }

        var current = model.ModelRoles.Select(r => r.Role).ToList();
        var updated = action == "add" && !current.Contains(kind)
            ? [.. current, kind]
            : action == "remove" ? current.Where(r => r != kind).ToList() : current;
        var (ok, error) = await models.SetRolesAsync(currentUser.Id, id, updated);
        if (!ok)
        {
            return ToastError(error ?? "Role update failed");
        }

        return ToastSuccess("Role updated");
    }

    [HttpPost("delete/{id:long}")]
    [Authorize(Policy = "Perm:" + Permissions.CanRemoveAndDeleteModels)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Delete(long id)
    {
        await currentUser.EnsureLoadedAsync();
        var (ok, error) = await models.SoftDeleteAsync(currentUser.Id, id);
        if (!ok)
        {
            return ToastError(error ?? "Delete failed");
        }

        return ToastSuccess("Model removed");
    }

    [HttpPost("remove-ollama")]
    [Authorize(Policy = "Perm:" + Permissions.CanRemoveAndDeleteModels)]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> RemoveOllama(RemoveOllamaInput input)
    {
        if (string.IsNullOrEmpty(input.ModelName))
        {
            return ToastError("Model name required");
        }

        var result = await ollama.RemoveModelAsync(input.ModelName);
        if (!result.Success)
        {
            return ToastError(result.Error ?? "Failed to remove from Ollama");
        }

        await audit.AdminActionAsync("modelDelete", "model", null,
            $"Removed {input.ModelName} from Ollama");
        return ToastSuccess($"Removed {input.ModelName} from Ollama");
    }

    [HttpGet("pull-stream/{**modelName}")]
    [Authorize(Policy = "Perm:" + Permissions.CanAddOrInstallAModel)]
    public async Task PullStream(string modelName)
    {
        Response.Headers.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        async Task Send(object data) =>
            await Response.WriteAsync($"data: {JsonSerializer.Serialize(data)}\n\n");

        try
        {
            await foreach (var chunk in ollama.PullAsync(Uri.UnescapeDataString(modelName)))
            {
                await Send(new { status = chunk.Status ?? "", completed = chunk.Completed,
                    total = chunk.Total, digest = chunk.Digest });
                if (chunk.Status == "success")
                {
                    break;
                }
            }

            await Send(new { done = true });
        }
        catch (Exception ex)
        {
            await Send(new { error = ex.Message });
        }
    }

    private IActionResult ToastError(string message) =>
        Redirect($"/models?toast=error&msg={Uri.EscapeDataString(message)}");

    private IActionResult ToastSuccess(string message) =>
        Redirect($"/models?toast=success&msg={Uri.EscapeDataString(message)}");

    private static ModelProvider ParseProvider(string value) =>
        Enum.TryParse<ModelProvider>(value, ignoreCase: true, out var parsed) ? parsed : ModelProvider.Ollama;

    private static List<ModelRoleKind> ParseRoles(List<string> values) =>
        values.Select(v => Enum.TryParse<ModelRoleKind>(v, ignoreCase: true, out var r) ? r : (ModelRoleKind?)null)
            .Where(r => r.HasValue)
            .Select(r => r!.Value)
            .Distinct()
            .ToList();
}