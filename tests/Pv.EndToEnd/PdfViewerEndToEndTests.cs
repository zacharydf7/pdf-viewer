using System.Text;
using Microsoft.Playwright;
using static Microsoft.Playwright.Assertions;

namespace Pv.EndToEnd;

[Collection(SampleAppCollection.Name)]
public sealed class PdfViewerEndToEndTests(SampleAppFixture app) : IAsyncLifetime
{
    private static readonly string DocumentsDirectory = Path.Combine(AppContext.BaseDirectory, "documents");
    private readonly List<string> _consoleProblems = [];
    private IBrowserContext _context = default!;
    private ViewerPage _viewer = default!;

    public async Task InitializeAsync()
    {
        var viewport = new ViewportSize { Width = 1280, Height = 900 };
        _context = await app.Browser.NewContextAsync(new() { BaseURL = app.BaseUrl, ViewportSize = viewport });
        var page = await _context.NewPageAsync();
        page.Console += (_, message) =>
        {
            if (message.Type == "error" || message.Text.Contains("fake worker", StringComparison.Ordinal))
            {
                _consoleProblems.Add(message.Text);
            }
        };
        page.PageError += (_, error) => _consoleProblems.Add(error);
        _viewer = new ViewerPage(page);
    }

    public async Task DisposeAsync() => await _context.DisposeAsync();

    private async Task OpenAsync(string document = "documents/letter.pdf", int page = 1)
    {
        await _viewer.Page.GotoAsync($"/?doc={document}&page={page}");
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-document-state", "ready");
        await _viewer.WaitForPageAsync(page);
    }

    private ILocator TestId(string id) => _viewer.Page.GetByTestId(id);

    /// <summary>
    /// The click reaches the viewer through .NET, so wait for its contract to confirm the switch before dragging.
    /// </summary>
    private async Task ActivateDrawToolAsync()
    {
        await TestId("tool-draw").ClickAsync();
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-tool", "draw-rect");
    }

    private async Task ActivateSelectToolAsync()
    {
        await TestId("tool-select").ClickAsync();
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-tool", "select");
    }

    [Fact]
    public async Task PdfViewer_ShouldRenderDocumentWithoutErrors_WhenGivenUrlSource()
    {
        await OpenAsync();

        await Expect(_viewer.PageElement().Locator("canvas")).ToBeVisibleAsync();
        await Expect(_viewer.PageElement().Locator(".textLayer")).ToContainTextAsync("Page 1 sample text");
        await Expect(_viewer.Page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 1 of 3");
        Assert.Empty(_consoleProblems);
    }

    [Fact]
    public async Task PdfViewer_ShouldShowInitialPage_WhenGivenInQueryString()
    {
        await OpenAsync(page: 2);

        await Expect(_viewer.PageElement(2).Locator(".textLayer")).ToContainTextAsync("Page 2 sample text");
        await Expect(_viewer.Page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 2 of 3");
    }

    [Fact]
    public async Task ToolbarNextButton_ShouldChangePageAndStatus_WhenClicked()
    {
        await OpenAsync();

        await _viewer.Page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();

        await _viewer.WaitForPageAsync(2);
        await Expect(_viewer.Page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 2 of 3");
    }

    [Fact]
    public async Task DrawTool_ShouldCreateDomObjectAndNotifyDotNet_WhenDraggedWithRealMouse()
    {
        await OpenAsync();
        await ActivateDrawToolAsync();

        await _viewer.DragOnPageAsync(0.2f, 0.2f, 0.5f, 0.4f);

        await Expect(_viewer.Objects).ToHaveCountAsync(1);
        var id = (await _viewer.Objects.GetAttributeAsync("data-object-id"))!;
        await Expect(TestId("last-change")).ToHaveTextAsync($"Added User {id}");
        await Expect(_viewer.Page.Locator($"[data-listed-object=\"{id}\"]")).ToBeVisibleAsync();

        // The default page is 612 units wide and 792 high, so these are the same fractions of the page.
        var rect = await _viewer.PageRectAsync(id);
        Assert.InRange(rect.X, 612 * 0.2 - 1, 612 * 0.2 + 1);
        Assert.InRange(rect.Width, 612 * 0.3 - 1, 612 * 0.3 + 1);
        Assert.InRange(rect.Y, 792 * 0.2 - 1, 792 * 0.2 + 1);
        Assert.InRange(rect.Height, 792 * 0.2 - 1, 792 * 0.2 + 1);
    }

    [Fact]
    public async Task Object_ShouldReportUserOriginToDotNet_WhenDragged()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");

        await _viewer.DragObjectAsync("code-1", 40, 20);

        await Expect(TestId("last-change")).ToHaveTextAsync("Updated User code-1");
        var rect = await _viewer.PageRectAsync("code-1");
        Assert.True(rect.X > 50 && rect.Y > 50, $"Expected a move from 50,50, but it is at {rect.X},{rect.Y}.");
        Assert.Equal((150, 80), (rect.Width, rect.Height));
    }

    [Fact]
    public async Task OnSelectionChanged_ShouldReportSelectionAndDeselection_WhenUserClicks()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");

        await _viewer.Object("code-1").ClickAsync();
        await Expect(TestId("selected-object")).ToHaveTextAsync("code-1");
        await Expect(TestId("selected-ids")).ToHaveTextAsync("code-1");

        // The page's top-right corner is empty and on screen. In this fit-width layout, the bottom of the page isn't.
        var box = (await _viewer.PageElement().BoundingBoxAsync())!;
        await _viewer.Page.Mouse.ClickAsync(box.X + box.Width - 20, box.Y + 20);
        await Expect(TestId("selected-object")).ToHaveTextAsync("none");
        await Expect(TestId("selected-ids")).ToHaveTextAsync("");
    }

    [Fact]
    public async Task Object_ShouldHaveAccessibleRoleAndName_WhenAddedFromDotNet()
    {
        await OpenAsync();

        await TestId("add-object").ClickAsync();

        await Expect(_viewer.Page.GetByRole(AriaRole.Option, new() { Name = "Region code-1" })).ToBeVisibleAsync();
    }

    [Fact]
    public async Task Circuit_ShouldCarryNoPdfBytes_WhenOpeningLocalFile()
    {
        var path = Path.Combine(DocumentsDirectory, "range-large.pdf");
        var circuitBytes = 0L;
        var sawPdfHeader = false;
        _viewer.Page.WebSocket += (_, socket) =>
        {
            void Inspect(IWebSocketFrame frame)
            {
                var text = frame.Text ?? Encoding.Latin1.GetString(frame.Binary ?? []);
                Interlocked.Add(ref circuitBytes, text.Length);
                sawPdfHeader |= text.Contains("%PDF", StringComparison.Ordinal);
            }
            socket.FrameSent += (_, frame) => Inspect(frame);
            socket.FrameReceived += (_, frame) => Inspect(frame);
        };

        await _viewer.Page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(path);

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-page-count", "40");
        await _viewer.WaitForPageAsync();
        Assert.False(sawPdfHeader);
        var limit = new FileInfo(path).Length / 4;
        Assert.True(Interlocked.Read(ref circuitBytes) < limit, $"Circuit carried {circuitBytes} bytes.");
    }

    [Fact]
    public async Task UrlSource_ShouldUsePartialResponses_WhenServedByAspNetCore()
    {
        var statuses = new List<int>();
        var transferred = 0L;
        _viewer.Page.Response += (_, response) =>
        {
            if (response.Url.EndsWith("range-large.pdf", StringComparison.Ordinal))
            {
                statuses.Add(response.Status);
                if (response.Headers.TryGetValue("content-length", out var length) && response.Status == 206)
                {
                    Interlocked.Add(ref transferred, long.Parse(length));
                }
            }
        };

        await OpenAsync("documents/range-large.pdf");

        Assert.Contains(206, statuses);
        var fileSize = new FileInfo(Path.Combine(DocumentsDirectory, "range-large.pdf")).Length;
        var fetched = Interlocked.Read(ref transferred);
        Assert.True(fetched < fileSize, $"Fetched {fetched} of {fileSize} bytes for one page.");
    }

    [Fact]
    public async Task SecureDocument_ShouldReportNetworkError_WhenUserIsNotSignedIn()
    {
        await _viewer.Page.GotoAsync("/?doc=secure-documents/letter.pdf");

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-document-state", "error");
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-error-code", "network");
        await Expect(TestId("last-error")).ToHaveTextAsync("Network");
    }

    [Fact]
    public async Task SecureDocument_ShouldOpen_WhenUserHasAuthenticationCookie()
    {
        await _viewer.Page.GotoAsync("/demo-sign-in");

        await OpenAsync("secure-documents/letter.pdf");

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-page-count", "3");
    }

    [Fact]
    public async Task Viewer_ShouldKeepWorking_WhenCircuitIsLost()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");

        await _viewer.Page.EvaluateAsync("() => Blazor.disconnect()");

        await _viewer.DragObjectAsync("code-1", 30, 0);
        var rect = await _viewer.PageRectAsync("code-1");
        Assert.True(rect.X > 50, $"Expected the object to move from x 50, but it is at {rect.X}.");

        // .NET never heard about the drag, which shows the circuit really was gone while the viewer kept working.
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");
        await Expect(_viewer.Objects).ToHaveCountAsync(1);
    }

    /// <summary>
    /// Draws on a sample whose drawn-object handler waits on a dialog, and returns the ID of the draft it leaves.
    /// </summary>
    private async Task<string> DrawWithConfirmDialogAsync()
    {
        await _viewer.Page.GotoAsync("/?doc=documents/letter.pdf&confirmDraw=true");
        await _viewer.WaitForPageAsync();
        await ActivateDrawToolAsync();
        await _viewer.DragOnPageAsync(0.2f, 0.2f, 0.5f, 0.4f);
        await Expect(TestId("confirm-dialog")).ToBeVisibleAsync();
        return (await _viewer.Drafts.GetAttributeAsync("data-draft-id"))!;
    }

    [Fact]
    public async Task DrawDialog_ShouldShowDraftThatIsNotAnObject_WhenDrawnHandlerIsWaiting()
    {
        await DrawWithConfirmDialogAsync();

        await Expect(_viewer.Drafts).ToBeVisibleAsync();
        await Expect(_viewer.Objects).ToHaveCountAsync(0);
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-selected-object", "");
        await Expect(TestId("object-list").Locator("li")).ToHaveCountAsync(0);
        await Expect(TestId("last-change")).ToHaveTextAsync("");
    }

    [Fact]
    public async Task DrawDialog_ShouldLeaveViewerInteractive_WhenDrawnHandlerIsWaiting()
    {
        await DrawWithConfirmDialogAsync();

        // The handler is still waiting on the dialog, but commands and rendering must keep working.
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");
        await ActivateSelectToolAsync();
        await _viewer.DragObjectAsync("code-1", 40, 20);
        await Expect(TestId("last-change")).ToHaveTextAsync("Updated User code-1");
        await _viewer.Page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();
        await _viewer.WaitForPageAsync(2);
        await Expect(TestId("confirm-dialog")).ToBeVisibleAsync();
    }

    [Fact]
    public async Task DrawDialog_ShouldLeaveNoObjectBehind_WhenCanceled()
    {
        await DrawWithConfirmDialogAsync();

        await TestId("dialog-cancel").ClickAsync();

        await Expect(TestId("confirm-dialog")).ToBeHiddenAsync();
        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(_viewer.Objects).ToHaveCountAsync(0);
        await Expect(TestId("object-list").Locator("li")).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task DrawDialog_ShouldCommitOneObjectWithDrawnId_WhenSaved()
    {
        var id = await DrawWithConfirmDialogAsync();

        await TestId("dialog-save").ClickAsync();

        await Expect(TestId("confirm-dialog")).ToBeHiddenAsync();
        await Expect(_viewer.Objects).ToHaveCountAsync(1);
        await Expect(_viewer.Object(id)).ToHaveAttributeAsync("aria-selected", "true");
        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(TestId("object-list").Locator("li")).ToHaveCountAsync(1);
        await Expect(_viewer.Page.Locator($"[data-listed-object=\"{id}\"]")).ToBeVisibleAsync();
        await Expect(TestId("last-kind")).ToHaveTextAsync("heading");
    }

    [Fact]
    public async Task DrawDialog_ShouldDiscardSecondDraftAndKeepFirst_WhenUserDrawsAgainWhileDialogIsOpen()
    {
        var first = await DrawWithConfirmDialogAsync();

        await _viewer.DragOnPageAsync(0.6f, 0.5f, 0.8f, 0.7f);

        // The sample's handler returns at once for the second drawing, so only that draft is discarded.
        await Expect(_viewer.Drafts).ToHaveCountAsync(1);
        await Expect(_viewer.Drafts).ToHaveAttributeAsync("data-draft-id", first);
        await Expect(TestId("confirm-dialog")).ToBeVisibleAsync();
    }

    [Fact]
    public async Task DrawDialog_ShouldCloseAndAddNothingToNewDocument_WhenAnotherFileOpensWhileItWaits()
    {
        await DrawWithConfirmDialogAsync();

        await TestId("file-input").SetInputFilesAsync(Path.Combine(DocumentsDirectory, "a4.pdf"));

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-page-count", "1");
        await _viewer.WaitForPageAsync();
        await Expect(TestId("confirm-dialog")).ToBeHiddenAsync();
        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(_viewer.Objects).ToHaveCountAsync(0);
        await Expect(TestId("object-list").Locator("li")).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task DrawTool_ShouldDiscardDrawnObject_WhenCircuitIsLostAndHandlerCannotBeAsked()
    {
        await _viewer.Page.GotoAsync("/?doc=documents/letter.pdf&confirmDraw=true");
        await _viewer.WaitForPageAsync();
        await ActivateDrawToolAsync();
        await _viewer.Page.EvaluateAsync("() => Blazor.disconnect()");

        await _viewer.DragOnPageAsync(0.2f, 0.2f, 0.5f, 0.4f);

        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(_viewer.Objects).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task DrawTool_ShouldReturnKindToDotNet_WhenToolHasKind()
    {
        await OpenAsync();
        await ActivateDrawToolAsync();

        await _viewer.DragOnPageAsync(0.2f, 0.2f, 0.5f, 0.4f);

        await Expect(TestId("last-kind")).ToHaveTextAsync("heading");
        await Expect(_viewer.Page.Locator("[data-object-kind=\"heading\"]")).ToHaveCountAsync(1);
        await Expect(_viewer.Page.GetByRole(AriaRole.Option, new() { Name = "Heading region" })).ToBeVisibleAsync();
    }

    [Fact]
    public async Task HeadlessOptions_ShouldApply_WhenSetOnComponent()
    {
        await _viewer.Page.GotoAsync("/?doc=documents/letter.pdf&headless=true");
        await _viewer.WaitForPageAsync();

        await Expect(_viewer.Page.GetByRole(AriaRole.Toolbar)).ToHaveCountAsync(0);
        var host = (await _viewer.Host.BoundingBoxAsync())!;
        var page = (await _viewer.PageElement().BoundingBoxAsync())!;
        Assert.True(page.Height <= host.Height, "Expected the whole page to fit.");

        await ActivateDrawToolAsync();
        await _viewer.DragOnPageAsync(0.21f, 0.23f, 0.47f, 0.41f);
        await Expect(_viewer.Objects).ToHaveCountAsync(1);
        var id = (await _viewer.Objects.GetAttributeAsync("data-object-id"))!;
        var rect = await _viewer.PageRectAsync(id);
        Assert.All([rect.X, rect.Y, rect.Width, rect.Height], value => Assert.Equal(Math.Round(value), value));
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-object-hit-area", "border");

        await ActivateSelectToolAsync();
        await _viewer.Object(id).FocusAsync();
        await _viewer.Page.Keyboard.PressAsync("Delete");
        await Expect(_viewer.Objects).ToHaveCountAsync(1);
    }

    [Fact]
    public async Task HeadlessOptions_ShouldMeasureAsDisplayed_WhenPageHasItsOwnRotation()
    {
        await _viewer.Page.GotoAsync("/?doc=documents/rotate-90.pdf&headless=true");
        await _viewer.WaitForPageAsync();

        await Expect(_viewer.PageElement()).ToHaveAttributeAsync("data-page-width", "792");
        await Expect(_viewer.PageElement()).ToHaveAttributeAsync("data-page-height", "612");
    }

    [Fact]
    public async Task SetPageRotation_ShouldRotateDisplayedPage_WhenCalledFromDotNet()
    {
        await OpenAsync();

        await TestId("rotate-page").ClickAsync();

        await Expect(_viewer.PageElement()).ToHaveAttributeAsync("data-rotation", "180");
        await _viewer.WaitForPageAsync();
    }

    [Fact]
    public async Task CopyDocumentTo_ShouldDeliverAllBytes_WhenDocumentExceedsHubMessageLimit()
    {
        var path = Path.Combine(DocumentsDirectory, "range-large.pdf");
        await _viewer.Page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(path);
        await _viewer.WaitForPageAsync();

        await TestId("read-bytes").ClickAsync();

        await Expect(TestId("document-bytes")).ToHaveTextAsync(new FileInfo(path).Length.ToString());
        Assert.Empty(_consoleProblems);
    }

    [Fact]
    public async Task FileInput_ShouldReopenDocument_WhenSameFileIsChosenAgain()
    {
        var path = Path.Combine(DocumentsDirectory, "letter.pdf");
        await _viewer.Page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(path);
        await Expect(TestId("load-count")).ToHaveTextAsync("1");

        await TestId("file-input").SetInputFilesAsync(path);

        await Expect(TestId("load-count")).ToHaveTextAsync("2");
        await _viewer.WaitForPageAsync();
    }

    [Fact]
    public async Task FileInput_ShouldShowFirstPage_WhenShorterFileReplacesDocumentOnHighPage()
    {
        await _viewer.Page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(Path.Combine(DocumentsDirectory, "letter.pdf"));
        await _viewer.WaitForPageAsync();
        await _viewer.Page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();
        await _viewer.Page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();
        await _viewer.WaitForPageAsync(3);

        await TestId("file-input").SetInputFilesAsync(Path.Combine(DocumentsDirectory, "a4.pdf"));

        await _viewer.WaitForPageAsync();
        await Expect(_viewer.Page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 1 of 1");
    }

    [Fact]
    public async Task FileInput_ShouldReportInvalidPdf_WhenFileIsCorrupt()
    {
        await _viewer.Page.GotoAsync("/");

        await TestId("file-input").SetInputFilesAsync(new FilePayload
        {
            Name = "corrupt.pdf",
            MimeType = "application/pdf",
            Buffer = Encoding.UTF8.GetBytes("this is not a pdf"),
        });

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-document-state", "error");
        await Expect(TestId("last-error")).ToHaveTextAsync("InvalidPdf");
    }

    [Fact]
    public async Task GoToPageAsync_ShouldCompleteAfterPageHasRendered_WhenAwaited()
    {
        await OpenAsync();

        await TestId("go-to-page-3").ClickAsync();
        await Expect(TestId("shown-page")).ToHaveTextAsync("3");

        // Read once, without retrying: the sample shows the page only after the await, so it has rendered by then.
        Assert.Equal("rendered", await _viewer.PageElement(3).GetAttributeAsync("data-page-state"));
    }

    [Fact]
    public async Task Controller_ShouldRunCommandsOnOpeningDocument_WhenIssuedBeforeViewerAttached()
    {
        await _viewer.Page.GotoAsync("/?doc=documents/letter.pdf&earlyCommands=true");

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-tool", "draw-rect");
        await _viewer.WaitForPageAsync(3);
        await Expect(_viewer.Page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 3 of 3");
    }

    [Fact]
    public async Task Options_ShouldTakeEffect_WhenChangedAfterViewerAttached()
    {
        await OpenAsync();
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-object-hit-area", "fill");

        await TestId("border-hit-area").ClickAsync();

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-object-hit-area", "border");
        await Expect(_viewer.PageElement()).ToHaveAttributeAsync("data-page-state", "rendered");
    }

    [Fact]
    public async Task Viewer_ShouldWorkAgainWithoutErrors_WhenPageIsReloaded()
    {
        await OpenAsync();

        await _viewer.Page.ReloadAsync();

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-document-state", "ready");
        await _viewer.WaitForPageAsync();
        Assert.Empty(_consoleProblems);
    }
}
