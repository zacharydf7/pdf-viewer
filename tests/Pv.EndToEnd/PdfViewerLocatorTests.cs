using Microsoft.Playwright;
using Pv.Blazor;
using Pv.Testing.Playwright;
using static Microsoft.Playwright.Assertions;

namespace Pv.EndToEnd;

/// <summary>
/// The test kit against the sample app. The rotated fixtures carry their own page rotation, and the headless sample
/// measures objects in display coordinates and catches the pointer only at their borders.
/// </summary>
[Collection(SampleAppCollection.Name)]
public sealed class PdfViewerLocatorTests(SampleAppFixture app) : IAsyncLifetime
{
    private IBrowserContext _context = default!;
    private IPage _page = default!;
    private PdfViewerLocator _viewer = default!;

    public async Task InitializeAsync()
    {
        var viewport = new ViewportSize { Width = 1280, Height = 900 };
        _context = await app.Browser.NewContextAsync(new() { BaseURL = app.BaseUrl, ViewportSize = viewport });
        _page = await _context.NewPageAsync();
        _viewer = new PdfViewerLocator(_page);
    }

    public async Task DisposeAsync() => await _context.DisposeAsync();

    private async Task OpenAsync(string document, bool headless)
    {
        await _page.GotoAsync($"/?doc=documents/{document}.pdf&headless={headless}");
        await _viewer.WaitForReadyAsync();
    }

    [Theory]
    [InlineData("letter", false)]
    [InlineData("rotate-90", false)]
    [InlineData("rotate-180", false)]
    [InlineData("rotate-270", false)]
    [InlineData("letter", true)]
    [InlineData("rotate-90", true)]
    [InlineData("rotate-180", true)]
    [InlineData("rotate-270", true)]
    public async Task DrawAsync_ShouldLandWithinOneUnit_WhenGivenRotatedPageInEitherCoordinates(string document,
        bool headless)
    {
        await OpenAsync(document, headless);
        await _page.GetByTestId("tool-draw").ClickAsync();
        await _viewer.WaitForToolAsync(ViewerTool.DrawRectangle, "heading");
        var rect = new PageRect(100.5, 150.25, 120, 60);

        await _viewer.DrawAsync(rect);

        await Expect(_viewer.Objects("heading")).ToHaveCountAsync(1);
        var id = (await _viewer.Objects("heading").GetAttributeAsync("data-object-id"))!;
        RectAssert.Near(rect, await _viewer.PageRectAsync(id));
    }

    [Theory]
    [InlineData("letter", false)]
    [InlineData("rotate-90", false)]
    [InlineData("rotate-180", false)]
    [InlineData("rotate-270", false)]
    [InlineData("letter", true)]
    [InlineData("rotate-90", true)]
    [InlineData("rotate-180", true)]
    [InlineData("rotate-270", true)]
    public async Task DragObjectByAsync_ShouldMoveObjectByPageUnits_WhenGivenRotatedPageInEitherCoordinates(
        string document, bool headless)
    {
        await OpenAsync(document, headless);
        await _page.GetByTestId("add-object").ClickAsync();
        await Expect(_viewer.Object("code-1")).ToBeVisibleAsync();

        await _viewer.DragObjectByAsync("code-1", 30, 20);

        RectAssert.Near(new PageRect(80, 70, 150, 80), await _viewer.PageRectAsync("code-1"));
    }

    [Fact]
    public async Task ClickObjectAsync_ShouldSelectObjectAndKeepIt_WhenObjectsCatchPointerOnlyAtBorder()
    {
        await OpenAsync("letter", headless: true);
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-object-hit-area", "border");
        await _page.GetByTestId("add-object").ClickAsync();

        await _viewer.ClickObjectAsync("code-1");
        await Expect(_viewer.Selected).ToHaveAttributeAsync("data-object-id", "code-1");
        await _viewer.ClickObjectAsync("code-1");

        await Expect(_viewer.Selected).ToHaveAttributeAsync("data-object-id", "code-1");
        Assert.Equal(new PageRect(50, 50, 150, 80), await _viewer.PageRectAsync("code-1"));
    }

    [Fact]
    public async Task ClickObjectAsync_ShouldThrowNamingObject_WhenObjectCannotCatchPointer()
    {
        await OpenAsync("letter", headless: false);
        await _page.GetByTestId("add-object").ClickAsync();
        await _page.GetByTestId("toggle-read-only").ClickAsync();
        await Expect(_viewer.Host).ToHaveAttributeAsync("data-readonly", "true");
        _page.SetDefaultTimeout(1000);

        var exception = await Assert.ThrowsAsync<TimeoutException>(() => _viewer.ClickObjectAsync("code-1"));

        Assert.Contains("code-1", exception.Message);
    }

    [Fact]
    public async Task WaitForPointerTargetAsync_ShouldLetTestDragResizeHandle_WhenHandleIsShown()
    {
        await OpenAsync("letter", headless: false);
        await _page.GetByTestId("add-object").ClickAsync();
        await _viewer.ClickObjectAsync("code-1");
        var handle = _page.Locator("[data-handle=\"se\"][data-handle-for=\"code-1\"]");
        var box = (await handle.BoundingBoxAsync())!;
        var (x, y) = (box.X + box.Width / 2, box.Y + box.Height / 2);

        await _viewer.WaitForPointerTargetAsync(handle, x, y);
        await _page.Mouse.MoveAsync(x, y);
        await _page.Mouse.DownAsync();
        await _page.Mouse.MoveAsync(x + 30, y + 20, new() { Steps = 5 });
        await _page.Mouse.UpAsync();

        var rect = await _viewer.PageRectAsync("code-1");
        Assert.Equal((50, 50), (rect.X, rect.Y));
        Assert.True(rect.Width > 150 && rect.Height > 80, $"Expected the object to grow, but it is {rect}.");
    }

    [Fact]
    public async Task RunAndWaitForChangeAsync_ShouldReturnNewSequence_WhenChangeArrivesOverCircuit()
    {
        await OpenAsync("letter", headless: false);
        var before = int.Parse((await _viewer.Host.GetAttributeAsync("data-last-change"))!);

        // The sample adds the object in .NET, so the click returns before the viewer has it.
        var sequence = await _viewer.RunAndWaitForChangeAsync(() => _page.GetByTestId("add-object").ClickAsync());

        Assert.True(sequence > before, $"Expected a sequence after {before}, but got {sequence}.");
        Assert.Equal(sequence.ToString(), await _viewer.Host.GetAttributeAsync("data-last-change"));
    }

    [Fact]
    public async Task DrawAsync_ShouldScrollStartIntoView_WhenItIsBelowVisiblePartOfPage()
    {
        await OpenAsync("letter", headless: false);
        await _page.GetByTestId("tool-draw").ClickAsync();
        await _viewer.WaitForToolAsync(ViewerTool.DrawRectangle, "heading");
        var rect = new PageRect(300, 700, 100, 60);

        await _viewer.DrawAsync(rect);

        await Expect(_viewer.Objects("heading")).ToHaveCountAsync(1);
        RectAssert.Near(rect, await _viewer.PageRectAsync(
            (await _viewer.Objects("heading").GetAttributeAsync("data-object-id"))!));
    }

    // The fixture's sample text starts at the ink's left edge, x 100, with its baseline 40 units below the ink, at y 290.
    [Theory]
    [InlineData("letter")]
    [InlineData("rotate-90")]
    public async Task TextRectAsync_ShouldCoverTextInPageUnits_WhenGivenPageAtAnyRotation(string document)
    {
        await OpenAsync(document, headless: false);

        var rect = await _viewer.TextRectAsync("Page 1 sample text");

        Assert.InRange(rect.X, 98, 102);
        Assert.InRange(290, rect.Y, rect.Y + rect.Height);
        Assert.InRange(rect.Height, 12, 30);
        Assert.InRange(rect.Width, 100, 200);
    }

    [Fact]
    public async Task TextRectAsync_ShouldThrow_WhenTextIsNotOnPage()
    {
        await OpenAsync("letter", headless: false);

        await Assert.ThrowsAsync<InvalidOperationException>(() => _viewer.TextRectAsync("not in this document"));
    }

    [Fact]
    public async Task OutsideViewers_ShouldLeaveOutDocumentText_WhenTextIsInTextLayer()
    {
        await OpenAsync("letter", headless: false);
        await Expect(_page.GetByText("sample text")).ToHaveCountAsync(1);

        await Expect(_page.GetByText("sample text").OutsideViewers()).ToHaveCountAsync(0);
        await Expect(_page.GetByText("Last change").OutsideViewers()).ToHaveCountAsync(1);
    }
}
