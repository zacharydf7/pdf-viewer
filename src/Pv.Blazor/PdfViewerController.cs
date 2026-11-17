namespace Pv.Blazor;

/// <summary>
/// Drives a <see cref="PdfViewer"/> from code, including from other components: create one, pass it to the viewer's
/// <see cref="PdfViewer.Controller"/> parameter, and share it. Commands issued before the viewer is ready, or
/// while no viewer has it, wait and then run in the order issued once a viewer takes it.
/// </summary>
public sealed class PdfViewerController
{
    private const long DefaultMaximumDocumentSize = 1024L * 1024 * 1024;

    private readonly List<Func<IViewerBackend, Task>> _waiting = [];
    private IViewerBackend? _backend;
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
        RunAsync(backend => backend.GoToPageAsync(page, cancellationToken), cancellationToken);

    public Task SetZoomAsync(double scale) => SendAsync(backend => backend.SetZoomAsync(scale));

    public Task SetZoomAsync(ViewerZoomMode mode) => SendAsync(backend => backend.SetZoomAsync(mode));

    /// <summary>Sets the viewing rotation, which is added to any rotation the page already has.</summary>
    public Task SetRotationAsync(PageRotation rotation)
    {
        ThrowIfUndefined(rotation);
        return SendAsync(backend => backend.SetRotationAsync((int)rotation));
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
        return SendAsync(backend => backend.SetPageRotationAsync(page, (int?)rotation));
    }

    /// <summary>
    /// Turns to an object's page if it isn't displayed, then scrolls only as far as it takes to show the object.
    /// Completes once it's in view. Canceling stops the wait, not the scrolling.
    /// </summary>
    public Task ScrollObjectIntoViewAsync(string id, CancellationToken cancellationToken = default) =>
        RunAsync(backend => backend.ScrollObjectIntoViewAsync(id, cancellationToken), cancellationToken);

    /// <summary>
    /// Announces a message to screen reader users through the viewer's polite live region, which also reports moves and
    /// resizes made with the keyboard. Use it for a change your app makes that they can't otherwise perceive, such as
    /// an undo.
    /// </summary>
    public Task AnnounceAsync(string message) => SendAsync(backend => backend.AnnounceAsync(message));

    /// <summary>
    /// A page's label, and its size and rotation in the coordinates objects use, whether or not it's displayed.
    /// </summary>
    public Task<PageInfo> GetPageInfoAsync(int page, CancellationToken cancellationToken = default) =>
        RunAsync(backend => backend.GetPageInfoAsync(page, cancellationToken), cancellationToken);

    public Task SetToolAsync(ViewerTool tool, ViewerDrawDefaults? drawDefaults = null) =>
        SendAsync(backend => backend.SetToolAsync(tool, drawDefaults));

    /// <summary>
    /// Copies the original document to a stream, such as an upload to your own storage. The bytes cross the circuit in
    /// chunks, so this needs no change to the hub's message size limit, but it's still slower than sending them over
    /// HTTP.
    /// </summary>
    public Task CopyDocumentToAsync(Stream destination, long maximumSize = DefaultMaximumDocumentSize,
        CancellationToken cancellationToken = default) =>
        RunAsync(backend => backend.CopyDocumentToAsync(destination, maximumSize, cancellationToken), cancellationToken);

    /// <summary>
    /// Moves an object as an arrow key does: by a distance in page units as displayed, so positive
    /// <paramref name="deltaX"/> is right and positive <paramref name="deltaY"/> is down on screen at any rotation.
    /// The object stays on its page, and a locked or hidden object doesn't move. The move is reported through
    /// <see cref="PdfViewer.OnObjectsChanged"/> as the user's <see cref="EditGesture.Nudge"/>, which carries the
    /// rectangle it ended up with. Completes once the move has been applied, and fails if the object doesn't exist.
    /// </summary>
    public Task MoveObjectByAsync(string id, double deltaX, double deltaY) =>
        SendAsync(backend => backend.MoveObjectByAsync(id, deltaX, deltaY));

    /// <summary>
    /// Keeps a draft from <see cref="PdfViewer.OnObjectDrawn"/> as it was drawn. It becomes an object the user added,
    /// so it's reported through <see cref="PdfViewer.OnObjectsChanged"/>, and with <see cref="PdfViewer.Objects"/> set
    /// it has to go into your list like any other. Does nothing if the draft is gone.
    /// </summary>
    public Task CommitDraftAsync(string id) => SendAsync(backend => backend.CommitDraftAsync(id));

    /// <summary>
    /// Discards a draft from <see cref="PdfViewer.OnObjectDrawn"/> without waiting for its handler to finish. Does
    /// nothing if the draft is gone.
    /// </summary>
    public Task DiscardDraftAsync(string id) => SendAsync(backend => backend.DiscardDraftAsync(id));

    /// <summary>Selects one object, or none when given null.</summary>
    public Task SelectObjectAsync(string? id) => SelectObjectsAsync(id is null ? [] : [id]);

    /// <summary>Selects exactly these objects. Handles appear only when one object is selected.</summary>
    public Task SelectObjectsAsync(IEnumerable<string> ids) => SendAsync(backend => backend.SelectObjectsAsync(ids));

    /// <summary>
    /// Every selected object's ID, in the order selected. This is the selection when the browser answers, which can be
    /// newer than the <see cref="PdfViewer.OnSelectionChanged"/> notification being handled. The IDs cross the circuit
    /// as a stream, so a large selection needs no change to the hub's message size limit.
    /// </summary>
    public Task<IReadOnlyList<string>> GetSelectedObjectIdsAsync(CancellationToken cancellationToken = default) =>
        RunAsync(backend => backend.GetSelectedObjectIdsAsync(cancellationToken), cancellationToken);

    internal Task ZoomByAsync(double factor) => SendAsync(backend => backend.ZoomByAsync(factor));

    internal Task RotateByAsync(int degrees) => SendAsync(backend => backend.RotateByAsync(degrees));

    /// <summary>Starts sending commands to a viewer, beginning with those that have been waiting.</summary>
    internal void Attach(object viewer, IViewerBackend backend)
    {
        if (_viewer is not null && _viewer != viewer)
        {
            throw new InvalidOperationException("This controller already drives another viewer. Give each its own.");
        }
        _viewer = viewer;
        _backend = backend;
        // Each call reaches the browser before the next starts, because sending happens before a command first waits.
        var waiting = _waiting.ToArray();
        _waiting.Clear();
        foreach (var command in waiting)
        {
            _ = command(backend);
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
            _backend = null;
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

    private Task SendAsync(Func<IViewerBackend, Task> command) => RunAsync(command, CancellationToken.None);

    private Task RunAsync(Func<IViewerBackend, Task> command, CancellationToken cancellationToken) =>
        RunAsync(async backend =>
        {
            await command(backend);
            return true;
        }, cancellationToken);

    /// <summary>Runs a command now if a viewer has this controller, and otherwise once one does.</summary>
    private Task<T> RunAsync<T>(Func<IViewerBackend, Task<T>> command, CancellationToken cancellationToken)
    {
        if (_backend is not null)
        {
            return command(_backend);
        }
        var completion = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = cancellationToken.Register(() => completion.TrySetCanceled(cancellationToken));
        _waiting.Add(async backend =>
        {
            try
            {
                if (!completion.Task.IsCompleted)
                {
                    completion.TrySetResult(await command(backend));
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
