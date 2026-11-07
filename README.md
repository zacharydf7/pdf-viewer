# PDF viewer (working title)

A PDF viewer for .NET and the web, built for applications that need to test what they display. It renders with
[PDF.js](https://mozilla.github.io/pdf.js/) and needs no commercial SDK.

Pages and objects are real DOM elements, so tests can find, assert and drag them directly instead of aiming a mouse at a
canvas. See the [test contract](docs/test-contract.md).

```razor
<PdfViewer Source="@documentUrl" InitialPage="1" OnDocumentLoaded="HandleLoaded" OnObjectChanged="HandleObjectChanged" />
```

`Pv` is a placeholder name, and the project will be renamed.

## Status

Early. The foundation works, but this is not yet a complete viewer.

| Works today | Not built yet |
|---|---|
| One page at a time, with zoom, Ctrl+wheel zoom, fit modes, and viewer or per-page rotation | Continuous scrolling with virtualization |
| Text selection through the text layer | Search, thumbnails, outline, print and download |
| Rectangle objects: draw, select, move, resize, lock, tags, styles, keyboard control | Links and existing PDF annotations, which are painted but not clickable |
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
- **PDF bytes never cross the Blazor circuit.** The browser fetches URLs and reads local files itself.
- **All pdf.js calls go through `engine.ts`,** so upgrades touch one file.

## Building

You need the .NET 10 SDK and Node.js. Building `Pv.Blazor` builds the TypeScript core too.

```shell
dotnet build Pv.slnx
dotnet run --project samples/Pv.Sample
```

Then open the URL it prints, and either pick a local PDF or add `?doc=documents/letter.pdf` to the address.

## Testing

```shell
# TypeScript core
cd src/viewer-core
npm test                      # unit tests
npx playwright install        # once
npm run test:browser          # real browsers: Chromium, Firefox and WebKit

# .NET
dotnet test tests/Pv.Blazor.Tests     # bUnit
dotnet test tests/Pv.EndToEnd         # Playwright against the running sample
```

To install the browser for the .NET end-to-end tests, run this once after building:

```shell
node tests/Pv.EndToEnd/bin/Debug/net10.0/.playwright/package/cli.js install chromium
```

Browser suites run without test-level retries, so a flaky test fails rather than hiding.

## Known limitations

- **Range requests only help if the file allows it.** pdf.js visits every page in the page tree when opening a document, so
  a PDF with page dictionaries scattered through the file is fetched almost completely, even to show one page.
- **The fonts bundled with pdf.js 6.5.438 include Liberation Sans under GPLv2 with exceptions.** Upstream has removed them
  for its next release, so move to that release before distributing this outside private use.
