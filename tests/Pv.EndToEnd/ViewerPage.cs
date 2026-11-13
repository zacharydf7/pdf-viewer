using System.Globalization;
using Microsoft.Playwright;
using static Microsoft.Playwright.Assertions;

namespace Pv.EndToEnd;

/// <summary>
/// Drives the viewer through its public DOM contract, the same way an application's own tests would. Positions are
/// always read from the live page, so these helpers work at any zoom and with any page size.
/// </summary>
public sealed class ViewerPage(IPage page)
{
    public IPage Page { get; } = page;

    public ILocator Host => Page.Locator("pdf-viewer");

    public ILocator PageElement(int number = 1) => Page.Locator($".pv-page[data-page-number=\"{number}\"]");

    public ILocator Object(string id) => Page.Locator($"[data-object-id=\"{id}\"]");

    public ILocator Objects => Page.Locator("[data-object-id]");

    /// <summary>The drawn objects on the displayed page that are still drafts.</summary>
    public ILocator Drafts => Page.Locator("[data-draft-id]");

    public async Task WaitForPageAsync(int number = 1)
    {
        await Expect(PageElement(number)).ToHaveAttributeAsync("data-page-state", "rendered");
        await Expect(PageElement(number)).ToHaveAttributeAsync("data-text-state", "ready");
    }

    /// <summary>Drags with the real mouse between two positions, given as fractions of the displayed page.</summary>
    public async Task DragOnPageAsync(float fromX, float fromY, float toX, float toY, int pageNumber = 1)
    {
        var box = (await PageElement(pageNumber).BoundingBoxAsync())!;
        await Page.Mouse.MoveAsync(box.X + box.Width * fromX, box.Y + box.Height * fromY);
        await Page.Mouse.DownAsync();
        await Page.Mouse.MoveAsync(box.X + box.Width * toX, box.Y + box.Height * toY, new() { Steps = 5 });
        await Page.Mouse.UpAsync();
    }

    /// <summary>Drags an object by a distance in CSS pixels.</summary>
    public async Task DragObjectAsync(string id, float deltaX, float deltaY)
    {
        var box = (await Object(id).BoundingBoxAsync())!;
        var x = box.X + box.Width / 2;
        var y = box.Y + box.Height / 2;
        await Page.Mouse.MoveAsync(x, y);
        await Page.Mouse.DownAsync();
        await Page.Mouse.MoveAsync(x + deltaX, y + deltaY, new() { Steps = 5 });
        await Page.Mouse.UpAsync();
    }

    /// <summary>The object's rectangle in page space, which is the same value the application receives.</summary>
    public async Task<(double X, double Y, double Width, double Height)> PageRectAsync(string id)
    {
        var parts = (await Object(id).GetAttributeAsync("data-page-rect"))!.Split(',');
        var values = parts.Select(part => double.Parse(part, CultureInfo.InvariantCulture)).ToArray();
        return (values[0], values[1], values[2], values[3]);
    }
}
