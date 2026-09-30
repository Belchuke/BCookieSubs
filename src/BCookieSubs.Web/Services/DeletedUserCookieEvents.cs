using System.Security.Claims;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Identity;

namespace BCookieSubs.Web.Services;

public class DeletedUserCookieEvents(UserManager<ApplicationUser> users) : CookieAuthenticationEvents
{
    public override async Task ValidatePrincipal(CookieValidatePrincipalContext context)
    {
        if (context.Principal?.Identity?.IsAuthenticated == true)
        {
            var rawId = context.Principal.FindFirstValue(ClaimTypes.NameIdentifier);
            if (!long.TryParse(rawId, out var userId))
            {
                await RejectAsync(context);
            }
            else
            {
                var user = await users.FindByIdAsync(userId.ToString());
                if (user is null || user.DeletedAt is not null)
                {
                    await RejectAsync(context);
                }
            }
        }

        var stampValidator = context.HttpContext.RequestServices.GetRequiredService<ISecurityStampValidator>();
        await stampValidator.ValidateAsync(context);
    }

    private static async Task RejectAsync(CookieValidatePrincipalContext context)
    {
        context.RejectPrincipal();
        await context.HttpContext.SignOutAsync(IdentityConstants.ApplicationScheme);
    }
}