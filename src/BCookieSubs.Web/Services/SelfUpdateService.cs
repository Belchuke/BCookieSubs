using System.Diagnostics;
using System.Text.RegularExpressions;

namespace BCookieSubs.Web.Services;

public record SelfUpdateStatus(bool Running, bool Finished, bool Ok, IReadOnlyList<string> Lines);

// Runs scripts/self-update.sh against a release tag: backup -> git checkout -> rebuild/restart
// (docs/update.md). State lives only in this process; after a compose rebuild the page simply
// reloads with the new version.
public partial class SelfUpdateService(ILogger<SelfUpdateService> logger)
{
    private const int MaxLines = 600;

    private static readonly Regex TagPattern = TagRegex();

    private readonly object _gate = new();
    private Process? _process;
    private readonly List<string> _lines = [];
    private bool _finished;
    private bool _ok;

    public string? RepoRoot { get; } = FindRepoRoot();
    private string? ScriptPath => RepoRoot == null ? null : Path.Combine(RepoRoot, "scripts", "self-update.sh");

    public (bool Started, string? Error) Start(string tag)
    {
        if (RepoRoot == null)
            return (false,
                "This installation has no git checkout of the code — update it from the host instead (see docs/update.md).");
        var script = ScriptPath!;
        if (!System.IO.File.Exists(script))
            return (false, "scripts/self-update.sh is missing in this checkout");
        if (!TagPattern.IsMatch(tag))
            return (false, "Invalid release tag");

        lock (_gate)
        {
            if (_process is { HasExited: false })
                return (false, "An update is already running");

            _lines.Clear();
            _finished = false;
            _ok = false;

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    WorkingDirectory = RepoRoot,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                };
                psi.ArgumentList.Add(script);
                psi.ArgumentList.Add(tag);

                var p = Process.Start(psi);
                if (p == null)
                    return (false, "Could not start the update script");

                _process = p;
                p.OutputDataReceived += (_, args) => Append(args.Data);
                p.ErrorDataReceived += (_, args) => Append(args.Data is null ? null : "  " + args.Data);
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                _ = Task.Run(() =>
                {
                    try
                    {
                        p.WaitForExit();
                    }
                    catch
                    {
                        // process object may already be disposed on hard shutdown
                    }
                    lock (_gate)
                    {
                        _finished = true;
                        _ok = p.ExitCode == 0;
                    }
                    logger.LogInformation("Self-update to {Tag} finished with exit code {ExitCode}", tag, p.ExitCode);
                });
                return (true, null);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to start self-update to {Tag}", tag);
                _process = null;
                return (false, "Could not start the update script — bash is required on this host");
            }
        }
    }

    public SelfUpdateStatus Status()
    {
        lock (_gate)
        {
            var running = _process is { HasExited: false } && !_finished;
            return new SelfUpdateStatus(running, _finished, _ok, [.. _lines]);
        }
    }

    private void Append(string? line)
    {
        if (line == null) return;
        lock (_gate)
        {
            if (_lines.Count == MaxLines) _lines.RemoveAt(0);
            _lines.Add(line);
        }
    }

    private static string? FindRepoRoot()
    {
        foreach (var start in (string?[])
        [
            AppContext.BaseDirectory,
            System.IO.Directory.GetCurrentDirectory(),
        ])
        {
            var dir = start == null ? null : Path.GetFullPath(start);
            while (dir != null)
            {
                if (System.IO.Directory.Exists(Path.Combine(dir, ".git")) &&
                    System.IO.File.Exists(Path.Combine(dir, "docker-compose.yml")))
                    return dir;
                dir = Path.GetDirectoryName(dir);
            }
        }
        return null;
    }

    [GeneratedRegex("^[\\w.\\-]{1,64}$")]
    private static partial Regex TagRegex();
}
