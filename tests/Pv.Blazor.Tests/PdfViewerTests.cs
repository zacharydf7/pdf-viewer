using System.Reflection;
using Bunit;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Rendering;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.JSInterop;

namespace Pv.Blazor.Tests;

public class PdfViewerTests : BunitContext
{
    private const string ModulePath = "./_content/Pv.Blazor/pv.js";
    private readonly BunitJSModuleInterop _module;
    private readonly BunitJSModuleInterop _bridge;

    /// <summary>The JSON settings Blazor reads interop arguments with.</summary>
    private static readonly System.Text.Json.JsonSerializerOptions InteropJson =
        new(System.Text.Json.JsonSerializerDefaults.Web);

    /// <summary>Stands in for the bytes JavaScript returns, which .NET reads as a stream.</summary>
    private sealed class JsonStream(string json) : IJSStreamReference
    {
        public long Length => json.Length;

        public ValueTask<Stream> OpenReadStreamAsync(long maxAllowedSize = 512000,
            CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<Stream>(new MemoryStream(System.Text.Encoding.UTF8.GetBytes(json)));

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    /// <summary>
    /// Stands in for the browser: imports a module whose attach call returns <paramref name="bridge"/> once that task
    /// completes. bUnit's own interop can't hold attach back, and records calls later than they're sent.
    /// </summary>
    private sealed class StubRuntime(Task<IJSObjectReference> bridge) : IJSRuntime, IJSObjectReference
    {
        public async ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) =>
            identifier == "import" ? (TValue)(object)this : (TValue)await bridge;

        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, CancellationToken cancellationToken,
            object?[]? args) => InvokeAsync<TValue>(identifier, args);

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    /// <summary>A bridge that records each call as it's made, which is when a real circuit sends it.</summary>
    private sealed class RecordingBridge : IJSObjectReference
    {
        public List<string> Calls { get; } = [];

        /// <summary>The arguments of each call, in the same order as <see cref="Calls"/>.</summary>
        public List<object?[]> Arguments { get; } = [];

        /// <summary>
        /// Holds back the answer to every call of a method until a task completes, like a slow circuit.
        /// </summary>
        public (string Method, Task Answered)? Held { get; set; }

        public async ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args)
        {
            Calls.Add(identifier);
            Arguments.Add(args ?? []);
            if (Held is { } held && held.Method == identifier)
            {
                await held.Answered;
            }
            return default!;
        }

        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, CancellationToken cancellationToken,
            object?[]? args) => InvokeAsync<TValue>(identifier, args);

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    /// <summary>
    /// An application page that owns the list its viewer displays, and keeps a drawn object once its button is
    /// clicked, as a dialog would. Like any component, it renders again after its handlers, which is what sends the
    /// viewer the changed list.
    /// </summary>
    private sealed class DrawingPage : ComponentBase
    {
        private readonly List<ViewerObject> _objects = [];
        private readonly TaskCompletionSource _confirmed = new();
        private PdfViewerOptions _options = new();

        /// <summary>Whether keeping the object also changes an option, which the viewer sends first.</summary>
        [Parameter] public bool ChangeOptionsOnKeep { get; set; }

        protected override void BuildRenderTree(RenderTreeBuilder builder)
        {
            builder.OpenElement(0, "button");
            builder.AddAttribute(1, "onclick", EventCallback.Factory.Create(this, _confirmed.SetResult));
            builder.CloseElement();
            builder.OpenComponent<PdfViewer>(2);
            builder.AddComponentParameter(3, nameof(PdfViewer.Objects), _objects);
            builder.AddComponentParameter(4, nameof(PdfViewer.OnObjectDrawn),
                EventCallback.Factory.Create<ObjectDrawnArgs>(this, KeepOnceConfirmedAsync));
            builder.AddComponentParameter(5, nameof(PdfViewer.Options), _options);
            builder.CloseComponent();
        }

        private async Task KeepOnceConfirmedAsync(ObjectDrawnArgs args)
        {
            await _confirmed.Task;
            _objects.Add(args.Object);
            if (ChangeOptionsOnKeep)
            {
                _options = new() { WheelZoom = false };
            }
        }
    }

    public PdfViewerTests()
    {
        // Strict mode fails any JavaScript call a test didn't plan for.
        JSInterop.Mode = JSRuntimeMode.Strict;
        _module = JSInterop.SetupModule(ModulePath);
        _bridge = _module.SetupModule("attach", _ => true);
        _bridge.SetupVoid(_ => true).SetVoidResult();
    }

    /// <summary>What JavaScript notifies, as the viewer handed it over when attaching.</summary>
    private ViewerNotifications Notifications =>
        Assert.IsType<DotNetObjectReference<ViewerNotifications>>(AttachArgument(1)).Value;

    private object? AttachArgument(int index) => Assert.Single(_module.Invocations["attach"]).Arguments[index];

    private IEnumerable<string> BridgeCalls => _bridge.Invocations.Select(call => call.Identifier);

    /// <summary>Every batch of objects sent to the browser, in order.</summary>
    private IEnumerable<ObjectBatch> SentBatches => _bridge.Invocations
        .Where(call => call.Identifier == "applyObjects")
        .Select(call => Assert.IsType<ObjectBatch>(call.Arguments[0]));

    /// <summary>Objects on every page, each with its own ID and rectangle.</summary>
    private static ViewerObject[] ManyObjects(int count) =>
    [
        .. Enumerable.Range(0, count)
            .Select(index => new ViewerObject($"object-{index}", null, new PageRect(index, 0, 10, 10))),
    ];

    private static ChangesNotification UserMoved(long sequence, ViewerObject from, ViewerObject to) =>
        new(sequence, new ObjectChanges([], [new ObjectUpdate(to, from, EditGesture.Move)], []), null);

    [Fact]
    public void PdfViewer_ShouldOpenSourceAtInitialPage_WhenFirstRendered()
    {
        Render<PdfViewer>(parameters => parameters
            .Add(viewer => viewer.Source, "/a.pdf")
            .Add(viewer => viewer.InitialPage, 3));

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("open", call.Identifier);
        Assert.Equal(3, call.Arguments[1]);
    }

    [Fact]
    public void PdfViewer_ShouldRenderEmptyHostElement_WhenRendered()
    {
        var viewer = Render<PdfViewer>();

        Assert.Empty(viewer.Find("pdf-viewer").Children);
    }

    [Fact]
    public void PdfViewer_ShouldNotOpenAnything_WhenSourceIsNull()
    {
        Render<PdfViewer>();

        Assert.Empty(_bridge.Invocations);
    }

    [Fact]
    public void PdfViewer_ShouldNotReopen_WhenGivenEquivalentSource()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Source, "/a.pdf"));

        viewer.Render(parameters => parameters.Add(component => component.Source, "/a.pdf"));

        Assert.Single(_bridge.Invocations);
    }

    [Fact]
    public void PdfViewer_ShouldOpenAgain_WhenSourceChanges()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Source, "/a.pdf"));

        viewer.Render(parameters => parameters.Add(component => component.Source, "/b.pdf"));

        Assert.Equal(["open", "open"], BridgeCalls);
    }

    [Fact]
    public void Toolbar_ShouldNotRender_WhenShowToolbarIsFalse()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.ShowToolbar, false));

        Assert.Empty(viewer.FindAll("[role=toolbar]"));
    }

    [Fact]
    public async Task Toolbar_ShouldShowPositionTheViewerReports_WhenDocumentLoads()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.InitialPage, 9));

        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 5)));

        Assert.Equal("Page 5 of 5", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public async Task Toolbar_ShouldDisablePreviousButton_WhenOnFirstPage()
    {
        var viewer = Render<PdfViewer>();

        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 1)));

        Assert.True(viewer.Find("[aria-label='Previous page']").HasAttribute("disabled"));
        Assert.False(viewer.Find("[aria-label='Next page']").HasAttribute("disabled"));
    }

    [Fact]
    public async Task NextButton_ShouldGoToFollowingPage_WhenClicked()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 1)));

        await viewer.Find("[aria-label='Next page']").ClickAsync(new());

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("goToPage", call.Identifier);
        Assert.Equal(2, call.Arguments[0]);
    }

    [Fact]
    public async Task RotateButton_ShouldSendQuarterTurn_WhenClicked()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 1)));

        await viewer.Find("[aria-label='Rotate clockwise']").ClickAsync(new());

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("rotateBy", call.Identifier);
        Assert.Equal(90, call.Arguments[0]);
    }

    [Fact]
    public async Task OnObjectsChanged_ShouldReceiveWhatUserChanged_WhenBridgeNotifies()
    {
        ObjectsChangedArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectsChanged, args => received = args));
        var previous = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));
        var update = new ObjectUpdate(previous with { Rect = new PageRect(5, 2, 3, 4) }, previous, EditGesture.Move);
        var drawn = new ViewerObject("b", null, new PageRect(1, 1, 9, 9));
        var removed = new ViewerObject("c", 2, new PageRect(1, 1, 9, 9));
        var changes = new ChangesNotification(7, new ObjectChanges([drawn], [update], [removed]), null);

        await viewer.InvokeAsync(() => Notifications.NotifyChanges(changes));

        Assert.Equal(7, received!.Sequence);
        Assert.Equal([drawn], received.Added);
        Assert.Equal([update], received.Updated);
        Assert.Equal([removed], received.Removed);
    }

    [Fact]
    public async Task OnSelectionChanged_ShouldReceiveSelection_WhenBridgeNotifies()
    {
        SelectionChangedArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnSelectionChanged, args => received = args));
        var changes = new ChangesNotification(4, null, new SelectionState(ChangeOrigin.Api, "b", 2));

        await viewer.InvokeAsync(() => Notifications.NotifyChanges(changes));

        Assert.Equal(new SelectionChangedArgs(4, ChangeOrigin.Api, "b", 2), received);
    }

    [Fact]
    public void ChangesNotification_ShouldReadObjectChangesAndSelection_WhenDeserializedFromBridge()
    {
        const string json = """
            {"sequence":3,
             "objects":{"added":[],"removed":[],"updated":[{"gesture":"nudge",
               "object":{"id":"a","page":null,"rect":{"x":2,"y":2,"width":3,"height":4},"shape":"rect","locked":false,
                         "selectable":true,"hidden":false},
               "previous":{"id":"a","page":null,"rect":{"x":1,"y":2,"width":3,"height":4},"shape":"rect","locked":false,
                           "selectable":true,"hidden":false}}]},
             "selection":{"origin":"api","primaryId":"b","count":2}}
            """;

        var notification = System.Text.Json.JsonSerializer.Deserialize<ChangesNotification>(json, InteropJson)!;

        var update = Assert.Single(notification.Objects!.Updated);
        Assert.Equal(EditGesture.Nudge, update.Gesture);
        Assert.Null(update.Object.Page);
        Assert.Equal(new PageRect(1, 2, 3, 4), update.Previous.Rect);
        Assert.Equal(new PageRect(2, 2, 3, 4), update.Object.Rect);
        Assert.Equal(new SelectionState(ChangeOrigin.Api, "b", 2), notification.Selection);
    }

    [Fact]
    public async Task GetSelectedObjectIdsAsync_ShouldReadIdsFromStream_WhenViewerHasSelection()
    {
        _bridge.Setup<IJSStreamReference>("getSelectedObjectIds").SetResult(new JsonStream("""["a","b"]"""));
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        var ids = await controller.GetSelectedObjectIdsAsync();

        Assert.Equal(["a", "b"], ids);
    }

    [Fact]
    public void ViewerError_ShouldReadCodeAndDocumentClosed_WhenDeserializedFromViewerEvent()
    {
        const string json = """{"code":"password-required","message":"No password given","documentFailed":true}""";

        var error = System.Text.Json.JsonSerializer.Deserialize<ViewerError>(json, InteropJson);

        var expected = new ViewerError(ViewerErrorCode.PasswordRequired, "No password given", DocumentClosed: true);
        Assert.Equal(expected, error);
    }

    [Fact]
    public void ViewerObject_ShouldReadApplicationFields_WhenDeserializedFromViewerEvent()
    {
        const string json = """
            {"id":"a","page":1,"rect":{"x":1,"y":2,"width":3,"height":4},"shape":"rect","kind":"heading",
             "locked":false,"selectable":true,"hidden":true,"cssClass":"emphasized","appData":{"section":"3"}}
            """;

        var viewerObject = System.Text.Json.JsonSerializer.Deserialize<ViewerObject>(json, InteropJson)!;

        Assert.Equal(("heading", true, "emphasized"), (viewerObject.Kind, viewerObject.Hidden, viewerObject.CssClass));
        Assert.Equal(new Dictionary<string, string> { ["section"] = "3" }, viewerObject.AppData);
    }

    [Fact]
    public void ViewerObject_ShouldSendOnlyFieldsThatHaveValues_WhenSerialized()
    {
        var viewerObject = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4))
        {
            Kind = "heading", Hidden = true, AppData = new Dictionary<string, string> { ["section"] = "3" },
        };

        using var json = System.Text.Json.JsonSerializer.SerializeToDocument(viewerObject, InteropJson);

        var sent = json.RootElement.EnumerateObject().Select(property => property.Name).ToHashSet();
        Assert.Superset(new HashSet<string> { "kind", "hidden", "appData" }, sent);
        Assert.Empty(sent.Intersect(["label", "cssClass", "style"]));
        Assert.Equal("3", json.RootElement.GetProperty("appData").GetProperty("section").GetString());
    }

    [Fact]
    public void PageInfo_ShouldReadRotationInDegrees_WhenDeserializedFromViewer()
    {
        var info = System.Text.Json.JsonSerializer.Deserialize<PageInfo>(
            """{"page":3,"label":null,"width":400,"height":500,"rotation":90}""", InteropJson);

        Assert.Equal(new PageInfo(3, null, 400, 500, PageRotation.Clockwise90), info);
    }

    [Fact]
    public async Task GetPageInfoAsync_ShouldReturnWhatViewerReports_WhenCalled()
    {
        var expected = new PageInfo(3, "iii", 400, 500, PageRotation.Clockwise90);
        _bridge.Setup<PageInfo>("getPageInfo", 3).SetResult(expected);
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        var info = await controller.GetPageInfoAsync(3);

        Assert.Equal(expected, info);
    }

    [Fact]
    public async Task SelectObjectAsync_ShouldSendEmptySelection_WhenGivenNull()
    {
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await controller.SelectObjectAsync(null);

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("selectObjects", call.Identifier);
        Assert.Empty(Assert.IsAssignableFrom<IEnumerable<string>>(call.Arguments[0]));
    }

    [Fact]
    public async Task OnError_ShouldReceiveCodeAndMessage_WhenBridgeNotifies()
    {
        ViewerError? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnError, error => received = error));
        var error = new ViewerError(ViewerErrorCode.InvalidPdf, "Bad file", DocumentClosed: true);

        await viewer.InvokeAsync(() => Notifications.NotifyError(error));

        Assert.Equal(error, received);
    }

    [Theory]
    [InlineData("Zoom out")]
    [InlineData("Zoom in")]
    [InlineData("Rotate clockwise")]
    public async Task ToolbarButton_ShouldBeEnabledOnlyWithDocument_WhenRendered(string label)
    {
        var viewer = Render<PdfViewer>();

        Assert.True(viewer.Find($"[aria-label='{label}']").HasAttribute("disabled"));
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 1)));
        Assert.False(viewer.Find($"[aria-label='{label}']").HasAttribute("disabled"));
    }

    [Fact]
    public void Toolbar_ShouldSayNoDocument_WhenNothingIsOpen()
    {
        var viewer = Render<PdfViewer>();

        Assert.Equal("No document", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public async Task Toolbar_ShouldResetPosition_WhenOpeningDocumentFails()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 1)));

        var error = new ViewerError(ViewerErrorCode.InvalidPdf, "Bad file", DocumentClosed: true);
        await viewer.InvokeAsync(() => Notifications.NotifyError(error));

        Assert.Equal("No document", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public async Task Toolbar_ShouldKeepPosition_WhenOnlyPageFails()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 1)));

        var error = new ViewerError(ViewerErrorCode.Render, "Bad page", DocumentClosed: false);
        await viewer.InvokeAsync(() => Notifications.NotifyError(error));

        Assert.Equal("Page 1 of 5", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public void PdfViewer_ShouldCloseDocument_WhenSourceBecomesNull()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Source, "/a.pdf"));

        viewer.Render(parameters => parameters.Add(component => component.Source, (string?)null));

        Assert.Equal(["open", "close"], BridgeCalls);
    }

    [Fact]
    public async Task SetRotationAsync_ShouldThrowAndSendNothing_WhenGivenUndefinedEnumValue()
    {
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => controller.SetRotationAsync((PageRotation)45));

        Assert.Empty(_bridge.Invocations);
    }

    [Fact]
    public async Task SetPageRotationAsync_ShouldThrowAndSendNothing_WhenGivenUndefinedEnumValue()
    {
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => controller.SetPageRotationAsync(1, (PageRotation)45));

        Assert.Empty(_bridge.Invocations);
    }

    [Fact]
    public async Task SetPageRotationAsync_ShouldSendDegreesOrNull_WhenGivenRotationOrNull()
    {
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await controller.SetPageRotationAsync(2, PageRotation.Clockwise270);
        await controller.SetPageRotationAsync(2, null);

        Assert.Equal<object?>([270, null], _bridge.Invocations.Select(call => call.Arguments[1]));
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    public void PdfViewer_ShouldSubscribeToObjects_WhenChangesAreHandledOrObjectsAreSet(bool handled, bool managed,
        bool expected)
    {
        Render<PdfViewer>(parameters =>
        {
            if (handled)
            {
                parameters.Add(component => component.OnObjectsChanged, (ObjectsChangedArgs _) => { });
            }
            if (managed)
            {
                parameters.Add(component => component.Objects, Array.Empty<ViewerObject>());
            }
        });

        Assert.Equal(expected, Assert.IsType<ViewerSubscriptions>(AttachArgument(3)).Objects);
    }

    [Fact]
    public void PdfViewer_ShouldSubscribeOnlyToHandledNotifications_WhenAttaching()
    {
        Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnSelectionChanged, (SelectionChangedArgs _) => { }));

        Assert.Equal(new ViewerSubscriptions(Objects: false, Selection: true, Drawn: false), AttachArgument(3));
    }

    [Fact]
    public async Task DisposeAsync_ShouldDisconnectBridge_WhenCalled()
    {
        var viewer = Render<PdfViewer>();

        await viewer.Instance.DisposeAsync();

        Assert.Equal("dispose", Assert.Single(_bridge.Invocations).Identifier);
    }

    [Fact]
    public async Task DisposeAsync_ShouldNotThrow_WhenCircuitIsGone()
    {
        var viewer = Render<PdfViewer>();
        _bridge.SetupVoid("dispose").SetException(new JSDisconnectedException("The circuit is gone."));

        await viewer.Instance.DisposeAsync();
    }
    [Fact]
    public void PdfViewer_ShouldExposeNoMethodsForJavaScript_WhenInspected()
    {
        var invokable = typeof(PdfViewer).GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(method => method.GetCustomAttribute<JSInvokableAttribute>() is not null);

        Assert.Empty(invokable);
    }

    [Fact]
    public void DocumentLoadedNotification_ShouldReadPageCountAndPage_WhenDeserializedFromBridgeNotification()
    {
        var notification =
            System.Text.Json.JsonSerializer.Deserialize<DocumentLoadedNotification>("""{"pageCount":5,"page":2}""",
                InteropJson);

        Assert.Equal(new DocumentLoadedNotification(5, 2), notification);
    }

    [Fact]
    public void PdfViewerOptions_ShouldSerializeAsViewerReadsThem_WhenSent()
    {
        var options = new PdfViewerOptions
        {
            InitialZoom = ViewerZoomMode.FitPage, HideFormFields = true, KeyboardEditing = false,
            RoundCoordinates = true, SelectOnCreate = false, WheelZoom = false,
            Coordinates = ViewerCoordinates.Display, ObjectHitArea = ViewerObjectHitArea.Border,
        };

        var json = System.Text.Json.JsonSerializer.Serialize(options, InteropJson);

        const string expected = """
            {"initialZoom":"fit-page","hideFormFields":true,"keyboardEditing":false,"roundCoordinates":true,
            "selectOnCreate":false,"wheelZoom":false,"coordinates":"display","objectHitArea":"border"}
            """;
        Assert.Equal(expected.Replace("\n", "").Replace("\r", ""), json);
    }

    [Fact]
    public void Options_ShouldGoWithAttach_WhenFirstRendered()
    {
        var options = new PdfViewerOptions { KeyboardEditing = false };

        Render<PdfViewer>(parameters => parameters.Add(component => component.Options, options));

        Assert.Equal(options, AttachArgument(2));
    }

    [Fact]
    public void Options_ShouldBeAppliedThroughConfigure_WhenChangedAfterFirstRender()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Options, new()));
        var changed = new PdfViewerOptions { RoundCoordinates = true };

        viewer.Render(parameters => parameters.Add(component => component.Options, changed));

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("configure", call.Identifier);
        Assert.Equal(changed, call.Arguments[0]);
    }

    [Fact]
    public void Options_ShouldSendNothing_WhenEqualRecordIsSetAgain()
    {
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.Options, new PdfViewerOptions { WheelZoom = false }));

        viewer.Render(parameters =>
            parameters.Add(component => component.Options, new PdfViewerOptions { WheelZoom = false }));

        Assert.Empty(_bridge.Invocations);
    }

    [Fact]
    public async Task Subscriptions_ShouldBeSentAgainAndReachHandler_WhenHandlerIsSetAfterFirstRender()
    {
        ObjectsChangedArgs? received = null;
        var viewer = Render<PdfViewer>();

        viewer.Render(parameters => parameters.Add(component => component.OnObjectsChanged, args => received = args));
        var drawn = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));
        var changes = new ChangesNotification(1, new ObjectChanges([drawn], [], []), null);
        await viewer.InvokeAsync(() => Notifications.NotifyChanges(changes));

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("subscribe", call.Identifier);
        Assert.Equal(new ViewerSubscriptions(Objects: true, Selection: false, Drawn: false), call.Arguments[0]);
        Assert.Equal([drawn], received!.Added);
    }

    [Fact]
    public async Task Controller_ShouldRunWaitingCommandsInOrderAfterOpening_WhenIssuedBeforeViewerAttaches()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));
        var controller = new PdfViewerController();
        var tool = controller.SetToolAsync(ViewerTool.DrawRectangle);
        var zoom = controller.SetZoomAsync(2);

        Render<PdfViewer>(parameters => parameters
            .Add(component => component.Controller, controller)
            .Add(component => component.Source, "/a.pdf"));
        await Task.WhenAll(tool, zoom);

        Assert.Equal(["open", "setTool", "setZoom"], bridge.Calls);
    }

    [Fact]
    public async Task Controller_ShouldCancelWaitingCommand_WhenTokenIsCanceledBeforeViewerAttaches()
    {
        var controller = new PdfViewerController();
        using var cancellation = new CancellationTokenSource();
        var turn = controller.GoToPageAsync(2, cancellation.Token);

        await cancellation.CancelAsync();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => turn);
        Assert.Empty(_bridge.Invocations);
    }

    [Fact]
    public async Task GoToPageAsync_ShouldCompleteOnlyOnceBrowserHasShownPage_WhenCalled()
    {
        var shown = _bridge.SetupVoid("goToPage", 4);
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        var turn = controller.GoToPageAsync(4);
        Assert.False(turn.IsCompleted);
        shown.SetVoidResult();

        await turn;
    }

    [Fact]
    public async Task Controller_ShouldTrackStateFromNotifications_WhenViewerReports()
    {
        var controller = new PdfViewerController();
        var changes = 0;
        controller.StateChanged += () => changes++;
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 2)));
        var loaded = (controller.IsDocumentOpen, controller.PageCount, controller.CurrentPage);
        await viewer.InvokeAsync(() => Notifications.NotifyPageChanged(new PageChangedArgs(4)));

        Assert.Equal((true, 5, 2), loaded);
        Assert.Equal((true, 5, 4), (controller.IsDocumentOpen, controller.PageCount, controller.CurrentPage));
        Assert.Equal(2, changes);
    }

    [Fact]
    public async Task Controller_ShouldReportNoDocument_WhenNewSourceIsOpening()
    {
        var controller = new PdfViewerController();
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Controller, controller)
            .Add(component => component.Source, "/a.pdf"));
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 2)));

        viewer.Render(parameters => parameters.Add(component => component.Source, "/b.pdf"));

        Assert.Equal((false, 0, 0), (controller.IsDocumentOpen, controller.PageCount, controller.CurrentPage));
    }

    [Fact]
    public async Task Controller_ShouldMoveStateToNewController_WhenParameterChanges()
    {
        var first = new PdfViewerController();
        var second = new PdfViewerController();
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, first));
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(5, 2)));

        viewer.Render(parameters => parameters.Add(component => component.Controller, second));
        await second.SetZoomAsync(2);
        var waiting = first.SetZoomAsync(3);

        Assert.Equal((5, 2), (second.PageCount, second.CurrentPage));
        Assert.Equal((0, 0), (first.PageCount, first.CurrentPage));
        Assert.Equal(["setZoom"], BridgeCalls);
        Assert.False(waiting.IsCompleted);
    }

    [Fact]
    public void Controller_ShouldRefuseSecondViewer_WhenOneAlreadyHasIt()
    {
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        var refusal = Record.Exception(() =>
            Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller)));

        Assert.IsType<InvalidOperationException>(refusal?.InnerException ?? refusal);
    }

    [Fact]
    public async Task Controller_ShouldWaitForNextViewer_WhenItsViewerIsDisposed()
    {
        var controller = new PdfViewerController();
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));
        await viewer.Instance.DisposeAsync();

        var zoom = controller.SetZoomAsync(2);

        Assert.Equal(["dispose"], BridgeCalls);
        Assert.False(zoom.IsCompleted);
    }

    [Fact]
    public async Task Controller_ShouldOpenNewSourceBeforeRunningWaitingCommands_WhenControllerAndSourceChangeTogether()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));
        var first = new PdfViewerController();
        var second = new PdfViewerController();
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Controller, first)
            .Add(component => component.Source, "/a.pdf"));
        var queued = second.SetToolAsync(ViewerTool.DrawRectangle);

        viewer.Render(parameters => parameters
            .Add(component => component.Controller, second)
            .Add(component => component.Source, "/b.pdf"));
        await queued;

        Assert.Equal(["open", "open", "setTool"], bridge.Calls);
    }

    [Fact]
    public async Task Controller_ShouldNotTakeOver_WhenReplacedAgainBeforeItsSourceOpened()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));
        var first = new PdfViewerController();
        var second = new PdfViewerController();
        var third = new PdfViewerController();
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Controller, first)
            .Add(component => component.Source, "/a.pdf"));
        await viewer.InvokeAsync(() => viewer.Instance.HandleDocumentLoadedAsync(new DocumentLoadedNotification(5, 2)));
        var answered = new TaskCompletionSource();
        bridge.Held = ("open", answered.Task);
        var queued = second.SetToolAsync(ViewerTool.DrawRectangle);

        viewer.Render(parameters => parameters
            .Add(component => component.Controller, second)
            .Add(component => component.Source, "/b.pdf"));
        viewer.Render(parameters => parameters
            .Add(component => component.Controller, third)
            .Add(component => component.Source, "/c.pdf"));
        await viewer.InvokeAsync(answered.SetResult);
        await third.SetZoomAsync(2);

        Assert.Equal(["open", "open", "open", "setZoom"], bridge.Calls);
        Assert.False(queued.IsCompleted);
    }

    [Fact]
    public async Task Controller_ShouldGiveUpCopiedState_WhenReplacedAgainWhileOptionsWereBeingSent()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));
        var first = new PdfViewerController();
        var second = new PdfViewerController();
        var third = new PdfViewerController();
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, first));
        await viewer.InvokeAsync(() => viewer.Instance.HandleDocumentLoadedAsync(new DocumentLoadedNotification(5, 2)));
        var answered = new TaskCompletionSource();
        bridge.Held = ("configure", answered.Task);

        viewer.Render(parameters => parameters
            .Add(component => component.Controller, second)
            .Add(component => component.Options, new PdfViewerOptions { WheelZoom = false }));
        viewer.Render(parameters => parameters.Add(component => component.Controller, third));
        await viewer.InvokeAsync(answered.SetResult);

        Assert.Equal((false, 0, 0), (second.IsDocumentOpen, second.PageCount, second.CurrentPage));
        Assert.Equal((5, 2), (third.PageCount, third.CurrentPage));
    }

    [Fact]
    public async Task Controller_ShouldStayFreeForAnotherViewer_WhenViewerIsDisposedWhileAttaching()
    {
        var attach = new TaskCompletionSource<IJSObjectReference>();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(attach.Task));
        var bridge = new RecordingBridge();
        var controller = new PdfViewerController();
        var first = Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await first.Instance.DisposeAsync();
        await first.InvokeAsync(() => attach.SetResult(bridge));
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));
        await controller.SetZoomAsync(2);

        Assert.Equal(["dispose", "setZoom"], bridge.Calls);
    }
    [Fact]
    public void Objects_ShouldAllGoInOneCallAfterOpening_WhenFirstRendered()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));

        Render<PdfViewer>(parameters => parameters
            .Add(component => component.Source, "/a.pdf")
            .Add(component => component.Objects, ManyObjects(3)));

        Assert.Equal(["open", "applyObjects"], bridge.Calls);
        var batch = Assert.IsType<ObjectBatch>(bridge.Arguments[1][0]);
        Assert.Equal(3, batch.Upsert.Count);
        Assert.Empty(batch.Remove);
    }

    [Fact]
    public void Objects_ShouldSendOnlyObjectThatChanged_WhenOneOfAThousandChanges()
    {
        var objects = ManyObjects(1_000);
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Objects, objects));
        var changed = objects.ToArray();
        changed[500] = changed[500] with { Locked = true };

        viewer.Render(parameters => parameters.Add(component => component.Objects, changed));

        var batches = SentBatches.ToList();
        Assert.Equal(2, batches.Count);
        Assert.Equal([changed[500]], batches[1].Upsert);
        Assert.Empty(batches[1].Remove);
    }

    [Fact]
    public void Objects_ShouldSendIdsToRemove_WhenObjectsLeaveList()
    {
        var objects = ManyObjects(3);
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Objects, objects));

        viewer.Render(parameters => parameters.Add(component => component.Objects, objects[..1]));

        var batch = SentBatches.Last();
        Assert.Empty(batch.Upsert);
        Assert.Equal(["object-1", "object-2"], batch.Remove);
    }

    [Fact]
    public void Objects_ShouldSendNothing_WhenListIsSetAgainWithEqualObjects()
    {
        ViewerObject[] Tagged() =>
        [
            new("a", 1, new PageRect(1, 2, 3, 4)) { AppData = new Dictionary<string, string> { ["k"] = "v" } },
        ];
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Objects, Tagged()));

        viewer.Render(parameters => parameters.Add(component => component.Objects, Tagged()));

        Assert.Single(SentBatches);
    }

    [Fact]
    public async Task Objects_ShouldSendNothing_WhenPageChangesAndObjectsAreOnEveryPage()
    {
        var objects = ManyObjects(3);
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Source, "/a.pdf")
            .Add(component => component.Objects, objects));

        await viewer.InvokeAsync(() => Notifications.NotifyPageChanged(new PageChangedArgs(2)));
        viewer.Render(parameters => parameters.Add(component => component.Objects, objects));

        Assert.Single(SentBatches);
    }

    [Fact]
    public async Task Objects_ShouldSendNothing_WhenApplicationWritesUserMoveIntoItsList()
    {
        var list = new List<ViewerObject>(ManyObjects(3));
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Objects, list)
            .Add(component => component.OnObjectsChanged, (ObjectsChangedArgs args) =>
            {
                foreach (var update in args.Updated)
                {
                    list[list.FindIndex(viewerObject => viewerObject.Id == update.Object.Id)] = update.Object;
                }
            }));
        var moved = list[1] with { Rect = new PageRect(50, 50, 10, 10) };
        var notification = UserMoved(9, list[1], moved);

        await viewer.InvokeAsync(() => Notifications.NotifyChanges(notification));
        viewer.Render(parameters => parameters.Add(component => component.Objects, list));

        Assert.Equal(moved, list[1]);
        Assert.Single(SentBatches);
    }

    [Fact]
    public async Task Objects_ShouldSendListValueBasedOnUserMove_WhenApplicationKeepsItsOwnValue()
    {
        var objects = ManyObjects(2);
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Objects, objects));
        var notification = UserMoved(9, objects[1], objects[1] with { Rect = new PageRect(50, 50, 10, 10) });

        await viewer.InvokeAsync(() => Notifications.NotifyChanges(notification));
        viewer.Render(parameters => parameters.Add(component => component.Objects, objects));

        var undo = SentBatches.Last();
        Assert.Equal([objects[1]], undo.Upsert);
        Assert.Equal(9, undo.BasedOn);
    }

    [Fact]
    public async Task Objects_ShouldRemoveDrawnObject_WhenApplicationDoesNotAddItToItsList()
    {
        var objects = ManyObjects(1);
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Objects, objects));
        var drawn = new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4));
        var notification = new ChangesNotification(5, new ObjectChanges([drawn], [], []), null);

        await viewer.InvokeAsync(() => Notifications.NotifyChanges(notification));
        viewer.Render(parameters => parameters.Add(component => component.Objects, objects));

        var batch = SentBatches.Last();
        Assert.Empty(batch.Upsert);
        Assert.Equal(["drawn"], batch.Remove);
    }

    [Fact]
    public void Objects_ShouldBeSentAgainAfterOpening_WhenSourceChanges()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));
        var objects = ManyObjects(2);
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Source, "/a.pdf")
            .Add(component => component.Objects, objects));

        viewer.Render(parameters => parameters
            .Add(component => component.Source, "/b.pdf")
            .Add(component => component.Objects, objects));

        Assert.Equal(["open", "applyObjects", "open", "applyObjects"], bridge.Calls);
        Assert.Equal(2, Assert.IsType<ObjectBatch>(bridge.Arguments[3][0]).Upsert.Count);
    }

    [Fact]
    public void Objects_ShouldThrow_WhenTwoObjectsShareId()
    {
        var twin = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));

        var error = Record.Exception(() =>
            Render<PdfViewer>(parameters => parameters.Add(component => component.Objects, [twin, twin])));

        Assert.IsType<InvalidOperationException>(error?.InnerException ?? error);
    }

    [Fact]
    public async Task Objects_ShouldLeaveBrowserObjectsAlone_WhenNull()
    {
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectsChanged, (ObjectsChangedArgs _) => { }));
        var drawn = new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4));
        var notification = new ChangesNotification(5, new ObjectChanges([drawn], [], []), null);

        await viewer.InvokeAsync(() => Notifications.NotifyChanges(notification));
        viewer.Render();

        Assert.Empty(SentBatches);
    }

    [Fact]
    public void ObjectBatch_ShouldSerializeAsViewerReadsIt_WhenSent()
    {
        var batch = new ObjectBatch([new ViewerObject("a", null, new PageRect(1, 2, 3, 4))], ["b"], 7);

        using var json = System.Text.Json.JsonSerializer.SerializeToDocument(batch, InteropJson);

        var root = json.RootElement;
        Assert.Equal(System.Text.Json.JsonValueKind.Null, root.GetProperty("upsert")[0].GetProperty("page").ValueKind);
        Assert.Equal("b", root.GetProperty("remove")[0].GetString());
        Assert.Equal(7, root.GetProperty("basedOn").GetInt64());
    }

    [Fact]
    public void ViewerObject_ShouldEqualAnother_WhenAppDataHasSameEntriesInAnotherDictionary()
    {
        var first = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4))
        {
            AppData = new Dictionary<string, string> { ["section"] = "3", ["step"] = "1" },
        };
        var reordered = new SortedDictionary<string, string> { ["step"] = "1", ["section"] = "3" };
        var second = first with { AppData = reordered };

        Assert.Equal(first, second);
        Assert.Equal(first.GetHashCode(), second.GetHashCode());
    }

    [Fact]
    public void ViewerObject_ShouldDifferFromAnother_WhenAnyOnePropertyDiffers()
    {
        var original = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));
        // A property added to the record has to be added here, and to its Equals, or this fails.
        var other = new Dictionary<string, object?>
        {
            [nameof(ViewerObject.Id)] = "b",
            [nameof(ViewerObject.Page)] = 2,
            [nameof(ViewerObject.Rect)] = new PageRect(9, 9, 9, 9),
            [nameof(ViewerObject.Locked)] = true,
            [nameof(ViewerObject.Selectable)] = false,
            [nameof(ViewerObject.Hidden)] = true,
            [nameof(ViewerObject.Label)] = "other",
            [nameof(ViewerObject.Kind)] = "other",
            [nameof(ViewerObject.CssClass)] = "other",
            [nameof(ViewerObject.AppData)] = new Dictionary<string, string> { ["k"] = "v" },
            [nameof(ViewerObject.Style)] = new ViewerObjectStyle { Color = "red" },
        };
        var properties = typeof(ViewerObject).GetProperties(BindingFlags.Public | BindingFlags.Instance);

        Assert.Equal(other.Keys.Order(), properties.Select(property => property.Name).Order());
        foreach (var property in properties)
        {
            var copy = original with { };
            property.SetValue(copy, other[property.Name]);
            Assert.NotEqual(original, copy);
        }
    }

    [Fact]
    public async Task OnSelectionChanged_ShouldNotWaitForObjectsHandler_WhenBothArriveTogether()
    {
        var waiting = new TaskCompletionSource();
        SelectionChangedArgs? selection = null;
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.OnObjectsChanged, (ObjectsChangedArgs _) => waiting.Task)
            .Add(component => component.OnSelectionChanged, args => selection = args));
        var drawn = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));
        var changes = new ChangesNotification(3, new ObjectChanges([drawn], [], []), new(ChangeOrigin.User, "a", 1));

        var handled = viewer.InvokeAsync(() => Notifications.NotifyChanges(changes));
        var raisedWhileWaiting = selection;
        waiting.SetResult();
        await handled;

        Assert.Equal(new SelectionChangedArgs(3, ChangeOrigin.User, "a", 1), raisedWhileWaiting);
    }

    [Fact]
    public async Task OnSelectionChanged_ShouldStillBeRaised_WhenObjectsHandlerThrows()
    {
        SelectionChangedArgs? selection = null;
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.OnObjectsChanged, (ObjectsChangedArgs _) => throw new FormatException())
            .Add(component => component.OnSelectionChanged, args => selection = args));
        var drawn = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));
        var changes = new ChangesNotification(3, new ObjectChanges([drawn], [], []), new(ChangeOrigin.User, "a", 1));

        await Assert.ThrowsAsync<FormatException>(
            () => viewer.InvokeAsync(() => Notifications.NotifyChanges(changes)));

        Assert.NotNull(selection);
    }

    [Fact]
    public async Task OnObjectsChanged_ShouldIgnoreChangesFromPreviousDocument_WhenSourceHasChanged()
    {
        var received = new List<ObjectsChangedArgs>();
        var objects = ManyObjects(1);
        var moved = objects[0] with { Rect = new PageRect(50, 50, 10, 10) };
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Source, "/a.pdf")
            .Add(component => component.Objects, objects)
            .Add(component => component.OnObjectsChanged, received.Add));
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(3, 1)));

        viewer.Render(parameters => parameters.Add(component => component.Source, "/b.pdf"));
        await viewer.InvokeAsync(() => Notifications.NotifyChanges(UserMoved(9, objects[0], moved)));
        viewer.Render(parameters => parameters.Add(component => component.Objects, objects));
        var whileOpening = (received.Count, SentBatches.Count());
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(3, 1)));
        await viewer.InvokeAsync(() => Notifications.NotifyChanges(UserMoved(12, objects[0], moved)));

        // One batch per document, and none to undo the late change, which was never taken as known.
        Assert.Equal((0, 2), whileOpening);
        Assert.Single(received);
    }

    [Fact]
    public void PdfViewer_ShouldSubscribeToDrawnObjects_WhenOnObjectDrawnHasHandler()
    {
        Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectDrawn, (ObjectDrawnArgs _) => { }));

        Assert.Equal(new ViewerSubscriptions(Objects: false, Selection: false, Drawn: true), AttachArgument(3));
    }

    [Fact]
    public void ObjectDrawnNotification_ShouldReadDrawnObject_WhenDeserializedFromBridge()
    {
        const string json = """
            {"object":{"id":"d","page":2,"rect":{"x":1,"y":2,"width":3,"height":4},"shape":"rect","kind":"heading",
                       "locked":false,"selectable":true,"hidden":false}}
            """;

        var notification = System.Text.Json.JsonSerializer.Deserialize<ObjectDrawnNotification>(json, InteropJson)!;

        Assert.Equal(new ViewerObject("d", 2, new PageRect(1, 2, 3, 4)) { Kind = "heading" }, notification.Object);
    }

    [Fact]
    public async Task OnObjectDrawn_ShouldReceiveDrawnObject_WhenBridgeNotifies()
    {
        ObjectDrawnArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectDrawn, args => received = args));
        var drawn = new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4)) { Kind = "heading" };

        await viewer.InvokeAsync(() => Notifications.NotifyObjectDrawn(new ObjectDrawnNotification(drawn)));

        Assert.Equal(drawn, received!.Object);
    }

    [Fact]
    public async Task NotifyObjectDrawn_ShouldCompleteOnlyOnceHandlerHasFinished_WhenHandlerWaits()
    {
        var waiting = new TaskCompletionSource();
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectDrawn, (ObjectDrawnArgs _) => waiting.Task));
        var drawn = new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4));

        // The notification's own task, which the browser keeps the draft for as long as it's unanswered.
        var notified = await viewer.InvokeAsync(() => Task.FromResult(
            Notifications.NotifyObjectDrawn(new ObjectDrawnNotification(drawn))));
        // Whatever the notification had queued has run by the time this returns.
        await viewer.InvokeAsync(() => { });
        var answeredWhileWaiting = notified.IsCompleted;
        waiting.SetResult();
        await notified;

        Assert.False(answeredWhileWaiting);
    }

    [Fact]
    public async Task Objects_ShouldSendDrawnObjectBeforeNotificationCompletes_WhenButtonClickLetsHandlerKeepIt()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));
        var page = Render<DrawingPage>();
        var viewer = page.FindComponent<PdfViewer>().Instance;
        var drawn = new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4));

        // The notification's own task, which is what the browser waits on. The dispatcher's task completes later.
        var notified = await page.InvokeAsync(() => Task.FromResult(
            viewer.HandleObjectDrawnAsync(new ObjectDrawnNotification(drawn))));
        // The browser discards the draft when the notification completes, so the object must be on its way by then.
        var sentByThen = notified.ContinueWith(_ => bridge.Calls.Contains("applyObjects"),
            TaskContinuationOptions.ExecuteSynchronously);
        var sentWhileWaiting = bridge.Calls.Contains("applyObjects");
        await page.Find("button").ClickAsync(new());

        Assert.False(sentWhileWaiting);
        Assert.True(await sentByThen);
        Assert.Equal([drawn], Assert.IsType<ObjectBatch>(bridge.Arguments[^1][0]).Upsert);
    }

    [Fact]
    public async Task Objects_ShouldSendDrawnObjectBeforeNotificationCompletes_WhenSameRenderSendsOptionsFirst()
    {
        var bridge = new RecordingBridge();
        Services.AddSingleton<IJSRuntime>(new StubRuntime(Task.FromResult<IJSObjectReference>(bridge)));
        var page = Render<DrawingPage>(parameters => parameters.Add(component => component.ChangeOptionsOnKeep, true));
        var viewer = page.FindComponent<PdfViewer>().Instance;
        var drawn = new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4));
        var optionsAnswered = new TaskCompletionSource();
        bridge.Held = ("configure", optionsAnswered.Task);

        var notified = await page.InvokeAsync(() => Task.FromResult(
            viewer.HandleObjectDrawnAsync(new ObjectDrawnNotification(drawn))));
        var sentByThen = notified.ContinueWith(_ => bridge.Calls.Contains("applyObjects"),
            TaskContinuationOptions.ExecuteSynchronously);
        await page.Find("button").ClickAsync(new());
        // Whatever the notification had queued has run by the time this returns.
        await page.InvokeAsync(() => { });
        var answeredBeforeObjectsWereSent = notified.IsCompleted;
        await page.InvokeAsync(optionsAnswered.SetResult);

        Assert.False(answeredBeforeObjectsWereSent);
        Assert.True(await sentByThen);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OnObjectDrawn_ShouldCancelToken_WhenDraftIsDiscardedWhileHandlerWaits(bool byDisposal)
    {
        var waiting = new TaskCompletionSource();
        var token = CancellationToken.None;
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Source, "/a.pdf")
            .Add(component => component.OnObjectDrawn, (ObjectDrawnArgs args) =>
            {
                token = args.CancellationToken;
                return waiting.Task;
            }));
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(3, 1)));
        var drawn = new ObjectDrawnNotification(new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4)));
        var notified = viewer.InvokeAsync(() => Notifications.NotifyObjectDrawn(drawn));
        var canceledWhileDraftWasThere = token.IsCancellationRequested;

        if (byDisposal)
        {
            await viewer.Instance.DisposeAsync();
        }
        else
        {
            viewer.Render(parameters => parameters.Add(component => component.Source, "/b.pdf"));
        }
        var canceledOnceDraftWasDiscarded = token.IsCancellationRequested;
        waiting.SetResult();
        await notified;

        Assert.Equal((false, true), (canceledWhileDraftWasThere, canceledOnceDraftWasDiscarded));
    }

    [Fact]
    public async Task OnObjectDrawn_ShouldNotBeRaised_WhenDrawIsReportedAfterViewerIsDisposed()
    {
        var received = new List<ObjectDrawnArgs>();
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.OnObjectDrawn, received.Add));
        var drawn = new ObjectDrawnNotification(new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4)));
        var notifications = Notifications;
        await viewer.Instance.DisposeAsync();

        await viewer.InvokeAsync(() => notifications.NotifyObjectDrawn(drawn));

        Assert.Empty(received);
    }

    [Fact]
    public async Task DisposeAsync_ShouldNotThrow_WhenCalledTwice()
    {
        var viewer = Render<PdfViewer>();

        await viewer.Instance.DisposeAsync();
        await viewer.Instance.DisposeAsync();
    }

    [Fact]
    public async Task OnObjectDrawn_ShouldGiveTokenThatIsNotCanceled_WhenDrawnOnDocumentOpenedAfterAnother()
    {
        var received = new List<ObjectDrawnArgs>();
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Source, "/a.pdf")
            .Add(component => component.OnObjectDrawn, received.Add));
        var drawn = new ObjectDrawnNotification(new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4)));
        viewer.Render(parameters => parameters.Add(component => component.Source, "/b.pdf"));
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(3, 1)));

        await viewer.InvokeAsync(() => Notifications.NotifyObjectDrawn(drawn));

        Assert.False(Assert.Single(received).CancellationToken.IsCancellationRequested);
    }

    [Fact]
    public async Task OnObjectDrawn_ShouldIgnoreDraftFromPreviousDocument_WhenSourceHasChanged()
    {
        var received = new List<ObjectDrawnArgs>();
        var viewer = Render<PdfViewer>(parameters => parameters
            .Add(component => component.Source, "/a.pdf")
            .Add(component => component.OnObjectDrawn, received.Add));
        var drawn = new ObjectDrawnNotification(new ViewerObject("drawn", 1, new PageRect(1, 2, 3, 4)));
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(3, 1)));

        viewer.Render(parameters => parameters.Add(component => component.Source, "/b.pdf"));
        await viewer.InvokeAsync(() => Notifications.NotifyObjectDrawn(drawn));
        var whileOpening = received.Count;
        await viewer.InvokeAsync(() => Notifications.NotifyDocumentLoaded(new DocumentLoadedNotification(3, 1)));
        await viewer.InvokeAsync(() => Notifications.NotifyObjectDrawn(drawn));

        Assert.Equal(0, whileOpening);
        Assert.Single(received);
    }

    [Fact]
    public async Task CommitDraftAsync_ShouldSendDraftId_WhenCalled()
    {
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await controller.CommitDraftAsync("drawn");

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal(("commitDraft", "drawn"), (call.Identifier, call.Arguments[0]));
    }

    [Fact]
    public async Task DiscardDraftAsync_ShouldSendDraftId_WhenCalled()
    {
        var controller = new PdfViewerController();
        Render<PdfViewer>(parameters => parameters.Add(component => component.Controller, controller));

        await controller.DiscardDraftAsync("drawn");

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal(("discardDraft", "drawn"), (call.Identifier, call.Arguments[0]));
    }
}
