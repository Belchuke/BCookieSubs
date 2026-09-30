using Microsoft.AspNetCore.Identity;

namespace BCookieSubs.Web.Security;

public class CustomIdentityErrorDescriber : IdentityErrorDescriber
{
    public override IdentityError DuplicateUserName(string userName) =>
        new() { Code = nameof(DuplicateUserName), Description = "Username already taken" };
}