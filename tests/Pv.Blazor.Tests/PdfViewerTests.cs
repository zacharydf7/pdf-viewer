using System.Reflection;
using Bunit;
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

        /// <summary>
        /// Holds back the answer to every call of a method until a task completes, like a slow circuit.
        /// </summary>
        public (string Method, Task Answered)? Held { get; set; }

        public async ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args)
        {
            Calls.Add(identifier);
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
    public async Task OnObjectUpdated_ShouldReceiveChange_WhenBridgeNotifies()
    {
        ObjectUpdatedArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectUpdated, args => received = args));
        var previous = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));
        var moved = previous with { Rect = new PageRect(5, 2, 3, 4) };
        var change = new ObjectUpdatedArgs(7, ChangeOrigin.User, moved, previous, EditGesture.Move);

        await viewer.InvokeAsync(() => Notifications.NotifyObjectUpdated(change));

        Assert.Equal(change, received);
    }

    [Fact]
    public void ObjectUpdatedArgs_ShouldReadGestureAndPreviousObject_WhenDeserializedFromViewerEvent()
    {
        const string json = """
            {"sequence":3,"origin":"user","gesture":"nudge",
             "object":{"id":"a","page":1,"rect":{"x":2,"y":2,"width":3,"height":4},"shape":"rect","locked":false,
                       "selectable":true},
             "previous":{"id":"a","page":1,"rect":{"x":1,"y":2,"width":3,"height":4},"shape":"rect","locked":false,
                         "selectable":true}}
            """;

        var args = System.Text.Json.JsonSerializer.Deserialize<ObjectUpdatedArgs>(json, InteropJson)!;

        Assert.Equal(EditGesture.Nudge, args.Gesture);
        Assert.Equal(new PageRect(1, 2, 3, 4), args.Previous.Rect);
        Assert.Equal(new PageRect(2, 2, 3, 4), args.Object.Rect);
    }

    [Fact]
    public void SelectionChangedArgs_ShouldReadPrimaryAndCount_WhenDeserializedFromBridgeNotification()
    {
        const string json = """{"sequence":4,"origin":"api","primaryId":"b","count":2}""";

        var args = System.Text.Json.JsonSerializer.Deserialize<SelectionChangedArgs>(json, InteropJson);

        Assert.Equal(new SelectionChangedArgs(4, ChangeOrigin.Api, "b", 2), args);
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
    public async Task OnObjectRemoved_ShouldReceiveRemovedObject_WhenBridgeNotifies()
    {
        ObjectRemovedArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectRemoved, args => received = args));
        var change = new ObjectRemovedArgs(9, ChangeOrigin.User, new ViewerObject("a", 1, new PageRect(1, 2, 3, 4)));

        await viewer.InvokeAsync(() => Notifications.NotifyObjectRemoved(change));

        Assert.Equal(change, received);
    }

    [Fact]
    public async Task OnObjectsReplaced_ShouldReceiveChange_WhenBridgeNotifies()
    {
        ObjectsReplacedArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectsReplaced, args => received = args));
        var change = new ObjectsReplacedArgs(10, ChangeOrigin.Api);

        await viewer.InvokeAsync(() => Notifications.NotifyObjectsReplaced(change));

        Assert.Equal(change, received);
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
    [InlineData(null, false)]
    [InlineData(nameof(PdfViewer.OnObjectAdded), true)]
    [InlineData(nameof(PdfViewer.OnObjectUpdated), true)]
    [InlineData(nameof(PdfViewer.OnObjectRemoved), true)]
    [InlineData(nameof(PdfViewer.OnObjectsReplaced), true)]
    public void PdfViewer_ShouldSubscribeToObjects_WhenAnyObjectCallbackIsHandled(string? handled, bool expected)
    {
        Render<PdfViewer>(parameters =>
        {
            switch (handled)
            {
                case nameof(PdfViewer.OnObjectAdded):
                    parameters.Add(component => component.OnObjectAdded, (ObjectAddedArgs _) => { });
                    break;
                case nameof(PdfViewer.OnObjectUpdated):
                    parameters.Add(component => component.OnObjectUpdated, (ObjectUpdatedArgs _) => { });
                    break;
                case nameof(PdfViewer.OnObjectRemoved):
                    parameters.Add(component => component.OnObjectRemoved, (ObjectRemovedArgs _) => { });
                    break;
                case nameof(PdfViewer.OnObjectsReplaced):
                    parameters.Add(component => component.OnObjectsReplaced, (ObjectsReplacedArgs _) => { });
                    break;
            }
        });

        Assert.Equal(expected, Assert.IsType<ViewerSubscriptions>(AttachArgument(3)).Objects);
    }

    [Fact]
    public void PdfViewer_ShouldSubscribeOnlyToHandledNotifications_WhenAttaching()
    {
        Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnSelectionChanged, (SelectionChangedArgs _) => { }));

        Assert.Equal(new ViewerSubscriptions(Objects: false, Selection: true), AttachArgument(3));
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
            RoundCoordinates = true, WheelZoom = false, Coordinates = ViewerCoordinates.Display,
            ObjectHitArea = ViewerObjectHitArea.Border,
        };

        var json = System.Text.Json.JsonSerializer.Serialize(options, InteropJson);

        const string expected = """
            {"initialZoom":"fit-page","hideFormFields":true,"keyboardEditing":false,"roundCoordinates":true,
            "wheelZoom":false,"coordinates":"display","objectHitArea":"border"}
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
        ObjectAddedArgs? received = null;
        var viewer = Render<PdfViewer>();

        viewer.Render(parameters => parameters.Add(component => component.OnObjectAdded, args => received = args));
        var change = new ObjectAddedArgs(1, ChangeOrigin.User, new ViewerObject("a", 1, new PageRect(1, 2, 3, 4)));
        await viewer.InvokeAsync(() => Notifications.NotifyObjectAdded(change));

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("subscribe", call.Identifier);
        Assert.Equal(new ViewerSubscriptions(Objects: true, Selection: false), call.Arguments[0]);
        Assert.Equal(change, received);
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
        var added = second.AddObjectAsync(new ViewerObject("a", 1, new PageRect(1, 2, 3, 4)));

        viewer.Render(parameters => parameters
            .Add(component => component.Controller, second)
            .Add(component => component.Source, "/b.pdf"));
        await added;

        Assert.Equal(["open", "open", "addObject"], bridge.Calls);
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
        var added = second.AddObjectAsync(new ViewerObject("a", 1, new PageRect(1, 2, 3, 4)));

        viewer.Render(parameters => parameters
            .Add(component => component.Controller, second)
            .Add(component => component.Source, "/b.pdf"));
        viewer.Render(parameters => parameters
            .Add(component => component.Controller, third)
            .Add(component => component.Source, "/c.pdf"));
        await viewer.InvokeAsync(answered.SetResult);
        await third.SetZoomAsync(2);

        Assert.Equal(["open", "open", "open", "setZoom"], bridge.Calls);
        Assert.False(added.IsCompleted);
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
}
