using System.Net.Http.Json;
using System.Text.Json;
using BCookieSubs.Shared.Security;

namespace BCookieSubs.Shared.Services;

public record OllamaModelInfo(string Name, string? Size, string? ParameterSize, string? ModifiedAt);

public record OllamaTestResult(bool Success, bool OllamaRunning, string? Version, string? Error);

public record OllamaListResult(bool Success, bool OllamaRunning, List<OllamaModelInfo> Models, string? Error);

public class OllamaService(IHttpClientFactory httpClientFactory, SecretsService secrets)
{
    public const string DefaultBaseUrl = "http://127.0.0.1:11434";
    public const string BaseUrlEnvVar = "OLLAMA_BASE_URL";

    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    public static string GetBaseUrl()
    {
        var raw = Environment.GetEnvironmentVariable(BaseUrlEnvVar)?.Trim();
        return string.IsNullOrWhiteSpace(raw) ? DefaultBaseUrl : raw.TrimEnd('/');
    }

    public static string GetBaseUrl(string? overrideUrl) =>
        string.IsNullOrWhiteSpace(overrideUrl) ? GetBaseUrl() : overrideUrl.TrimEnd('/');

    public async Task<OllamaListResult> ListModelsAsync(CancellationToken ct = default)
    {
        try
        {
            var response = await SendAsync(HttpMethod.Get, "/api/tags", ct);
            if (!response.IsSuccessStatusCode)
            {
                return new OllamaListResult(false, true, [], $"Ollama returned HTTP {(int)response.StatusCode}");
            }

            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var models = new List<OllamaModelInfo>();
            if (doc.RootElement.TryGetProperty("models", out var list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in list.EnumerateArray())
                {
                    var name = entry.TryGetProperty("name", out var n) ? n.GetString() : null;
                    if (string.IsNullOrEmpty(name))
                    {
                        continue;
                    }

                    var size = entry.TryGetProperty("size", out var s) && s.ValueKind == JsonValueKind.Number
                        ? s.GetInt64().ToString()
                        : null;
                    var parameterSize =
                        entry.TryGetProperty("details", out var d) &&
                        d.ValueKind == JsonValueKind.Object &&
                        d.TryGetProperty("parameter_size", out var p)
                            ? p.GetString()
                            : null;
                    var modifiedAt = entry.TryGetProperty("modified_at", out var m) ? m.GetString() : null;
                    models.Add(new OllamaModelInfo(name!, size, parameterSize, modifiedAt));
                }
            }

            return new OllamaListResult(true, true, models, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return new OllamaListResult(false, IsReachable(ex), [], ex.Message);
        }
    }

    public async Task<OllamaTestResult> TestConnectionAsync(CancellationToken ct = default)
    {
        try
        {
            var response = await SendAsync(HttpMethod.Get, "/api/version", ct);
            if (!response.IsSuccessStatusCode)
            {
                return new OllamaTestResult(false, true, null, $"Ollama returned HTTP {(int)response.StatusCode}");
            }

            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var version = doc.RootElement.TryGetProperty("version", out var v) ? v.GetString() : null;
            return new OllamaTestResult(true, true, version, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return new OllamaTestResult(false, IsReachable(ex), null, ex.Message);
        }
    }

    public record OllamaPullChunk(string? Status, long? Completed, long? Total, string? Digest);

    public async IAsyncEnumerable<OllamaPullChunk> PullAsync(
        string modelName, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"{GetBaseUrl()}/api/pull")
        {
            Content = JsonContent.Create(new { model = modelName, stream = true })
        };
        var apiKey = await GetApiKeyAsync();
        if (apiKey is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {apiKey}");
        }

        using var response = await httpClientFactory.CreateClient("ollama")
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.TryGetProperty("error", out var err))
            {
                throw new InvalidOperationException(err.GetString() ?? "Pull failed");
            }

            yield return new OllamaPullChunk(
                root.TryGetProperty("status", out var st) ? st.GetString() : null,
                root.TryGetProperty("completed", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt64() : null,
                root.TryGetProperty("total", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt64() : null,
                root.TryGetProperty("digest", out var dg) ? dg.GetString() : null);
        }
    }

    public record OllamaRemoveResult(bool Success, string? Error);

    public async Task<OllamaRemoveResult> RemoveModelAsync(string modelName, CancellationToken ct = default)
    {
        try
        {
            var response = await SendAsync(HttpMethod.Delete, "/api/delete", ct,
                JsonContent.Create(new { model = modelName }));
            return response.IsSuccessStatusCode
                ? new OllamaRemoveResult(true, null)
                : new OllamaRemoveResult(false, $"Ollama returned HTTP {(int)response.StatusCode}");
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return new OllamaRemoveResult(false, ex.Message);
        }
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, CancellationToken ct, HttpContent? content = null)
    {
        var request = new HttpRequestMessage(method, $"{GetBaseUrl()}{path}") { Content = content };
        var apiKey = await GetApiKeyAsync();
        if (apiKey is not null)
        {
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {apiKey}");
        }

        var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(Timeout);
        return await httpClientFactory.CreateClient("ollama").SendAsync(request, timeoutCts.Token);
    }

    private async Task<string?> GetApiKeyAsync()
    {
        try
        {
            var key = await secrets.GetAsync(SecretKeys.OllamaApiKey);
            return string.IsNullOrWhiteSpace(key) ? null : key;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    private static bool IsReachable(Exception ex) =>
        !(ex.InnerException is System.Net.Sockets.SocketException se && se.SocketErrorCode == System.Net.Sockets.SocketError.ConnectionRefused);
}