using Bunit;
using Microsoft.JSInterop;

namespace Pv.Blazor.Tests;

public class PdfViewerTests : BunitContext
{
    private const string ModulePath = "./_content/Pv.Blazor/pv.js";
    private readonly BunitJSModuleInterop _bridge;

    public PdfViewerTests()
    {
        // Strict mode fails any JavaScript call a test didn't plan for.
        JSInterop.Mode = JSRuntimeMode.Strict;
        _bridge = JSInterop.SetupModule(ModulePath).SetupModule("attach", _ => true);
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

        await viewer.InvokeAsync(() => viewer.Instance.NotifyError("invalid-pdf", "Bad file"));

        Assert.Equal(new ViewerError("invalid-pdf", "Bad file"), received);
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
