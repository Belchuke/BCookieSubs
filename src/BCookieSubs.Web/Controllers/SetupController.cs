using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;
using BCookieSubs.Shared.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Memory;

namespace BCookieSubs.Web.Controllers;

public class SetupController(
    ISetupService setup,
    SignInManager<BCookieSubs.Shared.Database.Entities.ApplicationUser> signIn,
    ConfigService config,
    TranslationLanguageService translationLanguages,
    ModelService models,
    LanguageRepository languages,
    IMemoryCache cache) : Controller
{
    [HttpGet("/setup")]
    public async Task<IActionResult> Index() => await RedirectToStep1Async();

    [HttpGet("/setup/1")]
    [AllowAnonymous]
    public async Task<IActionResult> Step1()
    {
        if (await setup.HasAnyUsersAsync())
        {
            return RedirectToAction("Index", "Dashboard");
        }

        ViewData["SetupStep"] = 1;
        return View();
    }

    [HttpPost("/setup/1")]
    [AllowAnonymous]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step1(string userName, string email, string password, string confirmPassword)
    {
        if (await setup.HasAnyUsersAsync())
        {
            return RedirectToAction("Index", "Dashboard");
        }

        if (string.IsNullOrWhiteSpace(userName) || string.IsNullOrEmpty(password))
        {
            ModelState.AddModelError("", "Username and password are required");
            ViewData["SetupStep"] = 1;
            return View();
        }

        if (password != confirmPassword)
        {
            ModelState.AddModelError("", "Passwords do not match");
            ViewData["SetupStep"] = 1;
            return View();
        }

        if (password.Length < 8)
        {
            ModelState.AddModelError("", "Password must be at least 8 characters");
            ViewData["SetupStep"] = 1;
            return View();
        }

        try
        {
            var owner = await setup.CreateOwnerAsync(userName, email, password);
            cache.Remove("setup:has-users");
            await signIn.SignInAsync(owner, isPersistent: true);
            return Redirect("/setup/2");
        }
        catch (InvalidOperationException ex)
        {
            ModelState.AddModelError("", ex.Message);
            ViewData["SetupStep"] = 1;
            return View();
        }
    }

    [HttpGet("/setup/2")]
    [Authorize]
    public async Task<IActionResult> Step2() => await WithCompletedGateAsync(() =>
    {
        ViewData["SetupStep"] = 2;
        return Task.FromResult<IActionResult>(View());
    });

    [HttpPost("/setup/2/next")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step2Next() => await WithCompletedGateAsync(() =>
        Task.FromResult<IActionResult>(Redirect("/setup/3")));

    [HttpGet("/setup/3")]
    [Authorize]
    public async Task<IActionResult> Step3() => await WithCompletedGateAsync(async () =>
    {
        ViewData["SetupStep"] = 3;
        ViewBag.Languages = await languages.GetAllAsync();
        return View();
    });

    [HttpPost("/setup/3/next")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step3Next([FromForm] List<long> languageId) => await WithCompletedGateAsync(async () =>
    {
        var (ok, error) = await translationLanguages.ReplaceGlobalAsync(CurrentUserId(), languageId);
        if (!ok)
        {
            ViewData["SetupStep"] = 3;
            ViewBag.Languages = await languages.GetAllAsync();
            ModelState.AddModelError("", error ?? "Add at least one language before continuing");
            return View("Step3");
        }

        return Redirect("/setup/4");
    });

    [HttpGet("/setup/4")]
    [Authorize]
    public async Task<IActionResult> Step4() => await WithCompletedGateAsync(async () =>
    {
        ViewData["SetupStep"] = 4;
        var catalog = await models.GetOllamaCatalogAsync();
        ViewBag.OllamaNames = catalog.Success ? catalog.Entries.Select(e => e.Name).ToList() : [];
        ViewBag.OllamaError = catalog.Success ? null
            : catalog.OllamaRunning ? catalog.Error : "Ollama is not running.";
        ViewBag.Recommended = await models.GetUninstalledRecommendedAsync();
        ViewBag.Models = await models.GetListAsync();
        SetSetupAlerts();
        return View();
    });

    [HttpPost("/setup/4/install-recommended/{id:long}")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> InstallRecommended(long id) => await WithCompletedGateAsync(async () =>
    {
        var (ok, error, _) = await models.AddRecommendedAsync(CurrentUserId(), id);
        return Json(new { success = ok, msg = ok ? "Model added" : error ?? "Failed to add model" });
    });

    [HttpPost("/setup/4/add")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step4Add(SetupAddModelInput input) => await WithCompletedGateAsync(async () =>
    {
        var (ok, error) = await AddModelFromInputAsync(input);
        if (!ok)
        {
            return Redirect($"/setup/4?error={Uri.EscapeDataString(error ?? "Failed to add model")}");
        }

        return Redirect("/setup/4?toast=success&msg=" + Uri.EscapeDataString("Model added"));
    });

    [HttpPost("/setup/4/next")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step4Next() => await WithCompletedGateAsync(async () =>
    {
        var list = await models.GetListAsync();
        if (list.Count == 0)
        {
            return Redirect("/setup/4?error=" + Uri.EscapeDataString("Install at least one model before continuing"));
        }

        return Redirect("/setup/5");
    });

    [HttpGet("/setup/5")]
    [Authorize]
    public async Task<IActionResult> Step5() => await WithCompletedGateAsync(async () =>
    {
        ViewData["SetupStep"] = 5;
        var catalog = await models.GetOllamaCatalogAsync();
        ViewBag.OllamaModels = catalog.Success ? catalog.Entries : [];
        ViewBag.OllamaError = catalog.Success ? null
            : catalog.OllamaRunning ? catalog.Error : "Ollama is not running.";
        ViewBag.Models = await models.GetListAsync();
        SetSetupAlerts();
        return View();
    });

    [HttpPost("/setup/5/add")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step5Add(SetupAddModelInput input) => await WithCompletedGateAsync(async () =>
    {
        var (ok, error) = await AddModelFromInputAsync(input);
        if (!ok)
        {
            return Redirect($"/setup/5?error={Uri.EscapeDataString(error ?? "Failed to add model")}");
        }

        return Redirect("/setup/5?toast=success&msg=" + Uri.EscapeDataString("Model added"));
    });

    [HttpPost("/setup/5/role/{id:long}")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step5Role(long id, string? role, string? action) => await WithCompletedGateAsync(async () =>
    {
        if (!Enum.TryParse<ModelRoleKind>(role, ignoreCase: true, out var kind))
        {
            return Redirect("/setup/5?error=" + Uri.EscapeDataString("Invalid role"));
        }

        var model = await models.GetAsync(id);
        if (model is null)
        {
            return Redirect("/setup/5?error=" + Uri.EscapeDataString("Model not found"));
        }

        var current = model.ModelRoles.Select(r => r.Role).ToList();
        var updated = action == "add" && !current.Contains(kind)
            ? [.. current, kind]
            : action == "remove" ? current.Where(r => r != kind).ToList() : current;
        var (ok, error) = await models.SetRolesAsync(CurrentUserId(), id, updated);
        if (!ok)
        {
            return Redirect($"/setup/5?error={Uri.EscapeDataString(error ?? "Role update failed")}");
        }

        return Redirect("/setup/5?toast=success&msg=" + Uri.EscapeDataString("Role updated"));
    });

    [HttpPost("/setup/5/next")]
    [Authorize]
    [ValidateAntiForgeryToken]
    public async Task<IActionResult> Step5Next() => await WithCompletedGateAsync(async () =>
    {
        var list = await models.GetListAsync();
        if (list.Count == 0)
        {
            return Redirect("/setup/5?error=" + Uri.EscapeDataString("Add at least one model before continuing"));
        }

        var hasTranslation = list.Any(m => m.ModelRoles.Any(r => r.Role == ModelRoleKind.Translation));
        if (!hasTranslation)
        {
            return Redirect("/setup/5?error=" +
                Uri.EscapeDataString("Assign the Translation role to at least one model before continuing"));
        }

        var hasNameFormatter = list.Any(m => m.ModelRoles.Any(r => r.Role == ModelRoleKind.NameFormatter));
        await config.MarkSetupCompletedAsync(enableNameDetection: hasNameFormatter);
        return Redirect("/dashboard?toast=success&msg=" + Uri.EscapeDataString("Setup complete! Welcome."));
    });

    private void SetSetupAlerts()
    {
        ViewBag.Error = Request.Query["error"].FirstOrDefault();
        ViewBag.Toast = Request.Query["toast"].FirstOrDefault();
        ViewBag.Msg = Request.Query["msg"].FirstOrDefault();
    }

    private async Task<(bool Ok, string? Error)> AddModelFromInputAsync(SetupAddModelInput input)
    {
        if (string.IsNullOrWhiteSpace(input.ModelName))
        {
            return (false, "Model name is required");
        }

        var roles = (input.Roles ?? [])
            .Select(v => Enum.TryParse<ModelRoleKind>(v, ignoreCase: true, out var r) ? r : (ModelRoleKind?)null)
            .Where(r => r.HasValue).Select(r => r!.Value).Distinct().ToList();
        if (roles.Count == 0)
        {
            roles = [ModelRoleKind.Translation];
        }

        var provider = Enum.TryParse<ModelProvider>(input.Provider, ignoreCase: true, out var p)
            ? p : ModelProvider.Ollama;

        var (_, error, _) = await models.AddAsync(CurrentUserId(),
            (string.IsNullOrWhiteSpace(input.Name) ? input.ModelName : input.Name).Trim(),
            input.ModelName.Trim(), provider, input.BaseUrl?.Trim(), input.CloseAfterUse != "0", roles);
        return (error is null, error);
    }

    private async Task<IActionResult> WithCompletedGateAsync(Func<Task<IActionResult>> action)
    {
        var cfg = await config.GetAsync();
        if (cfg?.SetupCompleted == true)
        {
            return RedirectToAction("Index", "Dashboard");
        }

        if (!await setup.HasAnyUsersAsync())
        {
            return await RedirectToStep1Async();
        }

        return await action();
    }

    private async Task<IActionResult> RedirectToStep1Async()
    {
        if (await setup.HasAnyUsersAsync())
        {
            return User.Identity?.IsAuthenticated == true
                ? Redirect("/dashboard")
                : Redirect("/login");
        }

        return Redirect("/setup/1");
    }

    private long CurrentUserId() =>
        long.TryParse(User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value, out var id) ? id : 0;
}

public class SetupAddModelInput
{
    public string ModelName { get; set; } = "";
    public string? Name { get; set; }
    public string? Provider { get; set; }
    public string? BaseUrl { get; set; }
    public string? CloseAfterUse { get; set; }
    public List<string>? Roles { get; set; }
}