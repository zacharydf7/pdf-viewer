using System.Text;
using Microsoft.Playwright;
using Pv.Blazor;
using Pv.Testing.Playwright;
using static Microsoft.Playwright.Assertions;

namespace Pv.EndToEnd;

[Collection(SampleAppCollection.Name)]
public sealed class PdfViewerEndToEndTests(SampleAppFixture app) : IAsyncLifetime
{
    private static readonly string DocumentsDirectory = Path.Combine(AppContext.BaseDirectory, "documents");
    /// <summary>A rectangle inside the page of every fixture these tests open.</summary>
    private static readonly PageRect Drawn = new(120, 160, 180, 160);
    private readonly List<string> _consoleProblems = [];
    private IBrowserContext _context = default!;
    private IPage _page = default!;
    private PdfViewerLocator _viewer = default!;

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
        _page = page;
        _viewer = new PdfViewerLocator(page);
    }

    public async Task DisposeAsync() => await _context.DisposeAsync();

    private async Task OpenAsync(string document = "documents/letter.pdf", int page = 1)
    {
        await _page.GotoAsync($"/?doc={document}&page={page}");
        await _viewer.WaitForReadyAsync(page);
    }

    private ILocator TestId(string id) => _page.GetByTestId(id);

    /// <summary>
    /// The click reaches the viewer through .NET, so wait for its contract to confirm the switch before dragging.
    /// </summary>
    private async Task ActivateDrawToolAsync()
    {
        await TestId("tool-draw").ClickAsync();
        await _viewer.WaitForToolAsync(ViewerTool.DrawRectangle, "heading");
    }

    private async Task ActivateSelectToolAsync()
    {
        await TestId("tool-select").ClickAsync();
        await _viewer.WaitForToolAsync(ViewerTool.Select);
    }

    [Fact]
    public async Task PdfViewer_ShouldRenderDocumentWithoutErrors_WhenGivenUrlSource()
    {
        await OpenAsync();

        await Expect(_viewer.Page(1).Locator("canvas")).ToBeVisibleAsync();
        await Expect(_viewer.Page(1).Locator(".textLayer")).ToContainTextAsync("Page 1 sample text");
        await Expect(_page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 1 of 3");
        Assert.Empty(_consoleProblems);
    }

    [Fact]
    public async Task PdfViewer_ShouldShowInitialPage_WhenGivenInQueryString()
    {
        await OpenAsync(page: 2);

        await Expect(_viewer.Page(2).Locator(".textLayer")).ToContainTextAsync("Page 2 sample text");
        await Expect(_page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 2 of 3");
    }

    [Fact]
    public async Task ToolbarNextButton_ShouldChangePageAndStatus_WhenClicked()
    {
        await OpenAsync();

        await _page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();

        await _viewer.WaitForReadyAsync(2);
        await Expect(_page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 2 of 3");
    }

    [Fact]
    public async Task DrawTool_ShouldCreateDomObjectAndNotifyDotNet_WhenDraggedWithRealMouse()
    {
        await OpenAsync();
        await ActivateDrawToolAsync();

        await _viewer.DrawAsync(Drawn);

        await Expect(_viewer.Objects()).ToHaveCountAsync(1);
        var id = (await _viewer.Objects().GetAttributeAsync("data-object-id"))!;
        await Expect(TestId("last-change")).ToHaveTextAsync($"Added User {id}");
        await Expect(_page.Locator($"[data-listed-object=\"{id}\"]")).ToBeVisibleAsync();

        RectAssert.Near(Drawn, await _viewer.PageRectAsync(id));
    }

    [Fact]
    public async Task Object_ShouldReportUserOriginToDotNet_WhenDragged()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");

        await _viewer.DragObjectByAsync("code-1", 40, 20);

        await Expect(TestId("last-change")).ToHaveTextAsync("Updated User code-1");
        RectAssert.Near(new PageRect(90, 70, 150, 80), await _viewer.PageRectAsync("code-1"));
    }

    [Fact]
    public async Task OnSelectionChanged_ShouldReportSelectionAndDeselection_WhenUserClicks()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");

        await _viewer.ClickObjectAsync("code-1");
        await Expect(TestId("selected-object")).ToHaveTextAsync("code-1");
        await Expect(TestId("selected-ids")).ToHaveTextAsync("code-1");

        // The page's top-right corner is empty and on screen. In this fit-width layout, the bottom of the page isn't.
        var box = (await _viewer.Page(1).BoundingBoxAsync())!;
        await _page.Mouse.ClickAsync(box.X + box.Width - 20, box.Y + 20);
        await Expect(TestId("selected-object")).ToHaveTextAsync("none");
        await Expect(TestId("selected-ids")).ToHaveTextAsync("");
    }

    [Fact]
    public async Task SelectedObjectId_ShouldSelectObject_WhenSetInRenderThatAddsIt()
    {
        await OpenAsync();

        await TestId("add-selected-object").ClickAsync();

        await Expect(_viewer.Object("code-1")).ToHaveAttributeAsync("aria-selected", "true");
        await Expect(TestId("selected-ids")).ToHaveTextAsync("code-1");
    }

    [Fact]
    public async Task Object_ShouldHaveAccessibleRoleAndName_WhenAddedFromDotNet()
    {
        await OpenAsync();

        await TestId("add-object").ClickAsync();

        await Expect(_page.GetByRole(AriaRole.Option, new() { Name = "Region code-1" })).ToBeVisibleAsync();
    }

    [Fact]
    public async Task Circuit_ShouldCarryNoPdfBytes_WhenOpeningLocalFile()
    {
        var path = Path.Combine(DocumentsDirectory, "range-large.pdf");
        var circuitBytes = 0L;
        var sawPdfHeader = false;
        _page.WebSocket += (_, socket) =>
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

        await _page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(path);

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-page-count", "40");
        await _viewer.WaitForReadyAsync();
        Assert.False(sawPdfHeader);
        var limit = new FileInfo(path).Length / 4;
        Assert.True(Interlocked.Read(ref circuitBytes) < limit, $"Circuit carried {circuitBytes} bytes.");
    }

    [Fact]
    public async Task UrlSource_ShouldUsePartialResponses_WhenServedByAspNetCore()
    {
        var statuses = new List<int>();
        var transferred = 0L;
        _page.Response += (_, response) =>
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
        await _page.GotoAsync("/?doc=secure-documents/letter.pdf");

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-document-state", "error");
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-error-code", "network");
        await Expect(TestId("last-error")).ToHaveTextAsync("Network");
    }

    [Fact]
    public async Task SecureDocument_ShouldOpen_WhenUserHasAuthenticationCookie()
    {
        await _page.GotoAsync("/demo-sign-in");

        await OpenAsync("secure-documents/letter.pdf");

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-page-count", "3");
    }

    [Fact]
    public async Task Viewer_ShouldKeepWorking_WhenCircuitIsLost()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");

        await _page.EvaluateAsync("() => Blazor.disconnect()");

        await _viewer.DragObjectByAsync("code-1", 30, 0);
        var rect = await _viewer.PageRectAsync("code-1");
        Assert.True(rect.X > 50, $"Expected the object to move from x 50, but it is at {rect.X}.");

        // .NET never heard about the drag, which shows the circuit really was gone while the viewer kept working.
        await TestId("add-object").ClickAsync();
        await Expect(TestId("last-change")).ToHaveTextAsync("Added Api code-1");
        await Expect(_viewer.Objects()).ToHaveCountAsync(1);
    }

    /// <summary>
    /// Draws on a sample whose drawn-object handler waits on a dialog, and returns the ID of the draft it leaves.
    /// </summary>
    private async Task<string> DrawWithConfirmDialogAsync()
    {
        await _page.GotoAsync("/?doc=documents/letter.pdf&confirmDraw=true");
        await _viewer.WaitForReadyAsync();
        await ActivateDrawToolAsync();
        await _viewer.DrawAsync(Drawn);
        await Expect(TestId("confirm-dialog")).ToBeVisibleAsync();
        return (await _viewer.Drafts.GetAttributeAsync("data-draft-id"))!;
    }

    [Fact]
    public async Task DrawDialog_ShouldShowDraftThatIsNotAnObject_WhenDrawnHandlerIsWaiting()
    {
        await DrawWithConfirmDialogAsync();

        await Expect(_viewer.Drafts).ToBeVisibleAsync();
        await Expect(_viewer.Objects()).ToHaveCountAsync(0);
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
        await _viewer.DragObjectByAsync("code-1", 40, 20);
        await Expect(TestId("last-change")).ToHaveTextAsync("Updated User code-1");
        await _page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();
        await _viewer.WaitForReadyAsync(2);
        await Expect(TestId("confirm-dialog")).ToBeVisibleAsync();
    }

    [Fact]
    public async Task DrawDialog_ShouldLeaveNoObjectBehind_WhenCanceled()
    {
        await DrawWithConfirmDialogAsync();

        await TestId("dialog-cancel").ClickAsync();

        await Expect(TestId("confirm-dialog")).ToBeHiddenAsync();
        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(_viewer.Objects()).ToHaveCountAsync(0);
        await Expect(TestId("object-list").Locator("li")).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task DrawDialog_ShouldCommitOneObjectWithDrawnId_WhenSaved()
    {
        var id = await DrawWithConfirmDialogAsync();

        await TestId("dialog-save").ClickAsync();

        await Expect(TestId("confirm-dialog")).ToBeHiddenAsync();
        await Expect(_viewer.Object(id)).ToBeVisibleAsync();
        await Expect(_viewer.Objects()).ToHaveCountAsync(1);
        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(TestId("object-list").Locator("li")).ToHaveCountAsync(1);
        await Expect(_page.Locator($"[data-listed-object=\"{id}\"]")).ToBeVisibleAsync();
        await Expect(TestId("last-kind")).ToHaveTextAsync("heading");
    }

    [Fact]
    public async Task DrawDialog_ShouldDiscardSecondDraftAndKeepFirst_WhenUserDrawsAgainWhileDialogIsOpen()
    {
        var first = await DrawWithConfirmDialogAsync();

        await _viewer.DrawAsync(new PageRect(370, 400, 120, 150));

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
        await _viewer.WaitForReadyAsync();
        await Expect(TestId("confirm-dialog")).ToBeHiddenAsync();
        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(_viewer.Objects()).ToHaveCountAsync(0);
        await Expect(TestId("object-list").Locator("li")).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task DrawTool_ShouldDiscardDrawnObject_WhenCircuitIsLostAndHandlerCannotBeAsked()
    {
        await _page.GotoAsync("/?doc=documents/letter.pdf&confirmDraw=true");
        await _viewer.WaitForReadyAsync();
        await ActivateDrawToolAsync();
        await _page.EvaluateAsync("() => Blazor.disconnect()");

        await _viewer.DrawAsync(Drawn);

        await Expect(_viewer.Drafts).ToHaveCountAsync(0);
        await Expect(_viewer.Objects()).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task ReadOnly_ShouldSuspendEditingAndResumeIt_WhenToggledFromDotNet()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await Expect(_viewer.Object("code-1")).ToBeVisibleAsync();

        await TestId("toggle-read-only").ClickAsync();
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-readonly", "true");
        // The kit's drag waits until the object catches the pointer, which it doesn't while read-only, so this drags
        // the mouse across it directly.
        var box = (await _viewer.Object("code-1").BoundingBoxAsync())!;
        await _page.Mouse.MoveAsync(box.X + box.Width / 2, box.Y + box.Height / 2);
        await _page.Mouse.DownAsync();
        await _page.Mouse.MoveAsync(box.X + box.Width / 2 + 40, box.Y + box.Height / 2 + 20, new() { Steps = 5 });
        await _page.Mouse.UpAsync();
        var whileReadOnly = await _viewer.PageRectAsync("code-1");
        await TestId("toggle-read-only").ClickAsync();
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-readonly", "false");
        await _viewer.DragObjectByAsync("code-1", 40, 20);

        Assert.Equal(new PageRect(50, 50, 150, 80), whileReadOnly);
        await Expect(TestId("last-change")).ToHaveTextAsync("Updated User code-1");
        RectAssert.Near(new PageRect(90, 70, 150, 80), await _viewer.PageRectAsync("code-1"));
    }

    [Fact]
    public async Task DeleteKey_ShouldRemoveObjectOnlyOnceApplicationRemovesIt_WhenDeleteRequestsAreHandled()
    {
        await _page.GotoAsync("/?doc=documents/letter.pdf&confirmDelete=true");
        await _viewer.WaitForReadyAsync();
        await TestId("add-object").ClickAsync();
        await _viewer.Object("code-1").ClickAsync();

        await _page.Keyboard.PressAsync("Delete");
        await Expect(TestId("confirm-delete")).ToHaveTextAsync("Delete code-1");
        var afterKey = await _viewer.Objects().CountAsync();
        await TestId("confirm-delete").ClickAsync();

        Assert.Equal(1, afterKey);
        await Expect(_viewer.Objects()).ToHaveCountAsync(0);
    }

    [Fact]
    public async Task MoveObjectByAsync_ShouldNudgeObjectAndReportItAsUserChange_WhenCalledFromDotNet()
    {
        await OpenAsync();
        await TestId("add-object").ClickAsync();
        await _viewer.Object("code-1").ClickAsync();
        await Expect(TestId("selected-object")).ToHaveTextAsync("code-1");

        await TestId("nudge-right").ClickAsync();

        await Expect(_viewer.Object("code-1")).ToHaveAttributeAsync("data-page-rect", "60,50,150,80");
        await Expect(TestId("last-change")).ToHaveTextAsync("Updated User code-1");
    }

    [Fact]
    public async Task AnnounceAsync_ShouldPutMessageInLiveRegion_WhenCalledFromDotNet()
    {
        await OpenAsync();

        await TestId("announce").ClickAsync();

        await Expect(_page.Locator(".pv-announcer")).ToHaveTextAsync("Sample announcement");
    }

    [Fact]
    public async Task KeyboardScope_ShouldMoveSelectedObject_WhenAltArrowIsPressedInApplicationPanel()
    {
        await _page.GotoAsync("/?doc=documents/letter.pdf&keyboardScope=true");
        await _viewer.WaitForReadyAsync(1);
        await TestId("add-object").ClickAsync();
        await _viewer.ClickObjectAsync("code-1");
        await Expect(TestId("selected-object")).ToHaveTextAsync("code-1");

        await TestId("tool-select").FocusAsync();
        await _page.Keyboard.PressAsync("Alt+ArrowRight");

        await Expect(_viewer.Object("code-1")).ToHaveAttributeAsync("data-page-rect", "51,50,150,80");
        await Expect(TestId("last-change")).ToHaveTextAsync("Updated User code-1");
        await Expect(TestId("tool-select")).ToBeFocusedAsync();
    }

    [Fact]
    public async Task DrawTool_ShouldReturnKindToDotNet_WhenToolHasKind()
    {
        await OpenAsync();
        await ActivateDrawToolAsync();

        await _viewer.DrawAsync(Drawn);

        await Expect(TestId("last-kind")).ToHaveTextAsync("heading");
        await Expect(_page.Locator("[data-object-kind=\"heading\"]")).ToHaveCountAsync(1);
        await Expect(_page.GetByRole(AriaRole.Option, new() { Name = "Heading region" })).ToBeVisibleAsync();
    }

    [Fact]
    public async Task HeadlessOptions_ShouldApply_WhenSetOnComponent()
    {
        await _page.GotoAsync("/?doc=documents/letter.pdf&headless=true");
        await _viewer.WaitForReadyAsync();

        await Expect(_page.GetByRole(AriaRole.Toolbar)).ToHaveCountAsync(0);
        var host = (await _viewer.Host.BoundingBoxAsync())!;
        var page = (await _viewer.Page(1).BoundingBoxAsync())!;
        Assert.True(page.Height <= host.Height, "Expected the whole page to fit.");

        await ActivateDrawToolAsync();
        await _viewer.DrawAsync(new PageRect(128.3, 182.7, 159.4, 142.6));
        await Expect(_viewer.Objects()).ToHaveCountAsync(1);
        var id = (await _viewer.Objects().GetAttributeAsync("data-object-id"))!;
        var rect = await _viewer.PageRectAsync(id);
        Assert.All([rect.X, rect.Y, rect.Width, rect.Height], value => Assert.Equal(Math.Round(value), value));
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-object-hit-area", "border");

        await ActivateSelectToolAsync();
        await _viewer.Object(id).FocusAsync();
        await _page.Keyboard.PressAsync("Delete");
        await Expect(_viewer.Objects()).ToHaveCountAsync(1);
    }

    [Fact]
    public async Task HeadlessOptions_ShouldMeasureAsDisplayed_WhenPageHasItsOwnRotation()
    {
        await _page.GotoAsync("/?doc=documents/rotate-90.pdf&headless=true");
        await _viewer.WaitForReadyAsync();

        await Expect(_viewer.Page(1)).ToHaveAttributeAsync("data-page-width", "792");
        await Expect(_viewer.Page(1)).ToHaveAttributeAsync("data-page-height", "612");
    }

    [Fact]
    public async Task SetPageRotation_ShouldRotateDisplayedPage_WhenCalledFromDotNet()
    {
        await OpenAsync();

        await TestId("rotate-page").ClickAsync();

        await Expect(_viewer.Page(1)).ToHaveAttributeAsync("data-rotation", "180");
        await _viewer.WaitForReadyAsync();
    }

    [Fact]
    public async Task CopyDocumentTo_ShouldDeliverAllBytes_WhenDocumentExceedsHubMessageLimit()
    {
        var path = Path.Combine(DocumentsDirectory, "range-large.pdf");
        await _page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(path);
        await _viewer.WaitForReadyAsync();

        await TestId("read-bytes").ClickAsync();

        await Expect(TestId("document-bytes")).ToHaveTextAsync(new FileInfo(path).Length.ToString());
        Assert.Empty(_consoleProblems);
    }

    [Fact]
    public async Task FileInput_ShouldReopenDocument_WhenSameFileIsChosenAgain()
    {
        var path = Path.Combine(DocumentsDirectory, "letter.pdf");
        await _page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(path);
        await Expect(TestId("load-count")).ToHaveTextAsync("1");

        await TestId("file-input").SetInputFilesAsync(path);

        await Expect(TestId("load-count")).ToHaveTextAsync("2");
        await _viewer.WaitForReadyAsync();
    }

    [Fact]
    public async Task FileInput_ShouldShowFirstPage_WhenShorterFileReplacesDocumentOnHighPage()
    {
        await _page.GotoAsync("/");
        await TestId("file-input").SetInputFilesAsync(Path.Combine(DocumentsDirectory, "letter.pdf"));
        await _viewer.WaitForReadyAsync();
        await _page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();
        await _page.GetByRole(AriaRole.Button, new() { Name = "Next page" }).ClickAsync();
        await _viewer.WaitForReadyAsync(3);

        await TestId("file-input").SetInputFilesAsync(Path.Combine(DocumentsDirectory, "a4.pdf"));

        // Until the new file starts loading, the old document still counts as ready on page 3, so name page 1.
        await _viewer.WaitForReadyAsync(1);
        await Expect(_page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 1 of 1");
    }

    [Fact]
    public async Task FileInput_ShouldReportInvalidPdf_WhenFileIsCorrupt()
    {
        await _page.GotoAsync("/");

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
        Assert.Equal("rendered", await _viewer.Page(3).GetAttributeAsync("data-page-state"));
    }

    [Fact]
    public async Task Controller_ShouldRunCommandsOnOpeningDocument_WhenIssuedBeforeViewerAttached()
    {
        await _page.GotoAsync("/?doc=documents/letter.pdf&earlyCommands=true");

        await _viewer.WaitForToolAsync(ViewerTool.DrawRectangle, "heading");
        await _viewer.WaitForReadyAsync(3);
        await Expect(_page.GetByRole(AriaRole.Status)).ToHaveTextAsync("Page 3 of 3");
    }

    [Fact]
    public async Task Options_ShouldTakeEffect_WhenChangedAfterViewerAttached()
    {
        await OpenAsync();
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-object-hit-area", "fill");

        await TestId("border-hit-area").ClickAsync();

        await Expect(_viewer.Host).ToHaveAttributeAsync("data-object-hit-area", "border");
        await Expect(_viewer.Page(1)).ToHaveAttributeAsync("data-page-state", "rendered");
    }

    [Fact]
    public async Task Viewer_ShouldWorkAgainWithoutErrors_WhenPageIsReloaded()
    {
        await OpenAsync();

        await _page.ReloadAsync();

        await _viewer.WaitForReadyAsync();
        Assert.Empty(_consoleProblems);
    }
}
