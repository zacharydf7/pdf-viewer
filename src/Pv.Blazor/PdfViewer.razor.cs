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

    /// <summary>Raised when the document has opened, which can be before its first page has painted.</summary>
    [Parameter] public EventCallback<DocumentLoadedArgs> OnDocumentLoaded { get; set; }

    [Parameter] public EventCallback<int> OnPageChanged { get; set; }

    [Parameter] public EventCallback<ViewerError> OnError { get; set; }

    /// <summary>
    /// Raised when an object is added. This and the other object callbacks (<see cref="OnObjectUpdated"/>,
    /// <see cref="OnObjectRemoved"/> and <see cref="OnObjectsReplaced"/>) are raised when a change finishes, never
    /// during a drag. Check the origin to tell user edits from your own. Object changes cross the circuit only while at
    /// least one of the four has a handler.
    /// </summary>
    [Parameter] public EventCallback<ObjectAddedArgs> OnObjectAdded { get; set; }

    /// <summary>Raised when an object changes, with the object as it was before.</summary>
    [Parameter] public EventCallback<ObjectUpdatedArgs> OnObjectUpdated { get; set; }

    [Parameter] public EventCallback<ObjectRemovedArgs> OnObjectRemoved { get; set; }

    /// <summary>Raised when every object is replaced in one step.</summary>
    [Parameter] public EventCallback<ObjectsReplacedArgs> OnObjectsReplaced { get; set; }

    /// <summary>
    /// Raised when the selection changes. As with the object callbacks, changes cross the circuit only while it has a
    /// handler.
    /// </summary>
    [Parameter] public EventCallback<SelectionChangedArgs> OnSelectionChanged { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private PdfViewerController ActiveController => Controller ?? _ownController;

    private PdfViewerOptions CurrentOptions => Options ?? DefaultOptions;

    private ViewerSubscriptions CurrentSubscriptions => new(
        OnObjectAdded.HasDelegate || OnObjectUpdated.HasDelegate || OnObjectRemoved.HasDelegate
            || OnObjectsReplaced.HasDelegate,
        OnSelectionChanged.HasDelegate);

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
            // Opening or closing ends the document on display at once, so there's nothing to wait for.
            ActiveController.SetState(0, 0);
            if (Source is null)
            {
                await bridge.InvokeVoidAsync("close");
            }
            else
            {
                await bridge.InvokeVoidAsync("open", Source.ToInterop(), InitialPage);
            }
        }
    }

    internal async Task HandleDocumentLoadedAsync(DocumentLoadedNotification notification)
    {
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
