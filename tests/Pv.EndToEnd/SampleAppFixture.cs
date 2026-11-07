using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Microsoft.Playwright;

namespace Pv.EndToEnd;

/// <summary>Runs the sample app as a real server and shares one browser across the tests.</summary>
public sealed class SampleAppFixture : IAsyncLifetime
{
    private readonly ConcurrentQueue<string> _serverOutput = new();
    private Process? _server;
    private IPlaywright? _playwright;

    public string BaseUrl { get; private set; } = "";

    public IBrowser Browser { get; private set; } = default!;

    public async Task InitializeAsync()
    {
        var port = FindFreePort();
        BaseUrl = $"http://127.0.0.1:{port}";
        _server = StartServer(BaseUrl);
        await WaitForServerAsync();

        _playwright = await Playwright.CreateAsync();
        Browser = await _playwright.Chromium.LaunchAsync();
    }

    public async Task DisposeAsync()
    {
        if (Browser is not null)
        {
            await Browser.DisposeAsync();
        }
        _playwright?.Dispose();
        if (_server is not null)
        {
            _server.Kill(entireProcessTree: true);
            await _server.WaitForExitAsync();
            _server.Dispose();
        }
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private Process StartServer(string url)
    {
        var configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        var repositoryRoot = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..");
        var project = Path.GetFullPath(Path.Combine(repositoryRoot, "samples", "Pv.Sample"));
        string[] arguments = ["run", "--no-build", "--no-launch-profile", "-c", configuration];
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            WorkingDirectory = project,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.Environment["ASPNETCORE_URLS"] = url;
        startInfo.Environment["ASPNETCORE_ENVIRONMENT"] = "Development";

        var process = Process.Start(startInfo)!;
        process.OutputDataReceived += (_, line) => _serverOutput.Enqueue(line.Data ?? "");
        process.ErrorDataReceived += (_, line) => _serverOutput.Enqueue(line.Data ?? "");
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private async Task WaitForServerAsync()
    {
        using var client = new HttpClient();
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var response = await client.GetAsync($"{BaseUrl}/documents/letter.pdf");
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch (HttpRequestException)
            {
                // The server isn't listening yet.
            }
            await Task.Delay(200);
        }
        var output = string.Join('\n', _serverOutput);
        throw new TimeoutException($"The sample app didn't start at {BaseUrl}. Its output:\n{output}");
    }
}

[CollectionDefinition(Name)]
public sealed class SampleAppCollection : ICollectionFixture<SampleAppFixture>
{
    public const string Name = "Sample app";
}
