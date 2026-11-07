using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace Pv.Blazor;

/// <summary>
/// Displays a PDF. Scrolling, zooming, rendering and dragging all run in the browser, so they keep working at full
/// speed over a slow circuit. Only commands and finished changes cross it.
/// </summary>
public partial class PdfViewer
{
    private const string ModulePath = "./_content/Pv.Blazor/pv.js";
    private const double ZoomStep = 1.25;
    private const long DefaultMaximumDocumentSize = 1024L * 1024 * 1024;

    private ElementReference _host;
    private IJSObjectReference? _module;
    private IJSObjectReference? _bridge;
    private DotNetObjectReference<PdfViewer>? _reference;
    private PdfSource? _openedSource;
    private int _currentPage = 1;
    private int _pageCount;
    private int _rotation;

    [Inject] private IJSRuntime JS { get; set; } = default!;

    /// <summary>The document to display. Setting an equivalent source doesn't reopen it.</summary>
    [Parameter] public PdfSource? Source { get; set; }

    /// <summary>
    /// The page to show when a document opens. Changing it doesn't move a document that's already open, so use
    /// <see cref="GoToPageAsync"/> for that.
    /// </summary>
    [Parameter] public int InitialPage { get; set; } = 1;

    [Parameter] public bool ShowToolbar { get; set; } = true;

    /// <summary>The zoom to start with. Read once, at first render.</summary>
    [Parameter] public ViewerZoomMode InitialZoom { get; set; } = ViewerZoomMode.FitWidth;

    /// <summary>
    /// Leaves form fields unpainted, while other annotations still appear. Read once, at first render.
    /// </summary>
    [Parameter] public bool HideFormFields { get; set; }

    /// <summary>
    /// Whether arrow keys and Delete edit the focused object. Turn this off if your application handles those keys, for
    /// example to record undo history. Read once, at first render.
    /// </summary>
    [Parameter] public bool KeyboardEditing { get; set; } = true;

    /// <summary>
    /// Rounds rectangles the user creates or changes to whole page units. Read once, at first render.
    /// </summary>
    [Parameter] public bool RoundCoordinates { get; set; }

    /// <summary>Whether Ctrl+wheel and pinch gestures zoom. Read once, at first render.</summary>
    [Parameter] public bool WheelZoom { get; set; } = true;

    /// <summary>What object rectangles are measured against. Read once, at first render.</summary>
    [Parameter] public ViewerCoordinates Coordinates { get; set; } = ViewerCoordinates.Page;

    /// <summary>Where objects catch the pointer. Read once, at first render.</summary>
    [Parameter] public ViewerObjectHitArea ObjectHitArea { get; set; } = ViewerObjectHitArea.Fill;

    /// <summary>Raised when the document has opened, which can be before its first page has painted.</summary>
    [Parameter] public EventCallback<DocumentLoadedArgs> OnDocumentLoaded { get; set; }

    [Parameter] public EventCallback<int> OnPageChanged { get; set; }

    [Parameter] public EventCallback<ViewerError> OnError { get; set; }

    /// <summary>
    /// Raised when a change finishes, never during a drag. Check the origin to tell user edits from your own. Set this
    /// before the first render, because changes are only sent to .NET if a handler was set by then.
    /// </summary>
    [Parameter] public EventCallback<ViewerObjectChange> OnObjectChanged { get; set; }

    /// <summary>
    /// Raised when the selection changes. As with <see cref="OnObjectChanged"/>, set this before the first render.
    /// </summary>
    [Parameter] public EventCallback<ViewerSelectionChange> OnSelectionChanged { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private bool NoDocument => _pageCount == 0;

    public int CurrentPage => _currentPage;

    public int PageCount => _pageCount;

    public Task GoToPageAsync(int page) => InvokeBridgeAsync("goToPage", page);

    public Task SetZoomAsync(double scale) => InvokeBridgeAsync("setZoom", scale);

    public Task SetZoomAsync(ViewerZoomMode mode) => InvokeBridgeAsync("setZoom", mode);

    /// <summary>Sets the viewing rotation in degrees, which is added to any rotation the page already has.</summary>
    public Task SetRotationAsync(int degrees)
    {
        ThrowIfNotQuarterTurn(degrees);
        _rotation = degrees;
        return InvokeBridgeAsync("setRotation", degrees);
    }

    /// <summary>
    /// Sets the rotation one page ends up with, replacing both its own rotation and the viewing rotation. Pass null to
    /// return to its own rotation plus the viewing rotation. The result doesn't depend on any rotation the page already
    /// has.
    /// </summary>
    public Task SetPageRotationAsync(int page, int? degrees)
    {
        if (degrees is { } value)
        {
            ThrowIfNotQuarterTurn(value);
        }
        return InvokeBridgeAsync("setPageRotation", page, degrees);
    }

    public Task SetToolAsync(ViewerTool tool, ViewerDrawDefaults? drawDefaults = null) =>
        InvokeBridgeAsync("setTool", tool, drawDefaults);

    /// <summary>
    /// Copies the original document to a stream, such as an upload to your own storage. The bytes cross the circuit in
    /// chunks, so this needs no change to the hub's message size limit, but it's still slower than sending them over
    /// HTTP.
    /// </summary>
    public async Task CopyDocumentToAsync(Stream destination, long maximumSize = DefaultMaximumDocumentSize,
        CancellationToken cancellationToken = default)
    {
        var bridge = _bridge ?? throw NotReady();
        await using var data =
            await bridge.InvokeAsync<IJSStreamReference>("getDocumentData", cancellationToken, []);
        await using var source = await data.OpenReadStreamAsync(maximumSize, cancellationToken);
        await source.CopyToAsync(destination, cancellationToken);
    }

    public Task AddObjectAsync(ViewerObject viewerObject) => InvokeBridgeAsync("addObject", viewerObject);

    public Task UpdateObjectAsync(ViewerObject viewerObject) => InvokeBridgeAsync("updateObject", viewerObject);

    public Task RemoveObjectAsync(string id) => InvokeBridgeAsync("removeObject", id);

    /// <summary>Replaces every object in one step, which is cheaper than many separate changes.</summary>
    public Task SetObjectsAsync(IEnumerable<ViewerObject> objects) => InvokeBridgeAsync("setObjects", objects);

    public Task SelectObjectAsync(string? id) => InvokeBridgeAsync("selectObject", id);

    protected override async Task OnParametersSetAsync()
    {
        if (_bridge is not null)
        {
            await OpenSourceIfChangedAsync();
        }
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender)
        {
            return;
        }
        _reference = DotNetObjectReference.Create(this);
        _module = await JS.InvokeAsync<IJSObjectReference>("import", ModulePath);
        var options = new
        {
            initialZoom = InitialZoom,
            hideFormFields = HideFormFields,
            keyboardEditing = KeyboardEditing,
            roundCoordinates = RoundCoordinates,
            wheelZoom = WheelZoom,
            coordinates = Coordinates,
            objectHitArea = ObjectHitArea,
        };
        var subscriptions = new { objects = OnObjectChanged.HasDelegate, selection = OnSelectionChanged.HasDelegate };
        _bridge = await _module.InvokeAsync<IJSObjectReference>("attach", _host, _reference, options, subscriptions);
        await OpenSourceIfChangedAsync();
    }

    private async Task OpenSourceIfChangedAsync()
    {
        if (Source is null ? _openedSource is null : Source.Equals(_openedSource))
        {
            return;
        }
        _openedSource = Source;
        ResetPosition();
        if (Source is null)
        {
            await InvokeBridgeAsync("close");
        }
        else
        {
            await InvokeBridgeAsync("open", Source.ToInterop(), InitialPage);
        }
    }

    private void ResetPosition()
    {
        _pageCount = 0;
        _currentPage = 1;
    }

    private static void ThrowIfNotQuarterTurn(int degrees)
    {
        if (degrees % 90 != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(degrees), degrees, "Rotation must be a multiple of 90 degrees.");
        }
    }

    private Task ZoomByAsync(double factor) => InvokeBridgeAsync("zoomBy", factor);

    private Task RotateClockwiseAsync() => SetRotationAsync((_rotation + 90) % 360);

    private async Task InvokeBridgeAsync(string method, params object?[] arguments)
    {
        var bridge = _bridge ?? throw NotReady();
        await bridge.InvokeVoidAsync(method, arguments);
    }

    private static InvalidOperationException NotReady() =>
        new("The viewer isn't ready yet. Call this after the component's first render.");

    [JSInvokable]
    public async Task NotifyDocumentLoaded(int pageCount)
    {
        _pageCount = pageCount;
        _currentPage = Math.Clamp(InitialPage, 1, Math.Max(pageCount, 1));
        await OnDocumentLoaded.InvokeAsync(new DocumentLoadedArgs(pageCount));
        StateHasChanged();
    }

    [JSInvokable]
    public async Task NotifyPageChanged(int page)
    {
        _currentPage = page;
        await OnPageChanged.InvokeAsync(page);
        StateHasChanged();
    }

    [JSInvokable]
    public async Task NotifyError(string code, string message, bool documentFailed)
    {
        if (documentFailed)
        {
            ResetPosition();
        }
        await OnError.InvokeAsync(new ViewerError(code, message));
        StateHasChanged();
    }

    [JSInvokable]
    public Task NotifyObjectChanged(ViewerObjectChange change) => OnObjectChanged.InvokeAsync(change);

    [JSInvokable]
    public Task NotifySelectionChanged(ViewerSelectionChange change) => OnSelectionChanged.InvokeAsync(change);

    /// <summary>
    /// The custom element destroys the document itself when it leaves the page, which also works if the circuit is
    /// already gone. This only disconnects the .NET side.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_bridge is not null)
            {
                await _bridge.InvokeVoidAsync("dispose");
                await _bridge.DisposeAsync();
            }
            if (_module is not null)
            {
                await _module.DisposeAsync();
            }
        }
        catch (JSDisconnectedException)
        {
            // The circuit is gone, and the browser side cleans up after itself.
        }
        _reference?.Dispose();
        GC.SuppressFinalize(this);
    }
}
