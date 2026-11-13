using Microsoft.JSInterop;

namespace Pv.Blazor;

/// <summary>
/// Receives the browser's notifications for one viewer. They arrive here rather than on <see cref="PdfViewer"/>, so its
/// public surface carries no methods meant only for JavaScript.
/// </summary>
internal sealed class ViewerNotifications(PdfViewer viewer)
{
    [JSInvokable]
    public Task NotifyDocumentLoaded(DocumentLoadedNotification notification) =>
        viewer.HandleDocumentLoadedAsync(notification);

    [JSInvokable]
    public Task NotifyPageChanged(PageChangedArgs args) => viewer.HandlePageChangedAsync(args);

    [JSInvokable]
    public Task NotifyError(ViewerError error) => viewer.HandleErrorAsync(error);

    [JSInvokable]
    public Task NotifyObjectAdded(ObjectAddedArgs args) => viewer.OnObjectAdded.InvokeAsync(args);

    [JSInvokable]
    public Task NotifyObjectUpdated(ObjectUpdatedArgs args) => viewer.OnObjectUpdated.InvokeAsync(args);

    [JSInvokable]
    public Task NotifyObjectRemoved(ObjectRemovedArgs args) => viewer.OnObjectRemoved.InvokeAsync(args);

    [JSInvokable]
    public Task NotifyObjectsReplaced(ObjectsReplacedArgs args) => viewer.OnObjectsReplaced.InvokeAsync(args);

    [JSInvokable]
    public Task NotifySelectionChanged(SelectionChangedArgs args) => viewer.OnSelectionChanged.InvokeAsync(args);
}

/// <summary>The document opened. <paramref name="Page"/> is the page the viewer shows first.</summary>
internal sealed record DocumentLoadedNotification(int PageCount, int Page);

/// <summary>Which notifications .NET has handlers for. Each one sent costs a message over the circuit.</summary>
internal readonly record struct ViewerSubscriptions(bool Objects, bool Selection);
