using Bunit;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;
using Pv.Contract;
using Pv.Sample.Components;
using Pv.Testing.Bunit;

namespace Pv.Blazor.Tests;

/// <summary>
/// Runs the sample app's contract scenarios with the fake viewer. Pv.EndToEnd runs the same scenarios in a browser.
/// </summary>
public class SampleContractTests : BunitContext, ISampleDriver
{
    private readonly FakePdfViewers _viewers;
    private IRenderedComponent<Home> _home = default!;

    public SampleContractTests()
    {
        _viewers = Services.AddFakePdfViewers();
    }

    private FakePdfViewer Viewer => _viewers.Viewer;

    [Theory]
    [MemberData(nameof(SampleContract.Names), MemberType = typeof(SampleContract))]
    public Task Scenario_ShouldPlayOutAsInBrowser_WhenRunWithFakeViewer(string scenario) =>
        SampleContract.RunAsync(scenario, this);

    async Task ISampleDriver.OpenAsync(string options)
    {
        Services.GetRequiredService<NavigationManager>().NavigateTo($"/?doc=documents/letter.pdf&{options}");
        _home = Render<Home>();
        await Viewer.LoadDocumentAsync(pageCount: 3);
    }

    Task ISampleDriver.ClickAsync(string testId) =>
        _home.Find($"[data-testid='{testId}']").ClickAsync(new MouseEventArgs());

    Task ISampleDriver.WaitForToolAsync(ViewerTool tool, string? kind)
    {
        _home.WaitForAssertion(() =>
        {
            Assert.Equal(tool, Viewer.Tool);
            if (kind is not null)
            {
                Assert.Equal(kind, Viewer.DrawDefaults?.Kind);
            }
        });
        return Task.CompletedTask;
    }

    /// <summary>
    /// When the sample decides on drawn objects, the draw stays unfinished until its dialog closes, so this returns
    /// as soon as the draft appears.
    /// </summary>
    async Task<string> ISampleDriver.DrawAsync(PageRect rect)
    {
        var drawing = Viewer.SimulateDrawAsync(rect);
        _home.WaitForAssertion(() => Assert.True(drawing.IsCompleted || Viewer.Drafts.Count > 0));
        return drawing.IsCompleted ? await drawing : Viewer.Drafts[^1].Id;
    }

    Task ISampleDriver.DragObjectByAsync(string id, double deltaX, double deltaY)
    {
        var rect = Viewer.Objects.Single(viewerObject => viewerObject.Id == id).Rect;
        return Viewer.SimulateEditAsync(id, rect with { X = rect.X + deltaX, Y = rect.Y + deltaY }, EditGesture.Move);
    }

    Task ISampleDriver.ClickObjectAsync(string id) => Viewer.SimulateClickAsync(id);

    Task ISampleDriver.ClickEmptyPageAsync() => Viewer.SimulateClickAsync(null);

    Task ISampleDriver.PressDeleteAsync(string id) => Viewer.SimulateDeleteKeyAsync(id);

    /// <summary>Compares the text with whitespace collapsed and trimmed, as Playwright's text assertions do.</summary>
    Task ISampleDriver.ExpectTextAsync(string testId, string text)
    {
        _home.WaitForAssertion(() => Assert.Equal(text,
            string.Join(' ', _home.Find($"[data-testid='{testId}']").TextContent.Split((char[]?)null,
                StringSplitOptions.RemoveEmptyEntries))));
        return Task.CompletedTask;
    }

    Task ISampleDriver.ExpectCountsAsync(int objects, int drafts)
    {
        _home.WaitForAssertion(() => Assert.Equal((objects, drafts), (Viewer.Objects.Count, Viewer.Drafts.Count)));
        return Task.CompletedTask;
    }
}
