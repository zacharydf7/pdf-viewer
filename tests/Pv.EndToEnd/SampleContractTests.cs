using Microsoft.Playwright;
using Pv.Blazor;
using Pv.Contract;
using Pv.Testing.Playwright;
using static Microsoft.Playwright.Assertions;

namespace Pv.EndToEnd;

/// <summary>
/// Runs the sample app's contract scenarios in a browser. Pv.Blazor.Tests runs the same scenarios with the fake viewer.
/// </summary>
[Collection(SampleAppCollection.Name)]
public sealed class SampleContractTests(SampleAppFixture app) : IAsyncLifetime, ISampleDriver
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

    [Theory]
    [MemberData(nameof(SampleContract.Names), MemberType = typeof(SampleContract))]
    public Task Scenario_ShouldPlayOutAsWithFakeViewer_WhenRunInBrowser(string scenario) =>
        SampleContract.RunAsync(scenario, this);

    async Task ISampleDriver.OpenAsync(string options)
    {
        await _page.GotoAsync($"/?doc=documents/letter.pdf&{options}");
        await _viewer.WaitForReadyAsync(1);
    }

    Task ISampleDriver.ClickAsync(string testId) => _page.GetByTestId(testId).ClickAsync();

    Task ISampleDriver.WaitForToolAsync(ViewerTool tool, string? kind) => _viewer.WaitForToolAsync(tool, kind);

    async Task<string> ISampleDriver.DrawAsync(PageRect rect)
    {
        var made = _viewer.Host.Locator("[data-object-id], [data-draft-id]");
        var before = await IdsAsync(made);
        await _viewer.DrawAsync(rect);
        await Expect(made).ToHaveCountAsync(before.Count + 1);
        return (await IdsAsync(made)).Except(before).Single();
    }

    Task ISampleDriver.DragObjectByAsync(string id, double deltaX, double deltaY) =>
        _viewer.DragObjectByAsync(id, deltaX, deltaY);

    Task ISampleDriver.ClickObjectAsync(string id) => _viewer.ClickObjectAsync(id);

    /// <summary>The page's top-right corner is empty and on screen in the sample's fit-width layout.</summary>
    async Task ISampleDriver.ClickEmptyPageAsync()
    {
        var box = (await _viewer.Page(1).BoundingBoxAsync())!;
        await _page.Mouse.ClickAsync(box.X + box.Width - 20, box.Y + 20);
    }

    async Task ISampleDriver.PressDeleteAsync(string id)
    {
        await _viewer.Object(id).FocusAsync();
        await _page.Keyboard.PressAsync("Delete");
    }

    Task ISampleDriver.ExpectTextAsync(string testId, string text) =>
        Expect(_page.GetByTestId(testId)).ToHaveTextAsync(text);

    async Task ISampleDriver.ExpectCountsAsync(int objects, int drafts)
    {
        await Expect(_viewer.Objects()).ToHaveCountAsync(objects);
        await Expect(_viewer.Drafts).ToHaveCountAsync(drafts);
    }

    private static async Task<IReadOnlyList<string>> IdsAsync(ILocator elements) =>
        await elements.EvaluateAllAsync<string[]>(
            "elements => elements.map(element => element.dataset.objectId ?? element.dataset.draftId)");
}
