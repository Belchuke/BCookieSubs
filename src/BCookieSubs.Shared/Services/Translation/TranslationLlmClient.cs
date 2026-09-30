using System.Net;
using BCookieSubs.Shared.Database.Entities;

namespace BCookieSubs.Shared.Services.Translation;

public class RateLimitedException(string message) : Exception(message);

public class TranslationLlmClient(LlmChatService chat)
{
    public async Task<LlmChatResult> SendAsync(Model model, string prompt, CancellationToken ct = default)
    {
        try
        {
            return await chat.ChatAsync(model, prompt, ct: ct);
        }
        catch (Exception e) when (IsRateLimit(e))
        {
            throw new RateLimitedException($"Rate limited on model {model.ModelName}: {e.Message}");
        }
    }

    private static bool IsRateLimit(Exception e)
    {
        if (e is HttpRequestException http && http.StatusCode == HttpStatusCode.TooManyRequests) return true;
        var msg = e.Message.ToLowerInvariant();
        return msg.Contains("429") ||
               msg.Contains("rate limit") ||
               msg.Contains("rate_limit") ||
               msg.Contains("too many requests");
    }
}