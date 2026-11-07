using Bunit;
using Microsoft.JSInterop;

namespace Pv.Blazor.Tests;

public class PdfViewerTests : BunitContext
{
    private const string ModulePath = "./_content/Pv.Blazor/pv.js";
    private readonly BunitJSModuleInterop _module;
    private readonly BunitJSModuleInterop _bridge;

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

        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));

        Assert.Equal("Page 2 of 5", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public async Task Toolbar_ShouldDisablePreviousButton_WhenOnFirstPage()
    {
        var viewer = Render<PdfViewer>();

        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));

        Assert.True(viewer.Find("[aria-label='Previous page']").HasAttribute("disabled"));
        Assert.False(viewer.Find("[aria-label='Next page']").HasAttribute("disabled"));
    }

    [Fact]
    public async Task NextButton_ShouldGoToFollowingPage_WhenClicked()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));

        await viewer.Find("[aria-label='Next page']").ClickAsync(new());

        var call = Assert.Single(_bridge.Invocations);
        Assert.Equal("goToPage", call.Identifier);
        Assert.Equal(2, call.Arguments[0]);
    }

    [Fact]
    public async Task RotateButton_ShouldAddQuarterTurnEachClick_WhenClickedRepeatedly()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));

        for (var i = 0; i < 5; i++)
        {
            await viewer.Find("[aria-label='Rotate clockwise']").ClickAsync(new());
        }

        Assert.Equal<object?>([90, 180, 270, 0, 90], _bridge.Invocations.Select(call => call.Arguments[0]));
    }

    [Fact]
    public async Task OnObjectChanged_ShouldReceiveChange_WhenBridgeNotifies()
    {
        ViewerObjectChange? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnObjectChanged, change => received = change));
        var viewerObject = new ViewerObject("a", 1, new PageRect(1, 2, 3, 4));
        var change = new ViewerObjectChange(7, ChangeOrigin.User, ObjectChangeKind.Updated, viewerObject);

        await viewer.InvokeAsync(() => viewer.Instance.NotifyObjectChanged(change));

        Assert.Equal(change, received);
    }

    [Fact]
    public async Task OnError_ShouldReceiveCodeAndMessage_WhenBridgeNotifies()
    {
        ViewerError? received = null;
        var viewer = Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnError, error => received = error));

        await viewer.InvokeAsync(() => viewer.Instance.NotifyError("invalid-pdf", "Bad file", documentFailed: true));

        Assert.Equal(new ViewerError("invalid-pdf", "Bad file"), received);
    }

    [Theory]
    [InlineData("Zoom out")]
    [InlineData("Zoom in")]
    [InlineData("Rotate clockwise")]
    public async Task ToolbarButton_ShouldBeEnabledOnlyWithDocument_WhenRendered(string label)
    {
        var viewer = Render<PdfViewer>();

        Assert.True(viewer.Find($"[aria-label='{label}']").HasAttribute("disabled"));
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));
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
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));

        await viewer.InvokeAsync(() => viewer.Instance.NotifyError("invalid-pdf", "Bad file", documentFailed: true));

        Assert.Equal("No document", viewer.Find("[role=status]").TextContent);
    }

    [Fact]
    public async Task Toolbar_ShouldKeepPosition_WhenOnlyPageFails()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));

        await viewer.InvokeAsync(() => viewer.Instance.NotifyError("render", "Bad page", documentFailed: false));

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
    public async Task SetRotationAsync_ShouldThrowAndKeepRotation_WhenNotQuarterTurn()
    {
        var viewer = Render<PdfViewer>();
        await viewer.InvokeAsync(() => viewer.Instance.NotifyDocumentLoaded(5));

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => viewer.Instance.SetRotationAsync(45));
        await viewer.Find("[aria-label='Rotate clockwise']").ClickAsync(new());

        Assert.Equal(90, Assert.Single(_bridge.Invocations).Arguments[0]);
    }

    [Fact]
    public void PdfViewer_ShouldSubscribeOnlyToHandledNotifications_WhenAttaching()
    {
        Render<PdfViewer>(parameters =>
            parameters.Add(component => component.OnSelectionChanged, (ViewerSelectionChange _) => { }));

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
