using System.Text.Json;
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
    private const long MaximumSelectionSize = 64L * 1024 * 1024;

    private ElementReference _host;
    private IJSObjectReference? _module;
    private IJSObjectReference? _bridge;
    private DotNetObjectReference<PdfViewer>? _reference;
    private PdfSource? _openedSource;
    private int _currentPage = 1;
    private int _pageCount;
    private PageRotation _rotation;

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
    /// Raised when an object is added. This and the other object callbacks (<see cref="OnObjectUpdated"/>,
    /// <see cref="OnObjectRemoved"/> and <see cref="OnObjectsReplaced"/>) are raised when a change finishes, never
    /// during a drag. Check the origin to tell user edits from your own. Set them before the first render, because
    /// object changes are only sent to .NET if at least one of the four had a handler by then.
    /// </summary>
    [Parameter] public EventCallback<ObjectAddedArgs> OnObjectAdded { get; set; }

    /// <summary>Raised when an object changes, with the object as it was before.</summary>
    [Parameter] public EventCallback<ObjectUpdatedArgs> OnObjectUpdated { get; set; }

    [Parameter] public EventCallback<ObjectRemovedArgs> OnObjectRemoved { get; set; }

    /// <summary>Raised when every object is replaced in one step.</summary>
    [Parameter] public EventCallback<ObjectsReplacedArgs> OnObjectsReplaced { get; set; }

    /// <summary>
    /// Raised when the selection changes. As with the object callbacks, set this before the first render.
    /// </summary>
    [Parameter] public EventCallback<SelectionChangedArgs> OnSelectionChanged { get; set; }

    [Parameter(CaptureUnmatchedValues = true)]
    public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }

    private bool NoDocument => _pageCount == 0;

    public int CurrentPage => _currentPage;

    public int PageCount => _pageCount;

    public Task GoToPageAsync(int page) => InvokeBridgeAsync("goToPage", page);

    public Task SetZoomAsync(double scale) => InvokeBridgeAsync("setZoom", scale);

    public Task SetZoomAsync(ViewerZoomMode mode) => InvokeBridgeAsync("setZoom", mode);

    /// <summary>Sets the viewing rotation, which is added to any rotation the page already has.</summary>
    public Task SetRotationAsync(PageRotation rotation)
    {
        ThrowIfUndefined(rotation);
        _rotation = rotation;
        return InvokeBridgeAsync("setRotation", (int)rotation);
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
        return InvokeBridgeAsync("setPageRotation", page, (int?)rotation);
    }

    /// <summary>
    /// A page's label, and its size and rotation in the coordinates objects use, whether or not it's displayed.
    /// </summary>
    public async Task<PageInfo> GetPageInfoAsync(int page, CancellationToken cancellationToken = default)
    {
        var bridge = _bridge ?? throw NotReady();
        return await bridge.InvokeAsync<PageInfo>("getPageInfo", cancellationToken, page);
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

    /// <summary>Selects one object, or none when given null.</summary>
    public Task SelectObjectAsync(string? id) => SelectObjectsAsync(id is null ? [] : [id]);

    /// <summary>Selects exactly these objects. Handles appear only when one object is selected.</summary>
    public Task SelectObjectsAsync(IEnumerable<string> ids) => InvokeBridgeAsync("selectObjects", ids);

    /// <summary>
    /// Every selected object's ID, in the order selected, as the selection is when the browser answers. That can be
    /// newer than the <see cref="OnSelectionChanged"/> notification being handled. The IDs cross the circuit as a
    /// stream, so a large selection needs no change to the hub's message size limit.
    /// </summary>
    public async Task<IReadOnlyList<string>> GetSelectedObjectIdsAsync(CancellationToken cancellationToken = default)
    {
        var bridge = _bridge ?? throw NotReady();
        await using var data =
            await bridge.InvokeAsync<IJSStreamReference>("getSelectedObjectIds", cancellationToken, []);
        await using var source = await data.OpenReadStreamAsync(MaximumSelectionSize, cancellationToken);
        return await JsonSerializer.DeserializeAsync<string[]>(source, cancellationToken: cancellationToken) ?? [];
    }

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
        var objects = OnObjectAdded.HasDelegate || OnObjectUpdated.HasDelegate || OnObjectRemoved.HasDelegate
            || OnObjectsReplaced.HasDelegate;
        var subscriptions = new { objects, selection = OnSelectionChanged.HasDelegate };
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

    /// <summary>An integer cast to the enum can hold any number, and only quarter turns are rotations.</summary>
    private static void ThrowIfUndefined(PageRotation rotation)
    {
        if (!Enum.IsDefined(rotation))
        {
            throw new ArgumentOutOfRangeException(nameof(rotation), rotation, "Rotation must be a quarter turn.");
        }
    }

    private Task ZoomByAsync(double factor) => InvokeBridgeAsync("zoomBy", factor);

    private Task RotateClockwiseAsync() => SetRotationAsync((PageRotation)(((int)_rotation + 90) % 360));

    private async Task InvokeBridgeAsync(string method, params object?[] arguments)
    {
        var bridge = _bridge ?? throw NotReady();
        await bridge.InvokeVoidAsync(method, arguments);
    }

    private static InvalidOperationException NotReady() =>
        new("The viewer isn't ready yet. Call this after the component's first render.");

    [JSInvokable]
    public async Task NotifyDocumentLoaded(DocumentLoadedArgs args)
    {
        _pageCount = args.PageCount;
        _currentPage = Math.Clamp(InitialPage, 1, Math.Max(args.PageCount, 1));
        await OnDocumentLoaded.InvokeAsync(args);
        StateHasChanged();
    }

    [JSInvokable]
    public async Task NotifyPageChanged(PageChangedArgs args)
    {
        _currentPage = args.Page;
        await OnPageChanged.InvokeAsync(args.Page);
        StateHasChanged();
    }

    [JSInvokable]
    public async Task NotifyError(ViewerError error)
    {
        if (error.DocumentClosed)
        {
            ResetPosition();
        }
        await OnError.InvokeAsync(error);
        StateHasChanged();
    }

    [JSInvokable]
    public Task NotifyObjectAdded(ObjectAddedArgs args) => OnObjectAdded.InvokeAsync(args);

    [JSInvokable]
    public Task NotifyObjectUpdated(ObjectUpdatedArgs args) => OnObjectUpdated.InvokeAsync(args);

    [JSInvokable]
    public Task NotifyObjectRemoved(ObjectRemovedArgs args) => OnObjectRemoved.InvokeAsync(args);

    [JSInvokable]
    public Task NotifyObjectsReplaced(ObjectsReplacedArgs args) => OnObjectsReplaced.InvokeAsync(args);

    [JSInvokable]
    public Task NotifySelectionChanged(SelectionChangedArgs args) => OnSelectionChanged.InvokeAsync(args);

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
