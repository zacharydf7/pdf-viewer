using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Pv.Blazor;

/// <summary>
/// Displays a PDF. Scrolling, zooming, rendering and dragging all run in the browser, so they keep working at full
/// speed over a slow circuit. Only commands and finished changes cross it. Drive it from code through a
/// <see cref="PdfViewerController"/>.
/// </summary>
public partial class PdfViewer
{
    private const string ModulePath = "./_content/Pv.Blazor/pv.js";
    private const double ZoomStep = 1.25;
    private static readonly PdfViewerOptions DefaultOptions = new();

    /// <summary>The controller used when the application doesn't pass one, which only the toolbar reaches.</summary>
    private readonly PdfViewerController _ownController = new();
    private ElementReference _host;
    private IJSObjectReference? _module;
    private IJSObjectReference? _bridge;
    private DotNetObjectReference<ViewerNotifications>? _notifications;
    private PdfViewerController? _attachedController;
    private PdfSource? _openedSource;
    private PdfViewerOptions? _sentOptions;
    private ViewerSubscriptions _sentSubscriptions;
    /// <summary>
    /// The objects the browser has, as far as .NET knows: those last sent, with the user's changes since.
    /// </summary>
    private Dictionary<string, ViewerObject> _knownObjects = [];
    /// <summary>The sequence of the latest change the browser has reported.</summary>
    private long _lastSequence;
    /// <summary>
    /// Whether a document has been asked for and hasn't loaded yet. Object changes arriving meanwhile were made in the
    /// document before it, which has gone.
    /// </summary>
    private bool _awaitingDocument;
    private bool _disposed;

    [Inject] private IJSRuntime JS { get; set; } = default!;

    /// <summary>The document to display. Setting an equivalent source doesn't reopen it.</summary>
    [Parameter] public PdfSource? Source { get; set; }

    /// <summary>
    /// The page to show when a document opens. Changing it doesn't move a document that's already open, so use
    /// <see cref="PdfViewerController.GoToPageAsync"/> for that.
    /// </summary>
    [Parameter] public int InitialPage { get; set; } = 1;

    [Parameter] public bool ShowToolbar { get; set; } = true;

    /// <summary>
    /// How the viewer behaves. Changing it takes effect at once, without ending a gesture in progress.
    /// </summary>
    [Parameter] public PdfViewerOptions? Options { get; set; }

    /// <summary>
    /// Drives the viewer from code. Without one, the viewer uses its own, which only its toolbar reaches. Give each
    /// viewer its own controller.
    /// </summary>
    [Parameter] public PdfViewerController? Controller { get; set; }

    /// <summary>
    /// The objects to display, or null to leave them to the browser. The list is the source of truth: whenever it
    /// differs from what the viewer has, the difference goes to the browser in one call, so a change of one object in a
    /// thousand sends one object. Handle <see cref="OnObjectsChanged"/> and apply the user's changes to your list, or
    /// the next render undoes them. Apply them before the handler first awaits, because awaiting renders.
    /// </summary>
    [Parameter] public IReadOnlyCollection<ViewerObject>? Objects { get; set; }

    /// <summary>Raised when the document has opened, which can be before its first page has painted.</summary>
    [Parameter] public EventCallback<DocumentLoadedArgs> OnDocumentLoaded { get; set; }

    [Parameter] public EventCallback<int> OnPageChanged { get; set; }

    [Parameter] public EventCallback<ViewerError> OnError { get; set; }

    /// <summary>
    /// Raised when the user draws, moves, resizes or deletes objects, once the gesture has finished and never during a
    /// drag. Changes your own code makes through <see cref="Objects"/> aren't reported. The user's changes cross the
    /// circuit only while this has a handler or <see cref="Objects"/> is set.
    /// </summary>
    [Parameter] public EventCallback<ObjectsChangedArgs> OnObjectsChanged { get; set; }

    /// <summary>
    /// Raised when the selection changes, whoever changed it. Changes cross the circuit only while it has a handler.
    /// </summary>
    [Parameter] public EventCallback<SelectionChangedArgs> OnSelectionChanged { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private PdfViewerController ActiveController => Controller ?? _ownController;

    private PdfViewerOptions CurrentOptions => Options ?? DefaultOptions;

    /// <summary>
    /// With <see cref="Objects"/> set, the user's changes are needed even without a handler, to know what the browser
    /// has.
    /// </summary>
    private ViewerSubscriptions CurrentSubscriptions =>
        new(OnObjectsChanged.HasDelegate || Objects is not null, OnSelectionChanged.HasDelegate);

    protected override async Task OnParametersSetAsync()
    {
        // Until the first render has attached, there's nothing to update, and attaching sends the latest parameters.
        if (_bridge is null)
        {
            return;
        }
        var previous = _attachedController;
        if (previous is null || previous == ActiveController)
        {
            await SendChangesAsync(_bridge);
            return;
        }
        // The new controller takes the state at once, because detaching resets the old one's. As on the first render,
        // its waiting commands run only after any new source has started opening, so they apply to that document.
        var next = _attachedController = ActiveController;
        next.SetState(previous.PageCount, previous.CurrentPage);
        previous.Detach(this);
        await SendChangesAsync(_bridge);
        // If the viewer was disposed or swapped controllers again during the wait, this controller never takes over
        // and gives up the state it was handed.
        if (_disposed || _attachedController != next)
        {
            next.SetState(0, 0);
            return;
        }
        next.Attach(this, _bridge);
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender)
        {
            return;
        }
        _notifications = DotNetObjectReference.Create(new ViewerNotifications(this));
        _module = await JS.InvokeAsync<IJSObjectReference>("import", ModulePath);
        // Disposing during an await here finds nothing to release yet, so whatever arrived afterward is released here.
        if (_disposed)
        {
            await ReleaseAsync(null, _module);
            return;
        }
        _sentOptions = CurrentOptions;
        _sentSubscriptions = CurrentSubscriptions;
        var bridge = await _module.InvokeAsync<IJSObjectReference>("attach", _host, _notifications, _sentOptions,
            _sentSubscriptions);
        if (_disposed)
        {
            await ReleaseAsync(bridge, null);
            return;
        }
        _bridge = bridge;
        // Parameters can change while attaching, so anything that changed since goes now. The source opens before the
        // controller's waiting commands run, so they apply to the document being opened.
        await SendChangesAsync(bridge);
        if (!_disposed)
        {
            _attachedController = ActiveController;
            _attachedController.Attach(this, bridge);
        }
    }

    /// <summary>Sends whatever changed since it was last sent, stopping if the viewer is disposed meanwhile.</summary>
    private async Task SendChangesAsync(IJSObjectReference bridge)
    {
        if (!_disposed && CurrentOptions != _sentOptions)
        {
            _sentOptions = CurrentOptions;
            await bridge.InvokeVoidAsync("configure", _sentOptions);
        }
        if (!_disposed && CurrentSubscriptions != _sentSubscriptions)
        {
            _sentSubscriptions = CurrentSubscriptions;
            await bridge.InvokeVoidAsync("subscribe", _sentSubscriptions);
        }
        if (!_disposed && (Source is null ? _openedSource is not null : !Source.Equals(_openedSource)))
        {
            _openedSource = Source;
            // Opening or closing ends the document on display at once, so there's nothing to wait for. It also clears
            // the browser's objects, so whatever the list holds is sent again for the next document.
            ActiveController.SetState(0, 0);
            _knownObjects = [];
            _awaitingDocument = true;
            if (Source is null)
            {
                await bridge.InvokeVoidAsync("close");
            }
            else
            {
                await bridge.InvokeVoidAsync("open", Source.ToInterop(), InitialPage);
            }
        }
        if (!_disposed && Objects is not null && TakeObjectChanges(Objects) is { } batch)
        {
            await bridge.InvokeVoidAsync("applyObjects", batch);
        }
    }

    /// <summary>
    /// Works out what the browser needs so that its objects match the list, and counts it as sent. Returns null when
    /// nothing differs.
    /// </summary>
    private ObjectBatch? TakeObjectChanges(IReadOnlyCollection<ViewerObject> objects)
    {
        var wanted = new Dictionary<string, ViewerObject>(objects.Count);
        foreach (var viewerObject in objects)
        {
            if (!wanted.TryAdd(viewerObject.Id, viewerObject))
            {
                throw new InvalidOperationException(
                    $"The Objects list has more than one object with the ID \"{viewerObject.Id}\".");
            }
        }
        var upsert = wanted.Values
            .Where(wantedObject => !wantedObject.Equals(_knownObjects.GetValueOrDefault(wantedObject.Id)))
            .ToList();
        var remove = _knownObjects.Keys.Where(id => !wanted.ContainsKey(id)).ToList();
        _knownObjects = wanted;
        return upsert.Count == 0 && remove.Count == 0 ? null : new ObjectBatch(upsert, remove, _lastSequence);
    }

    internal Task HandleChangesAsync(ChangesNotification notification)
    {
        _lastSequence = notification.Sequence;
        var objectsHandled = Task.CompletedTask;
        if (notification.Objects is { } changes && !_awaitingDocument)
        {
            // Recorded before the handler runs, so when it writes the user's changes into its own list, the list
            // matches what the browser has and nothing is sent back.
            foreach (var viewerObject in changes.Added.Concat(changes.Updated.Select(update => update.Object)))
            {
                _knownObjects[viewerObject.Id] = viewerObject;
            }
            foreach (var viewerObject in changes.Removed)
            {
                _knownObjects.Remove(viewerObject.Id);
            }
            objectsHandled = RaiseAsync(OnObjectsChanged,
                new ObjectsChangedArgs(notification.Sequence, changes.Added, changes.Updated, changes.Removed));
        }
        // Raised without waiting for the objects handler, which may wait on the user for a long time. Otherwise this
        // selection would be held back and arrive after newer ones.
        var selectionHandled = notification.Selection is var (origin, primaryId, count)
            ? RaiseAsync(OnSelectionChanged, new SelectionChangedArgs(notification.Sequence, origin, primaryId, count))
            : Task.CompletedTask;
        return Task.WhenAll(objectsHandled, selectionHandled);
    }

    /// <summary>
    /// Raises a callback so that a handler that throws before its first await faults the returned task instead of
    /// throwing to this caller.
    /// </summary>
    private static async Task RaiseAsync<TArgs>(EventCallback<TArgs> callback, TArgs args) =>
        await callback.InvokeAsync(args);

    internal async Task HandleDocumentLoadedAsync(DocumentLoadedNotification notification)
    {
        _awaitingDocument = false;
        ActiveController.SetState(notification.PageCount, notification.Page);
        await OnDocumentLoaded.InvokeAsync(new DocumentLoadedArgs(notification.PageCount));
        StateHasChanged();
    }

    internal async Task HandlePageChangedAsync(PageChangedArgs args)
    {
        ActiveController.SetState(ActiveController.PageCount, args.Page);
        await OnPageChanged.InvokeAsync(args.Page);
        StateHasChanged();
    }

    internal async Task HandleErrorAsync(ViewerError error)
    {
        if (error.DocumentClosed)
        {
            ActiveController.SetState(0, 0);
        }
        await OnError.InvokeAsync(error);
        StateHasChanged();
    }

    /// <summary>
    /// The custom element destroys the document itself when it leaves the page, which also works if the circuit is
    /// already gone. This only disconnects the .NET side.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        _disposed = true;
        _attachedController?.Detach(this);
        await ReleaseAsync(_bridge, _module);
        _notifications?.Dispose();
        GC.SuppressFinalize(this);
    }

    private static async Task ReleaseAsync(IJSObjectReference? bridge, IJSObjectReference? module)
    {
        try
        {
            if (bridge is not null)
            {
                await bridge.InvokeVoidAsync("dispose");
                await bridge.DisposeAsync();
            }
            if (module is not null)
            {
                await module.DisposeAsync();
            }
        }
        catch (JSDisconnectedException)
        {
            // The circuit is gone, and the browser side cleans up after itself.
        }
    }
}
