using System.Text.Json;
using Microsoft.JSInterop;

namespace Pv.Blazor;

/// <summary>
/// Drives a <see cref="PdfViewer"/> from code, including from other components: create one, pass it to the viewer's
/// <see cref="PdfViewer.Controller"/> parameter, and share it. Commands issued before the viewer is ready, or
/// while no viewer has it, wait and then run in the order issued once a viewer takes it.
/// </summary>
public sealed class PdfViewerController
{
    private const long DefaultMaximumDocumentSize = 1024L * 1024 * 1024;
    private const long MaximumSelectionSize = 64L * 1024 * 1024;

    private readonly List<Func<IJSObjectReference, Task>> _waiting = [];
    private IJSObjectReference? _bridge;
    private object? _viewer;

    /// <summary>Whether a document has opened and not closed since.</summary>
    public bool IsDocumentOpen => PageCount > 0;

    /// <summary>The open document's number of pages, or 0 when none is open.</summary>
    public int PageCount { get; private set; }

    /// <summary>The displayed page, or 0 when no document is open.</summary>
    public int CurrentPage { get; private set; }

    /// <summary>
    /// Raised when <see cref="IsDocumentOpen"/>, <see cref="PageCount"/> or <see cref="CurrentPage"/> changes.
    /// </summary>
    public event Action? StateChanged;

    /// <summary>
    /// Completes once the page is shown, or once the turn has failed or another has replaced it. While a document is
    /// opening, it opens on this page instead of <see cref="PdfViewer.InitialPage"/>. Failures are reported through
    /// <see cref="PdfViewer.OnError"/>. Canceling stops the wait, not the page turn.
    /// </summary>
    public Task GoToPageAsync(int page, CancellationToken cancellationToken = default) =>
        RunAsync(bridge => bridge.InvokeVoidAsync("goToPage", cancellationToken, page).AsTask(), cancellationToken);

    public Task SetZoomAsync(double scale) => SendAsync("setZoom", scale);

    public Task SetZoomAsync(ViewerZoomMode mode) => SendAsync("setZoom", mode);

    /// <summary>Sets the viewing rotation, which is added to any rotation the page already has.</summary>
    public Task SetRotationAsync(PageRotation rotation)
    {
        ThrowIfUndefined(rotation);
        return SendAsync("setRotation", (int)rotation);
    }

    /// <summary>
    /// Sets the rotation one page ends up with, replacing both its own rotation and the viewing rotation. Pass null to
    /// return to its own rotation plus the viewing rotation. The result doesn't depend on any rotation the page already
    /// has.
    /// </summary>
    public Task SetPageRotationAsync(int page, PageRotation? rotation)
    {
        if (rotation is { } value)
        {
            ThrowIfUndefined(value);
        }
        return SendAsync("setPageRotation", page, (int?)rotation);
    }

    /// <summary>
    /// Turns to an object's page if it isn't displayed, then scrolls only as far as it takes to show the object.
    /// Completes once it's in view. Canceling stops the wait, not the scrolling.
    /// </summary>
    public Task ScrollObjectIntoViewAsync(string id, CancellationToken cancellationToken = default) =>
        RunAsync(bridge => bridge.InvokeVoidAsync("scrollObjectIntoView", cancellationToken, id).AsTask(),
            cancellationToken);

    /// <summary>
    /// A page's label, and its size and rotation in the coordinates objects use, whether or not it's displayed.
    /// </summary>
    public Task<PageInfo> GetPageInfoAsync(int page, CancellationToken cancellationToken = default) =>
        RunAsync(bridge => bridge.InvokeAsync<PageInfo>("getPageInfo", cancellationToken, page).AsTask(),
            cancellationToken);

    public Task SetToolAsync(ViewerTool tool, ViewerDrawDefaults? drawDefaults = null) =>
        SendAsync("setTool", tool, drawDefaults);

    /// <summary>
    /// Copies the original document to a stream, such as an upload to your own storage. The bytes cross the circuit in
    /// chunks, so this needs no change to the hub's message size limit, but it's still slower than sending them over
    /// HTTP.
    /// </summary>
    public Task CopyDocumentToAsync(Stream destination, long maximumSize = DefaultMaximumDocumentSize,
        CancellationToken cancellationToken = default) =>
        RunAsync(async bridge =>
        {
            await using var data =
                await bridge.InvokeAsync<IJSStreamReference>("getDocumentData", cancellationToken, []);
            await using var source = await data.OpenReadStreamAsync(maximumSize, cancellationToken);
            await source.CopyToAsync(destination, cancellationToken);
        }, cancellationToken);

    /// <summary>Selects one object, or none when given null.</summary>
    public Task SelectObjectAsync(string? id) => SelectObjectsAsync(id is null ? [] : [id]);

    /// <summary>Selects exactly these objects. Handles appear only when one object is selected.</summary>
    public Task SelectObjectsAsync(IEnumerable<string> ids) => SendAsync("selectObjects", ids);

    /// <summary>
    /// Every selected object's ID, in the order selected. This is the selection when the browser answers, which can be
    /// newer than the <see cref="PdfViewer.OnSelectionChanged"/> notification being handled. The IDs cross the circuit
    /// as a stream, so a large selection needs no change to the hub's message size limit.
    /// </summary>
    public Task<IReadOnlyList<string>> GetSelectedObjectIdsAsync(CancellationToken cancellationToken = default) =>
        RunAsync<IReadOnlyList<string>>(async bridge =>
        {
            await using var data =
                await bridge.InvokeAsync<IJSStreamReference>("getSelectedObjectIds", cancellationToken, []);
            await using var source = await data.OpenReadStreamAsync(MaximumSelectionSize, cancellationToken);
            return await JsonSerializer.DeserializeAsync<string[]>(source, cancellationToken: cancellationToken) ?? [];
        }, cancellationToken);

    internal Task ZoomByAsync(double factor) => SendAsync("zoomBy", factor);

    internal Task RotateByAsync(int degrees) => SendAsync("rotateBy", degrees);

    /// <summary>Starts sending commands to a viewer, beginning with those that have been waiting.</summary>
    internal void Attach(object viewer, IJSObjectReference bridge)
    {
        if (_viewer is not null && _viewer != viewer)
        {
            throw new InvalidOperationException("This controller already drives another viewer. Give each its own.");
        }
        _viewer = viewer;
        _bridge = bridge;
        // Each call reaches the browser before the next starts, because sending happens before a command first waits.
        var waiting = _waiting.ToArray();
        _waiting.Clear();
        foreach (var command in waiting)
        {
            _ = command(bridge);
        }
    }

    /// <summary>
    /// Stops sending commands to a viewer. Later commands wait for the next viewer to take this controller.
    /// </summary>
    internal void Detach(object viewer)
    {
        if (_viewer == viewer)
        {
            _viewer = null;
            _bridge = null;
            SetState(0, 0);
        }
    }

    /// <summary>Records what the viewer reported, raising <see cref="StateChanged"/> if anything changed.</summary>
    internal void SetState(int pageCount, int currentPage)
    {
        if (pageCount == PageCount && currentPage == CurrentPage)
        {
            return;
        }
        PageCount = pageCount;
        CurrentPage = currentPage;
        StateChanged?.Invoke();
    }

    private Task SendAsync(string method, params object?[] arguments) =>
        RunAsync(bridge => bridge.InvokeVoidAsync(method, arguments).AsTask(), CancellationToken.None);

    private Task RunAsync(Func<IJSObjectReference, Task> command, CancellationToken cancellationToken) =>
        RunAsync(async bridge =>
        {
            await command(bridge);
            return true;
        }, cancellationToken);

    /// <summary>Runs a command now if a viewer has this controller, and otherwise once one does.</summary>
    private Task<T> RunAsync<T>(Func<IJSObjectReference, Task<T>> command, CancellationToken cancellationToken)
    {
        if (_bridge is not null)
        {
            return command(_bridge);
        }
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
        _waiting.Add(async bridge =>
        {
            try
            {
                if (!completion.Task.IsCompleted)
                {
                    completion.TrySetResult(await command(bridge));
                }
            }
            catch (OperationCanceledException exception)
            {
                completion.TrySetCanceled(exception.CancellationToken);
            }
            catch (Exception exception)
            {
                completion.TrySetException(exception);
            }
            finally
            {
                await registration.DisposeAsync();
            }
        });
        return completion.Task;
    }

    /// <summary>A cast can put any integer in a <see cref="PageRotation"/>, but only quarter turns are valid.</summary>
    private static void ThrowIfUndefined(PageRotation rotation)
    {
        if (!Enum.IsDefined(rotation))
        {
            throw new ArgumentOutOfRangeException(nameof(rotation), rotation, "Rotation must be a quarter turn.");
        }
    }
}
