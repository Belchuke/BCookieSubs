using System.Security.Cryptography;
using System.Text;

namespace BCookieSubs.Shared.Security;

public static class TokenGenerator
{
    public const string EnrollmentPrefix = "bcsen_";
    public const string SecretPrefix = "bcsk_";

    public static string NewEnrollmentToken() => EnrollmentPrefix + NewToken();

    public static string NewWorkerSecret() => SecretPrefix + NewToken();

    public static string Sha256Hex(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public static bool FixedTimeEquals(string left, string right)
    {
        var a = Encoding.UTF8.GetBytes(left);
        var b = Encoding.UTF8.GetBytes(right);
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    public static string PrefixForDisplay(string token) => token.Length <= 12 ? token : token[..12];

    private static string NewToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}