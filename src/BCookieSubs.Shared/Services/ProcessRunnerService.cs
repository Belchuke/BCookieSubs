using Microsoft.Extensions.Logging;
using System.Diagnostics;
using System.Text;

namespace BCookieSubs.Shared.Services;

public sealed record ProcessResult(int ExitCode, string StdOut, string StdErr, bool TimedOut)
{
    public bool Success => ExitCode == 0 && !TimedOut;
}

public sealed class ProcessRunOptions
{
    public TimeSpan? Timeout { get; init; }
    public string? WorkingDirectory { get; init; }
    public IReadOnlyDictionary<string, string>? Environment { get; init; }
    public Action<string>? OnStdoutLine { get; init; }
    public Action<string>? OnStderrLine { get; init; }
}

public class ProcessRunnerService(ILogger<ProcessRunnerService> logger)
{
    public async Task<ProcessResult> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        ProcessRunOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        options ??= new ProcessRunOptions();
        var timeout = options.Timeout;

        using var timeoutCts = timeout is { } t ? new CancellationTokenSource(t) : new CancellationTokenSource();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (options.WorkingDirectory is { } workDir)
        {
            startInfo.WorkingDirectory = workDir;
        }
        if (options.Environment is { } env)
        {
            foreach (var (key, value) in env)
            {
                startInfo.Environment[key] = value;
            }
        }
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        logger.LogDebug("Running {FileName} {Arguments}", fileName, string.Join(' ', arguments));

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                return new ProcessResult(-1, "", $"Failed to start {fileName}.", false);
            }
        }
        catch (Exception ex)
        {
            return new ProcessResult(-1, "", ex.Message, false);
        }

        var stdout = ReadLinesAsync(process.StandardOutput, options.OnStdoutLine, linked.Token);
        var stderr = ReadLinesAsync(process.StandardError, options.OnStderrLine, linked.Token);

        try
        {
            await process.WaitForExitAsync(linked.Token);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            await KillAsync(process);
            return new ProcessResult(-1, await stdout, $"Process timed out after {timeout!.Value.TotalSeconds:F0}s.", true);
        }
        catch (OperationCanceledException)
        {
            await KillAsync(process);
            throw;
        }

        return new ProcessResult(process.ExitCode, await stdout, await stderr, false);
    }

    // Drain both pipes concurrently; reading line-by-line keeps live callbacks working
    // and prevents pipe-buffer deadlock on chatty processes (ffmpeg progress).
    private static async Task<string> ReadLinesAsync(StreamReader reader, Action<string>? onLine, CancellationToken ct)
    {
        var buffer = new StringBuilder();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            onLine?.Invoke(line);
            if (onLine == null) buffer.AppendLine(line);
        }
        return buffer.ToString();
    }

    private static async Task KillAsync(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(CancellationToken.None);
        }
        catch (InvalidOperationException)
        {
        }
    }
}