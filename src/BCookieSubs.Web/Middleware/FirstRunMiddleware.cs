using BCookieSubs.Shared.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;

namespace BCookieSubs.Web.Middleware;

public class FirstRunMiddleware(RequestDelegate next)
{
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(10);
    private const string CacheKey = "setup:has-users";

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;

        if (path.StartsWithSegments("/setup") || path.StartsWithSegments("/account") ||
            path.StartsWithSegments("/healthz") || path.StartsWithSegments("/health"))
        {
            await next(context);
            return;
        }

        var cache = context.RequestServices.GetRequiredService<IMemoryCache>();
        var setup = context.RequestServices.GetRequiredService<ISetupService>();

        var hasUsers = await cache.GetOrCreateAsync(CacheKey, async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = CacheTtl;
            return await setup.HasAnyUsersAsync();
        });

        if (!hasUsers)
        {
            context.Response.Redirect("/setup/1");
            return;
        }

        if (path == "/" || path == "")
        {
            context.Response.Redirect("/dashboard");
            return;
        }

        await next(context);
    }
}