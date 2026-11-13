# PDF viewer (working title)

A PDF viewer for .NET and the web, built for applications that need to test what they display. It renders with
[PDF.js](https://mozilla.github.io/pdf.js/) and needs no commercial SDK.

Pages and objects are real DOM elements, so tests can find them by selector, assert on their attributes and drag them, instead
of working out pixel positions on a canvas. See the [test contract](docs/test-contract.md).

```razor
<PdfViewer Source="@documentUrl" Objects="_objects" OnObjectsChanged="ApplyUserChanges"
           Controller="_viewer" Options="_options" />

@code {
    private readonly List<ViewerObject> _objects = [];       // the source of truth: change it, and the viewer follows
    private readonly PdfViewerController _viewer = new();
    private PdfViewerOptions _options = new() { RoundCoordinates = true };

    private Task ShowPageThree() => _viewer.GoToPageAsync(3);   // completes once page 3 is shown
}
```

Objects are declarative: when your list changes, the viewer sends the browser only what differs. It reports what the
user draws, moves, resizes or deletes so you can apply those changes to your list, and any you don't apply are undone on
the next render. The controller drives the viewer from code, including from other components, and holds commands issued
before the viewer is ready. Options can change at any time.

To confirm a new object before keeping it, handle `OnObjectDrawn`. The drawing stays on the page as a draft while your
handler runs, for example while it waits on a dialog, and the viewer stays usable. Add the object to your list to keep
it, or call `CommitDraftAsync` if you don't bind `Objects`. If the handler finishes without doing either, the draft is
discarded.

Set `ReadOnly` to keep the user from selecting, drawing or editing, for example while a dialog is open. It changes
nothing about the objects, and the tool works again when you turn it off. Arrow keys move the focused object by steps
you can set in the options, and `MoveObjectByAsync` does the same from code. To confirm a deletion, handle
`OnDeleteRequested`: the Delete key then removes nothing until you take the object out of your list.

`Pv` is a placeholder name, and the project will be renamed.

## Status

Early. The foundation works, but this is not yet a complete viewer.

| Works today | Not built yet |
|---|---|
| One page at a time, with zoom, Ctrl+wheel zoom, fit modes, and viewer or per-page rotation | Continuous scrolling with virtualization |
| Text selection through the text layer | Search, thumbnails, outline, print and download |
| Rectangle objects: draw, select, move, resize, lock, hide, app kinds, CSS classes and app data, styles, keyboard control, read-only mode | Links and existing PDF annotations, which are painted but not clickable |
| Loading from a URL with range requests and cookies, or from a local file | Server-side stream sources, password prompts |
| Getting the document's bytes back in .NET as a chunked stream | Tagged structure exposed to screen readers, a verified accessibility baseline |
| Blazor component and basic toolbar on InteractiveServer | InteractiveWebAssembly and Auto render modes, which are untested |

## How it's built

```text
src/viewer-core    TypeScript core: the <pdf-viewer> custom element. Owns rendering, scrolling, zoom and objects.
src/Pv.Blazor      Razor component over the core. Renders one empty host element, then sends commands and receives events.
samples/Pv.Sample  Blazor Server app used for manual testing and by the end-to-end tests.
tests/fixtures     Generated PDFs with ink at known positions, for checking coordinates against real rendering.
```

Three rules keep it fast and testable:

- **The browser owns interaction.** Scrolling, zooming and dragging never wait for the server.
- **Opening a document sends no PDF bytes over the Blazor circuit.** The browser fetches URLs and reads local files itself.
  Only `CopyDocumentToAsync` sends bytes to .NET, and only when you call it.
- **All pdf.js calls go through `engine.ts`,** so upgrades touch one file.

## Building

You need the .NET 10 SDK and Node.js. Building `Pv.Blazor` builds the TypeScript core too.

```shell
dotnet build Pv.slnx
dotnet run --project samples/Pv.Sample
```

Then open the URL it prints, and either pick a local PDF or add `?doc=documents/letter.pdf` to the address.

## Hosting

The viewer's pdf.js files include `.bcmap` and `.icc` assets, which `UseStaticFiles` doesn't serve by default. Without them,
some CJK text and CMYK colors render wrong. `MapStaticAssets` serves them as is. With `UseStaticFiles`, add both extensions to
a `FileExtensionContentTypeProvider`.

## Testing

```shell
# TypeScript core
cd src/viewer-core
npm test                      # unit tests
npx playwright install        # once
npm run test:browser          # real browsers: Chromium, Firefox and WebKit, then the performance budgets
npm run test:performance      # Chromium performance budgets only, printing each timing

# .NET
dotnet test tests/Pv.Blazor.Tests     # bUnit
dotnet test tests/Pv.EndToEnd         # Playwright against the running sample
```

To install the browser for the .NET end-to-end tests, run this once after building:

```shell
node tests/Pv.EndToEnd/bin/Debug/net10.0/.playwright/package/cli.js install chromium
```

Browser suites run without test-level retries, so a flaky test fails rather than hiding.

## Styling

The viewer fills its parent's height, with a minimum of 300px so it stays visible in a parent with no set height. In a shorter
parent it overflows, and you can lower the minimum with the `--pv-viewer-min-height` CSS variable.
`--pv-viewer-background` sets the color around the page.

## Known limitations

- **Touch input isn't supported yet.** A finger pans the page instead of drawing, moving or resizing objects.
- **Range requests only help if the file allows it.** pdf.js visits every page in the page tree when opening a document, so
  a PDF with page dictionaries scattered through the file is fetched almost completely, even to show one page.
- **The fonts bundled with pdf.js 6.5.438 include Liberation Sans under GPLv2 with exceptions.** Upstream has removed them
  for its next release, so move to that release before distributing this outside private use.
