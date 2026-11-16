using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Pv.Blazor;

/// <summary>
/// The browser side of one viewer, as <see cref="PdfViewer"/> and its controller use it. The real one calls the
/// viewer's JavaScript. A test registers an <see cref="IViewerBackendFactory"/> to put a fake in its place.
/// </summary>
internal interface IViewerBackend : IAsyncDisposable
{
    Task ConfigureAsync(PdfViewerOptions options);

    Task SubscribeAsync(ViewerSubscriptions subscriptions);

    Task SetReadOnlyAsync(bool readOnly);

    Task OpenAsync(PdfSource source, int initialPage);

    Task CloseAsync();

    Task ApplyObjectsAsync(ObjectBatch batch);

    /// <summary>
    /// Selects one object, or none when given null or an ID with no object, and returns whether it selected what was
    /// asked.
    /// </summary>
    Task<bool> SelectObjectIfPresentAsync(string? id);

    Task GoToPageAsync(int page, CancellationToken cancellationToken);

    Task SetZoomAsync(double scale);

    Task SetZoomAsync(ViewerZoomMode mode);

    Task ZoomByAsync(double factor);

    Task SetRotationAsync(int degrees);

    Task RotateByAsync(int degrees);

    Task SetPageRotationAsync(int page, int? degrees);

    Task ScrollObjectIntoViewAsync(string id, CancellationToken cancellationToken);

    Task<PageInfo> GetPageInfoAsync(int page, CancellationToken cancellationToken);

    Task SetToolAsync(ViewerTool tool, ViewerDrawDefaults? drawDefaults);

    Task CopyDocumentToAsync(Stream destination, long maximumSize, CancellationToken cancellationToken);

    Task MoveObjectByAsync(string id, double deltaX, double deltaY);

    Task CommitDraftAsync(string id);

    Task DiscardDraftAsync(string id);

    Task SelectObjectsAsync(IEnumerable<string> ids);

    Task<IReadOnlyList<string>> GetSelectedObjectIdsAsync(CancellationToken cancellationToken);
}

/// <summary>Attaches a backend to a viewer once it has rendered.</summary>
internal interface IViewerBackendFactory
{
    /// <summary>
    /// Returns null if <paramref name="cancellationToken"/> is canceled while attaching, having released whatever it
    /// had set up.
    /// </summary>
    Task<IViewerBackend?> AttachAsync(ElementReference host, ViewerNotifications notifications,
        PdfViewerOptions options, ViewerSubscriptions subscriptions, CancellationToken cancellationToken);
}

/// <summary>Attaches to the viewer's JavaScript module, which the browser imports once per viewer.</summary>
internal sealed class JsViewerBackendFactory(IJSRuntime js) : IViewerBackendFactory
{
    private const string ModulePath = "./_content/Pv.Blazor/pv.js";

    public async Task<IViewerBackend?> AttachAsync(ElementReference host, ViewerNotifications notifications,
        PdfViewerOptions options, ViewerSubscriptions subscriptions, CancellationToken cancellationToken)
    {
        var reference = DotNetObjectReference.Create(notifications);
        IJSObjectReference module;
        try
        {
            module = await js.InvokeAsync<IJSObjectReference>("import", ModulePath);
        }
        catch
        {
            reference.Dispose();
            throw;
        }
        if (cancellationToken.IsCancellationRequested)
        {
            await JsViewerBackend.ReleaseAsync(module, reference);
            return null;
        }
        IJSObjectReference bridge;
        try
        {
            bridge = await module.InvokeAsync<IJSObjectReference>("attach", host, reference, options, subscriptions);
        }
        catch
        {
            await JsViewerBackend.ReleaseAsync(module, reference);
            throw;
        }
        var backend = new JsViewerBackend(module, bridge, reference);
        if (cancellationToken.IsCancellationRequested)
        {
            await backend.DisposeAsync();
            return null;
        }
        return backend;
    }
}

/// <summary>Sends each call to the viewer's bridge in the browser.</summary>
internal sealed class JsViewerBackend(IJSObjectReference module, IJSObjectReference bridge,
    DotNetObjectReference<ViewerNotifications> notifications) : IViewerBackend
{
    private const long MaximumSelectionSize = 64L * 1024 * 1024;

    public Task ConfigureAsync(PdfViewerOptions options) => SendAsync("configure", options);

    public Task SubscribeAsync(ViewerSubscriptions subscriptions) => SendAsync("subscribe", subscriptions);

    public Task SetReadOnlyAsync(bool readOnly) => SendAsync("setReadOnly", readOnly);

    public Task OpenAsync(PdfSource source, int initialPage) => SendAsync("open", source.ToInterop(), initialPage);

    public Task CloseAsync() => SendAsync("close");

    public Task ApplyObjectsAsync(ObjectBatch batch) => SendAsync("applyObjects", batch);

    public Task<bool> SelectObjectIfPresentAsync(string? id) =>
        bridge.InvokeAsync<bool>("selectObjectIfPresent", id).AsTask();

    public Task GoToPageAsync(int page, CancellationToken cancellationToken) =>
        bridge.InvokeVoidAsync("goToPage", cancellationToken, page).AsTask();

    public Task SetZoomAsync(double scale) => SendAsync("setZoom", scale);

    public Task SetZoomAsync(ViewerZoomMode mode) => SendAsync("setZoom", mode);

    public Task ZoomByAsync(double factor) => SendAsync("zoomBy", factor);

    public Task SetRotationAsync(int degrees) => SendAsync("setRotation", degrees);

    public Task RotateByAsync(int degrees) => SendAsync("rotateBy", degrees);

    public Task SetPageRotationAsync(int page, int? degrees) => SendAsync("setPageRotation", page, degrees);

    public Task ScrollObjectIntoViewAsync(string id, CancellationToken cancellationToken) =>
        bridge.InvokeVoidAsync("scrollObjectIntoView", cancellationToken, id).AsTask();

    public Task<PageInfo> GetPageInfoAsync(int page, CancellationToken cancellationToken) =>
        bridge.InvokeAsync<PageInfo>("getPageInfo", cancellationToken, page).AsTask();

    public Task SetToolAsync(ViewerTool tool, ViewerDrawDefaults? drawDefaults) =>
        SendAsync("setTool", tool, drawDefaults);

    public async Task CopyDocumentToAsync(Stream destination, long maximumSize, CancellationToken cancellationToken)
    {
        await using var data = await bridge.InvokeAsync<IJSStreamReference>("getDocumentData", cancellationToken, []);
        await using var source = await data.OpenReadStreamAsync(maximumSize, cancellationToken);
        await source.CopyToAsync(destination, cancellationToken);
    }

    public Task MoveObjectByAsync(string id, double deltaX, double deltaY) =>
        SendAsync("moveObjectBy", id, deltaX, deltaY);

    public Task CommitDraftAsync(string id) => SendAsync("commitDraft", id);

    public Task DiscardDraftAsync(string id) => SendAsync("discardDraft", id);

    public Task SelectObjectsAsync(IEnumerable<string> ids) => SendAsync("selectObjects", ids);

    public async Task<IReadOnlyList<string>> GetSelectedObjectIdsAsync(CancellationToken cancellationToken)
    {
        await using var data =
            await bridge.InvokeAsync<IJSStreamReference>("getSelectedObjectIds", cancellationToken, []);
        await using var source = await data.OpenReadStreamAsync(MaximumSelectionSize, cancellationToken);
        return await JsonSerializer.DeserializeAsync<string[]>(source, cancellationToken: cancellationToken) ?? [];
    }

    /// <summary>
    /// The custom element destroys the document itself when it leaves the page, which also works if the circuit is
    /// already gone. This only disconnects the .NET side.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        try
        {
            await bridge.InvokeVoidAsync("dispose");
            await bridge.DisposeAsync();
        }
        catch (JSDisconnectedException)
        {
            // The circuit is gone, and the browser side cleans up after itself.
        }
        await ReleaseAsync(module, notifications);
    }

    /// <summary>Releases what attaching set up, whether or not it finished.</summary>
    internal static async Task ReleaseAsync(IJSObjectReference module,
        DotNetObjectReference<ViewerNotifications> notifications)
    {
        try
        {
            await module.DisposeAsync();
        }
        catch (JSDisconnectedException)
        {
            // The circuit is gone, and the browser side cleans up after itself.
        }
        notifications.Dispose();
    }

    private Task SendAsync(string method, params object?[] arguments) =>
        bridge.InvokeVoidAsync(method, arguments).AsTask();
}
