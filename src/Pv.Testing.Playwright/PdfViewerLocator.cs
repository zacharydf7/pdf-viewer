using System.Globalization;
using System.Text.Json;
using Microsoft.Playwright;
using Pv.Blazor;
using static Microsoft.Playwright.Assertions;

namespace Pv.Testing.Playwright;

/// <summary>
/// Finds and drives one PDF viewer through its test contract. Rectangles and distances are in the coordinates the
/// viewer's objects use, the same values the application receives, so tests work at any zoom, rotation or viewport.
/// Pointer actions use the real mouse. They first scroll what they press into view, then wait until the point they
/// press is really over their target.
/// </summary>
public sealed class PdfViewerLocator
{
    /// <summary>The page's only viewer.</summary>
    public PdfViewerLocator(IPage page) : this(page.Locator("pdf-viewer"))
    {
    }

    /// <summary>The viewer the locator finds, for a page with more than one.</summary>
    public PdfViewerLocator(ILocator host)
    {
        Host = host;
    }

    /// <summary>The <c>pdf-viewer</c> element.</summary>
    public ILocator Host { get; }

    /// <summary>The page element with this number, which exists only while the page is displayed.</summary>
    public ILocator Page(int number) => Host.Locator($".pv-page[data-page-number=\"{number}\"]");

    /// <summary>The object with this ID, while its page is displayed.</summary>
    public ILocator Object(string id) => Host.Locator($"[data-object-id={CssString(id)}]");

    /// <summary>The objects on the displayed page, optionally only those of one kind. Drafts aren't included.</summary>
    public ILocator Objects(string? kind = null) => kind is null
        ? Host.Locator("[data-object-id]")
        : Host.Locator($"[data-object-id][data-object-kind={CssString(kind)}]");

    /// <summary>The drawn objects on the displayed page that are still drafts.</summary>
    public ILocator Drafts => Host.Locator("[data-draft-id]");

    /// <summary>The selected objects on the displayed page.</summary>
    public ILocator Selected => Host.Locator("[data-object-id][aria-selected=\"true\"]");

    /// <summary>
    /// Waits until the document is open and a page is rendered with its text ready: the given page, or else whichever
    /// page is current once the document is open. Right after choosing a new document, the old one still counts as
    /// open until the new one starts loading, so pass a page the old document isn't showing, or first wait on
    /// something only the new document has.
    /// </summary>
    public async Task WaitForReadyAsync(int? page = null)
    {
        await Expect(Host).ToHaveAttributeAsync("data-document-state", "ready");
        var pageElement = Page(page ?? await CurrentPageAsync());
        await Expect(pageElement).ToHaveAttributeAsync("data-page-state", "rendered");
        await Expect(pageElement).ToHaveAttributeAsync("data-text-state", "ready");
    }

    /// <summary>
    /// Waits until the viewer has switched to the tool and, when a kind is given, until the draw tool gives its objects
    /// that kind. Switching tools from .NET goes through the circuit, so wait for this before a gesture that needs the
    /// tool.
    /// </summary>
    public async Task WaitForToolAsync(ViewerTool tool, string? kind = null)
    {
        await Expect(Host).ToHaveAttributeAsync("data-tool", JsonSerializer.SerializeToElement(tool).GetString()!);
        if (kind is not null)
        {
            await Expect(Host).ToHaveAttributeAsync("data-tool-kind", kind);
        }
    }

    /// <summary>
    /// Runs an action and waits until the viewer has recorded an object change after it, such as one made by a button
    /// in the application that changes objects over the circuit. Returns the change's sequence number. The application
    /// hears of a change shortly after the viewer records it, so check what it did with a retrying assertion.
    /// </summary>
    public async Task<int> RunAndWaitForChangeAsync(Func<Task> action)
    {
        var before = await LastChangeAsync();
        await action();
        await Expect(Host).Not.ToHaveAttributeAsync("data-last-change", before.ToString(CultureInfo.InvariantCulture));
        return await LastChangeAsync();
    }

    /// <summary>The object's rectangle, read from the page without rounding or culture-dependent parsing.</summary>
    public async Task<PageRect> PageRectAsync(string id)
    {
        var value = await Object(id).GetAttributeAsync("data-page-rect")
            ?? throw new InvalidOperationException($"Object '{id}' has no data-page-rect attribute.");
        var parts = value.Split(',').Select(part => double.Parse(part, CultureInfo.InvariantCulture)).ToArray();
        return new PageRect(parts[0], parts[1], parts[2], parts[3]);
    }

    /// <summary>
    /// Draws a rectangle with the real mouse, from its top-left corner to its bottom-right corner, on the given page or
    /// else the current one. Waits first until the draw tool is chosen and the viewer isn't read-only.
    /// </summary>
    public async Task DrawAsync(PageRect rect, int? page = null)
    {
        await WaitForToolAsync(ViewerTool.DrawRectangle);
        await Expect(Host).ToHaveAttributeAsync("data-readonly", "false");
        var pageNumber = page ?? await CurrentPageAsync();
        await ScrollIntoViewAsync(pageNumber, rect);
        var start = await PageToClientAsync(pageNumber, rect.X, rect.Y);
        var end = await PageToClientAsync(pageNumber, rect.X + rect.Width, rect.Y + rect.Height);
        await WaitForPointerTargetAsync(Page(pageNumber), start.X, start.Y);
        await DragAsync(start, end);
    }

    /// <summary>
    /// Drags an object with the real mouse by a distance in the coordinates objects use, so its rectangle moves by that
    /// much at any zoom or rotation. The object must be on the displayed page and able to catch the pointer.
    /// </summary>
    public async Task DragObjectByAsync(string id, double deltaX, double deltaY)
    {
        var pageNumber = await CurrentPageAsync();
        var rect = await PageRectAsync(id);
        var moved = rect with { X = rect.X + deltaX, Y = rect.Y + deltaY };
        var left = Math.Min(rect.X, moved.X);
        var top = Math.Min(rect.Y, moved.Y);
        await ScrollIntoViewAsync(pageNumber,
            new PageRect(left, top, Math.Abs(deltaX) + rect.Width, Math.Abs(deltaY) + rect.Height));
        var from = await PressPointAsync(id);
        var origin = await PageToClientAsync(pageNumber, 0, 0);
        var offset = await PageToClientAsync(pageNumber, deltaX, deltaY);
        await WaitForPointerTargetAsync(Object(id), from.X, from.Y);
        await DragAsync(from, (from.X + offset.X - origin.X, from.Y + offset.Y - origin.Y));
    }

    /// <summary>
    /// Clicks an object with the real mouse where it catches the pointer: just inside its edge while it's unselected,
    /// which also works with the border hit area, and at its center once it's selected.
    /// </summary>
    public async Task ClickObjectAsync(string id)
    {
        await ScrollIntoViewAsync(await CurrentPageAsync(), await PageRectAsync(id));
        var point = await PressPointAsync(id);
        await WaitForPointerTargetAsync(Object(id), point.X, point.Y);
        await Host.Page.Mouse.ClickAsync((float)point.X, (float)point.Y);
    }

    /// <summary>
    /// Moves the mouse to a point in the browser viewport and waits until the topmost element there is the target or
    /// inside it, for a gesture with the real mouse that the locator has no method for, such as dragging a resize
    /// handle. The pointer methods do this because a tooltip or dialog can cover the target for a moment, and a
    /// tooltip shown while the mouse is over its button stays until the mouse leaves. A point outside the browser
    /// viewport never reaches anything, so scroll the target into view first.
    /// </summary>
    public async Task WaitForPointerTargetAsync(ILocator target, double x, double y)
    {
        await Host.Page.Mouse.MoveAsync((float)x, (float)y);
        await using var element = await target.ElementHandleAsync();
        try
        {
            await Host.Page.WaitForFunctionAsync(
                """
                ({ target, x, y }) => {
                  const element = document.elementFromPoint(x, y);
                  return element !== null && target.contains(element);
                }
                """, new { target = element, x, y });
        }
        catch (TimeoutException exception)
        {
            throw new TimeoutException(
                $"The pointer at ({x:0.#}, {y:0.#}) never reached {target}. Something may cover it, or the active tool " +
                "or read-only mode may keep it from catching the pointer.", exception);
        }
    }

    /// <summary>
    /// The rectangle a run of the page's own text takes up, in the coordinates objects use, read from the text layer
    /// once it's ready. The text must be within one run, as pdf.js extracted it. Use it to draw around or find text.
    /// </summary>
    public async Task<PageRect> TextRectAsync(string text, int? page = null)
    {
        var pageNumber = page ?? await CurrentPageAsync();
        await Expect(Page(pageNumber)).ToHaveAttributeAsync("data-text-state", "ready");
        var values = await Host.EvaluateAsync<double[]?>(
            """
            (host, [pageNumber, text]) => {
              const layer = host.querySelector(`.pv-page[data-page-number="${pageNumber}"] .textLayer`);
              const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
                const start = node.data.indexOf(text);
                if (start < 0) continue;
                const range = document.createRange();
                range.setStart(node, start);
                range.setEnd(node, start + text.length);
                const box = range.getBoundingClientRect();
                const corners = [[box.left, box.top], [box.right, box.bottom]]
                  .map(([x, y]) => host.clientToPage(pageNumber, { x, y }));
                const xs = corners.map(({ x }) => x);
                const ys = corners.map(({ y }) => y);
                const left = Math.min(...xs);
                const top = Math.min(...ys);
                return [left, top, Math.max(...xs) - left, Math.max(...ys) - top];
              }
              return null;
            }
            """, new object[] { pageNumber, text });
        if (values is null)
        {
            throw new InvalidOperationException($"Page {pageNumber} has no run of text containing '{text}'.");
        }
        return new PageRect(values[0], values[1], values[2], values[3]);
    }

    private async Task<int> CurrentPageAsync()
    {
        var value = await Host.GetAttributeAsync("data-current-page")
            ?? throw new InvalidOperationException("The viewer has no document open.");
        return int.Parse(value, CultureInfo.InvariantCulture);
    }

    private async Task<int> LastChangeAsync() =>
        int.Parse((await Host.GetAttributeAsync("data-last-change"))!, CultureInfo.InvariantCulture);

    private async Task<(double X, double Y)> PageToClientAsync(int pageNumber, double x, double y)
    {
        var point = await Host.EvaluateAsync<double[]?>(
            "(host, [page, x, y]) => { const p = host.pageToClient(page, { x, y }); return p && [p.x, p.y]; }",
            new object[] { pageNumber, x, y });
        return point is null
            ? throw new InvalidOperationException($"Page {pageNumber} isn't displayed.")
            : (point[0], point[1]);
    }

    /// <summary>
    /// Scrolls the viewer into the browser window, and then scrolls within it so that an area of the displayed page is in
    /// the part of the viewer the browser shows, centering it when it isn't already there. A real mouse can't press
    /// what's scrolled out of sight.
    /// </summary>
    private async Task ScrollIntoViewAsync(int pageNumber, PageRect area)
    {
        await Host.ScrollIntoViewIfNeededAsync();
        await Host.EvaluateAsync(
            """
            (host, [page, x, y, width, height]) => {
              const corners = [host.pageToClient(page, { x, y }), host.pageToClient(page, { x: x + width, y: y + height })];
              if (corners[0] === undefined) return;
              const viewport = host.querySelector(".pv-viewport");
              const box = viewport.getBoundingClientRect();
              const visible = {
                left: Math.max(box.left, 0), top: Math.max(box.top, 0),
                right: Math.min(box.left + viewport.clientWidth, innerWidth),
                bottom: Math.min(box.top + viewport.clientHeight, innerHeight),
              };
              const xs = corners.map((point) => point.x);
              const ys = corners.map((point) => point.y);
              const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
              if (left >= visible.left && right <= visible.right && top >= visible.top && bottom <= visible.bottom) return;
              viewport.scrollBy((left + right - visible.left - visible.right) / 2,
                (top + bottom - visible.top - visible.bottom) / 2);
            }
            """, new object[] { pageNumber, area.X, area.Y, area.Width, area.Height });
    }

    /// <summary>Where the object catches the pointer and pressing starts no resize. See <see cref="ClickObjectAsync"/>.</summary>
    private async Task<(double X, double Y)> PressPointAsync(string id)
    {
        var element = Object(id);
        var box = await element.BoundingBoxAsync()
            ?? throw new InvalidOperationException($"Object '{id}' isn't shown.");
        var selected = await element.GetAttributeAsync("aria-selected") == "true";
        return selected ? (box.X + box.Width / 2, box.Y + box.Height / 2) : (box.X + 1, box.Y + box.Height / 2);
    }

    private async Task DragAsync((double X, double Y) from, (double X, double Y) to)
    {
        var mouse = Host.Page.Mouse;
        await mouse.MoveAsync((float)from.X, (float)from.Y);
        await mouse.DownAsync();
        await mouse.MoveAsync((float)to.X, (float)to.Y, new() { Steps = 5 });
        await mouse.UpAsync();
    }

    /// <summary>A CSS string literal, so any ID or kind can go in an attribute selector.</summary>
    private static string CssString(string value) => $"\"{value.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"";
}
