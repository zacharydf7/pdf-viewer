using Microsoft.AspNetCore.Components;
using Microsoft.Extensions.DependencyInjection;
using Pv.Blazor;

namespace Pv.Testing.Bunit;

/// <summary>
/// The fakes standing in for every <see cref="PdfViewer"/> a test renders, one per viewer, in the order the viewers
/// attached.
/// </summary>
public sealed class FakePdfViewers
{
    private readonly List<FakePdfViewer> _viewers = [];

    public IReadOnlyList<FakePdfViewer> All => _viewers;

    /// <summary>
    /// The fake for the only viewer on display. Throws unless exactly one viewer is attached and not disposed.
    /// </summary>
    public FakePdfViewer Viewer
    {
        get
        {
            var attached = _viewers.Where(viewer => !viewer.IsDisposed).ToList();
            return attached.Count == 1
                ? attached[0]
                : throw new InvalidOperationException(
                    $"Expected one PDF viewer on display, but there are {attached.Count}. Render the component " +
                    "first, or pick one from All.");
        }
    }

    internal void Add(FakePdfViewer viewer) => _viewers.Add(viewer);
}

public static class FakePdfViewerServiceCollectionExtensions
{
    /// <summary>
    /// Makes every <see cref="PdfViewer"/> rendered with these services use a fake instead of the browser. Register it
    /// before rendering, for example on a bUnit context's <c>Services</c>.
    /// </summary>
    public static FakePdfViewers AddFakePdfViewers(this IServiceCollection services)
    {
        var viewers = new FakePdfViewers();
        services.AddSingleton(viewers);
        services.AddSingleton<IViewerBackendFactory>(new FakeViewerBackendFactory(viewers));
        return viewers;
    }
}

internal sealed class FakeViewerBackendFactory(FakePdfViewers viewers) : IViewerBackendFactory
{
    public Task<IViewerBackend?> AttachAsync(ElementReference host, ViewerNotifications notifications,
        PdfViewerOptions options, ViewerSubscriptions subscriptions, CancellationToken cancellationToken)
    {
        var viewer = new FakePdfViewer(notifications, options, subscriptions);
        viewers.Add(viewer);
        return Task.FromResult<IViewerBackend?>(viewer);
    }
}
