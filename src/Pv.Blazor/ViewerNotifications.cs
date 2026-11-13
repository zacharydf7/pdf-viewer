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
    public Task NotifyChanges(ChangesNotification notification) => viewer.HandleChangesAsync(notification);
}

/// <summary>
/// What changed in the browser in one task: the objects the user changed, and the selection as it now stands. Either
/// part is null when it didn't change or .NET hasn't subscribed to it. <paramref name="Sequence"/> is that of the
/// latest change reported.
/// </summary>
internal sealed record ChangesNotification(long Sequence, ObjectChanges? Objects, SelectionState? Selection);

internal sealed record ObjectChanges(IReadOnlyList<ViewerObject> Added, IReadOnlyList<ObjectUpdate> Updated,
    IReadOnlyList<ViewerObject> Removed);

internal sealed record SelectionState(ChangeOrigin Origin, string? PrimaryId, int Count);

/// <summary>
/// Objects to add or replace and IDs to remove, applied as one change. <paramref name="BasedOn"/> is the sequence of
/// the latest change .NET had heard of, so the browser can leave alone anything the user changed after that.
/// </summary>
internal sealed record ObjectBatch(IReadOnlyList<ViewerObject> Upsert, IReadOnlyList<string> Remove, long BasedOn);

/// <summary>The document opened. <paramref name="Page"/> is the page the viewer shows first.</summary>
internal sealed record DocumentLoadedNotification(int PageCount, int Page);

/// <summary>Which notifications .NET has handlers for. Each one sent costs a message over the circuit.</summary>
internal readonly record struct ViewerSubscriptions(bool Objects, bool Selection);
