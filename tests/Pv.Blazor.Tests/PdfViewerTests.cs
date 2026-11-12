using Bunit;
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

    public PdfViewerTests()
    {
        // Strict mode fails any JavaScript call a test didn't plan for.
        JSInterop.Mode = JSRuntimeMode.Strict;
        _module = JSInterop.SetupModule(ModulePath);
        _bridge = _module.SetupModule("attach", _ => true);
        _bridge.SetupVoid(_ => true).SetVoidResult();
    }

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

        Assert.Equal(["open", "open"], _bridge.Invocations.Select(call => call.Identifier));
    }

    [Fact]
    public void Toolbar_ShouldNotRender_WhenShowToolbarIsFalse()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.ShowToolbar, false));

        Assert.Empty(viewer.FindAll("[role=toolbar]"));
    }

    [Fact]
    public async Task Toolbar_ShouldShowPosition_WhenDocumentLoads()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.InitialPage, 2));

        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));

        Assert.Equal("Page 2 of 5", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public async Task Toolbar_ShouldDisablePreviousButton_WhenOnFirstPage()
    {
        var viewer = Render<PdfViewer>();

        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));

        Assert.True(viewer.Find("[aria-label='Previous page']").HasAttribute("disabled"));
        Assert.False(viewer.Find("[aria-label='Next page']").HasAttribute("disabled"));
    }

    [Fact]
    public async Task NextButton_ShouldGoToFollowingPage_WhenClicked()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));

        await viewer.Find("[aria-label='Next page']").ClickAsync(new());

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("goToPage", call.Identifier);
        Assert.Equal(2, call.Arguments[0]);
    }

    [Fact]
    public async Task RotateButton_ShouldAddQuarterTurnEachClick_WhenClickedRepeatedly()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));

        for (var i = 0; i < 5; i++)
        {
            await viewer.Find("[aria-label='Rotate clockwise']").ClickAsync(new());
        }

        Assert.Equal<object?>([90, 180, 270, 0, 90], _bridge.Invocations.Select(call => call.Arguments[0]));
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

        await viewer.InvokeAsync(() => viewer.Instance.NotifyObjectUpdated(change));

        Assert.Equal(change, received);
    }

    [Fact]
    public void ObjectUpdatedArgs_ShouldReadGestureAndPreviousObject_WhenDeserializedFromViewerEvent()
    {
        const string json = """
            {"sequence":3,"origin":"user","gesture":"nudge",
             "object":{"id":"a","page":1,"rect":{"x":2,"y":2,"width":3,"height":4},"kind":"rect","locked":false,
                       "selectable":true},
             "previous":{"id":"a","page":1,"rect":{"x":1,"y":2,"width":3,"height":4},"kind":"rect","locked":false,
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
        var viewer = Render<PdfViewer>();

        var ids = await viewer.Instance.GetSelectedObjectIdsAsync();

        Assert.Equal(["a", "b"], ids);
    }

    [Fact]
    public async Task OnObjectRemoved_ShouldReceiveRemovedObject_WhenBridgeNotifies()
    {
        ObjectRemovedArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectRemoved, args => received = args));
        var change = new ObjectRemovedArgs(9, ChangeOrigin.User, new ViewerObject("a", 1, new PageRect(1, 2, 3, 4)));

        await viewer.InvokeAsync(() => viewer.Instance.NotifyObjectRemoved(change));

        Assert.Equal(change, received);
    }

    [Fact]
    public async Task OnObjectsReplaced_ShouldReceiveChange_WhenBridgeNotifies()
    {
        ObjectsReplacedArgs? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectsReplaced, args => received = args));
        var change = new ObjectsReplacedArgs(10, ChangeOrigin.Api);

        await viewer.InvokeAsync(() => viewer.Instance.NotifyObjectsReplaced(change));

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
        var viewer = Render<PdfViewer>();

        var info = await viewer.Instance.GetPageInfoAsync(3);

        Assert.Equal(expected, info);
    }

    [Fact]
    public async Task SelectObjectAsync_ShouldSendEmptySelection_WhenGivenNull()
    {
        var viewer = Render<PdfViewer>();

        await viewer.Instance.SelectObjectAsync(null);

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

        await viewer.InvokeAsync(() => viewer.Instance.NotifyError(error));

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
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));
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
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));

        var error = new ViewerError(ViewerErrorCode.InvalidPdf, "Bad file", DocumentClosed: true);
        await viewer.InvokeAsync(() => viewer.Instance.NotifyError(error));

        Assert.Equal("No document", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public async Task Toolbar_ShouldKeepPosition_WhenOnlyPageFails()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));

        var error = new ViewerError(ViewerErrorCode.Render, "Bad page", DocumentClosed: false);
        await viewer.InvokeAsync(() => viewer.Instance.NotifyError(error));

        Assert.Equal("Page 1 of 5", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public void PdfViewer_ShouldCloseDocument_WhenSourceBecomesNull()
    {
        var viewer = Render<PdfViewer>(parameters => parameters.Add(component => component.Source, "/a.pdf"));

        viewer.Render(parameters => parameters.Add(component => component.Source, (string?)null));

        Assert.Equal(["open", "close"], _bridge.Invocations.Select(call => call.Identifier));
    }

    [Fact]
    public async Task SetRotationAsync_ShouldThrowAndKeepRotation_WhenGivenUndefinedEnumValue()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(new DocumentLoadedArgs(5)));

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => viewer.Instance.SetRotationAsync((PageRotation)45));
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(
            () => viewer.Instance.SetPageRotationAsync(1, (PageRotation)45));
        await viewer.Find("[aria-label='Rotate clockwise']").ClickAsync(new());

        Assert.Equal(90, Assert.Single(_bridge.Invocations).Arguments[0]);
    }

    [Fact]
    public async Task SetPageRotationAsync_ShouldSendDegreesOrNull_WhenGivenRotationOrNull()
    {
        var viewer = Render<PdfViewer>();

        await viewer.Instance.SetPageRotationAsync(2, PageRotation.Clockwise270);
        await viewer.Instance.SetPageRotationAsync(2, null);

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

        var subscriptions = Assert.Single(_module.Invocations["attach"]).Arguments[3]!;
        Assert.Equal(expected, subscriptions.GetType().GetProperty("objects")!.GetValue(subscriptions));
    }

    [Fact]
    public void PdfViewer_ShouldSubscribeOnlyToHandledNotifications_WhenAttaching()
    {
        Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnSelectionChanged, (SelectionChangedArgs _) => { }));

        var subscriptions = Assert.Single(_module.Invocations["attach"]).Arguments[3]!;
        Assert.Equal(false, subscriptions.GetType().GetProperty("objects")!.GetValue(subscriptions));
        Assert.Equal(true, subscriptions.GetType().GetProperty("selection")!.GetValue(subscriptions));
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
}
