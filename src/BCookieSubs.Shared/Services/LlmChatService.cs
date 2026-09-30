using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Database.Enums;
using BCookieSubs.Shared.Security;

namespace BCookieSubs.Shared.Services;

public record LlmChatResult(string Content);

public class LlmChatService(IHttpClientFactory httpClientFactory, SecretsService secrets)
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(10);

    private static readonly JsonSerializerOptions RequestJson = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public async Task<LlmChatResult> ChatAsync(
        Model model, string prompt, TimeSpan? timeout = null, CancellationToken ct = default)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout ?? DefaultTimeout);

        return model.Provider switch
        {
            ModelProvider.OllamaCloud => await OllamaChatAsync(model, prompt, true, timeoutCts.Token),
            ModelProvider.ChatGpt => await ChatGptChatAsync(model, prompt, timeoutCts.Token),
            ModelProvider.Claude => await ClaudeChatAsync(model, prompt, timeoutCts.Token),
            _ => await OllamaChatAsync(model, prompt, false, timeoutCts.Token),
        };
    }

    private async Task<LlmChatResult> OllamaChatAsync(
        Model model, string prompt, bool cloud, CancellationToken ct)
    {
        var host = cloud
            ? ResolveBaseUrl(model.BaseUrl, OllamaService.DefaultBaseUrl)
            : OllamaService.GetBaseUrl(model.BaseUrl);
        var body = new Dictionary<string, object?>
        {
            ["model"] = model.ModelName,
            ["messages"] = new[] { new Dictionary<string, string> { ["role"] = "user", ["content"] = prompt } },
            ["stream"] = false,
        };
        if (model.CloseAfterUse) body["keep_alive"] = 0;

        using var request = new HttpRequestMessage(HttpMethod.Post, $"{host}/api/chat")
        {
            Content = new StringContent(JsonSerializer.Serialize(body, RequestJson), Encoding.UTF8, "application/json"),
        };
        if (cloud)
        {
            var key = await secrets.GetAsync(SecretKeys.OllamaApiKey, ct);
            if (!string.IsNullOrEmpty(key))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            }
        }
        else
        {
            var key = await TryGetSecretAsync(SecretKeys.OllamaApiKey, ct);
            if (!string.IsNullOrEmpty(key))
            {
                request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {key}");
            }
        }

        var response = await httpClientFactory.CreateClient("llm").SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return new LlmChatResult(
            doc.RootElement.TryGetProperty("message", out var message) &&
            message.TryGetProperty("content", out var content)
                ? content.GetString() ?? ""
                : "");
    }

    private async Task<LlmChatResult> ChatGptChatAsync(Model model, string prompt, CancellationToken ct)
    {
        var baseUrl = ResolveBaseUrl(model.BaseUrl, "https://api.openai.com/v1");
        var key = await secrets.GetAsync(SecretKeys.OpenAiApiKey, ct);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/chat/completions")
        {
            Content = JsonContent.Create(new
            {
                model = model.ModelName,
                messages = new[] { new { role = "user", content = prompt } },
            }),
        };
        if (!string.IsNullOrEmpty(key)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);

        var response = await httpClientFactory.CreateClient("llm").SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return new LlmChatResult(
            doc.RootElement.TryGetProperty("choices", out var choices) &&
            choices.ValueKind == JsonValueKind.Array &&
            choices.GetArrayLength() > 0 &&
            choices[0].TryGetProperty("message", out var message) &&
            message.TryGetProperty("content", out var content)
                ? content.GetString() ?? ""
                : "");
    }

    private async Task<LlmChatResult> ClaudeChatAsync(Model model, string prompt, CancellationToken ct)
    {
        var baseUrl = ResolveBaseUrl(model.BaseUrl, "https://api.anthropic.com");
        var key = await secrets.GetAsync(SecretKeys.AnthropicApiKey, ct);
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/v1/messages")
        {
            Content = JsonContent.Create(new
            {
                model = model.ModelName,
                max_tokens = 4096,
                messages = new[] { new { role = "user", content = prompt } },
            }),
        };
        if (!string.IsNullOrEmpty(key))
        {
            request.Headers.TryAddWithoutValidation("x-api-key", key);
            request.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
        }

        var response = await httpClientFactory.CreateClient("llm").SendAsync(request, ct);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return new LlmChatResult(
            doc.RootElement.TryGetProperty("content", out var content) &&
            content.ValueKind == JsonValueKind.Array &&
            content.GetArrayLength() > 0 &&
            content[0].TryGetProperty("text", out var text)
                ? text.GetString() ?? ""
                : "");
    }

    private static string ResolveBaseUrl(string? configured, string fallback) =>
        string.IsNullOrWhiteSpace(configured) ? fallback : configured.TrimEnd('/');

    private async Task<string?> TryGetSecretAsync(string key, CancellationToken ct)
    {
        try
        {
            return await secrets.GetAsync(key, ct);
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    // First {...} JSON object in an LLM response.
    public static string? ExtractJsonObject(string content)
    {
        var match = Regex.Match(content, @"\{[\s\S]*\}");
        return match.Success ? match.Value : null;
    }
}