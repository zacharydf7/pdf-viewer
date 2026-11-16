# Testing an application that uses the viewer

The viewer's pages and objects are real DOM elements, described in the [test contract](test-contract.md). For .NET tests
that use Playwright, `Pv.Testing.Playwright` wraps that contract, so your tests don't have to work out screen
positions, parse attributes or know which ones to wait on. For component tests, `Pv.Testing.Bunit` puts a fake viewer
in the browser's place; see [component tests with bUnit](#component-tests-with-bunit).

```csharp
using Pv.Blazor;
using Pv.Testing.Playwright;

var viewer = new PdfViewerLocator(page);        // or new PdfViewerLocator(locator) for one of several viewers
await viewer.WaitForReadyAsync();

await page.GetByRole(AriaRole.Button, new() { Name = "Draw heading" }).ClickAsync();
await viewer.WaitForToolAsync(ViewerTool.DrawRectangle, "heading");
await viewer.DrawAsync(new PageRect(100, 150, 200, 40));

await Expect(viewer.Objects("heading")).ToHaveCountAsync(1);
```

## What the kit does

| Member | Use |
|---|---|
| `Page(n)`, `Object(id)`, `Objects(kind)`, `Drafts`, `Selected` | Locators for the displayed page and its objects. `Objects` leaves out drafts |
| `WaitForReadyAsync(page)` | Waits until the document is open and the page is rendered with its text ready |
| `WaitForToolAsync(tool, kind)` | Waits until a tool chosen from .NET has reached the browser |
| `PageRectAsync(id)` | An object's rectangle as a `PageRect`, parsed without depending on the test machine's culture |
| `DrawAsync(rect, page)` | Draws a rectangle with the real mouse |
| `DragObjectByAsync(id, x, y)` | Drags an object with the real mouse so that its rectangle moves by that much |
| `ClickObjectAsync(id)` | Clicks an object where it catches the pointer, including with the border hit area |
| `WaitForPointerTargetAsync(target, x, y)` | Waits until a point is over an element, for a gesture the kit has no method for |
| `RunAndWaitForChangeAsync(action)` | Runs an action and waits until the viewer has recorded an object change |
| `TextRectAsync(text, page)` | Where a run of the document's own text is, for drawing around it |
| `OutsideViewers()` | On any locator: leaves out matches inside a viewer |

Rectangles and distances are in the coordinates your objects use, page or display, so a test reads like the
application code it checks and works at any zoom, rotation or viewport.

The pointer methods scroll what they press into view, then wait until the point is really over their target, because a
tooltip or dialog can cover it for a moment. If an object never catches the pointer, they throw a `TimeoutException`
naming it: check the tool, read-only mode and anything drawn on top. `DrawAsync` first waits for the draw tool and for
read-only mode to be off.

## The document's text is in the page

The viewer puts the document's text in the DOM as its text layer, so that users can select it. `GetByText` and
`GetByRole` with a name can then match the PDF's words instead of your application's. Add `OutsideViewers()` when your
application shows text that a document might also contain:

```csharp
await Expect(page.GetByText("Invoice total").OutsideViewers()).ToBeVisibleAsync();
```

## Recipes

- **Selection.** `ClickObjectAsync(id)`, then assert on `viewer.Selected` or on what your application shows. Clicking
  an empty part of the page clears the selection.
- **Keyboard.** Focus the object, then press keys: `await viewer.Object(id).FocusAsync();` and
  `await page.Keyboard.PressAsync("ArrowRight");`. `data-page-rect` changes at once, and .NET hears of it shortly after.
- **Rotation.** Nothing changes: `DrawAsync` and `DragObjectByAsync` take the same values at every rotation. With page
  coordinates, a rectangle stays on the same content when the page turns.
- **Drawn objects your application confirms.** With an `OnObjectDrawn` handler, a finished draw adds a draft to
  `viewer.Drafts`, and no object appears until the handler keeps it.
- **Opening another document.** Until the new document starts loading, the old one still counts as open, so pass
  `WaitForReadyAsync` a page the old document isn't showing, or first wait on something only the new document has,
  such as its `data-page-count`.
- **Assertions on .NET state.** The DOM is right as soon as a gesture ends, and the change reaches .NET over the circuit
  slightly later. Use Playwright's retrying `Expect` on anything Razor renders from a viewer event.

## Component tests with bUnit

In a bUnit test there's no browser, so there's no viewer for your component to talk to. `Pv.Testing.Bunit` gives it a
fake one. The fake keeps the objects, drafts, selection, tool and read-only state in memory and follows the same rules
as the real viewer, so your component gets the same events, in the same order and with the same sequence numbers. You
can test how it reacts to the user without a browser or JavaScript mocks.

```csharp
var viewers = Services.AddFakePdfViewers();      // before rendering
var page = Render<RegionEditor>();
await viewers.Viewer.LoadDocumentAsync(pageCount: 3);

await viewers.Viewer.SimulateDrawAsync(new PageRect(100, 150, 200, 40));

Assert.Single(page.Instance.Regions);
```

- **Opening.** A document doesn't open by itself. After your component sets a source, call `LoadDocumentAsync`, or
  `FailDocumentAsync` to test how it handles a document that can't open.
- **The user.** `SimulateDrawAsync`, `SimulateClickAsync`, `SimulateEditAsync` (a move, resize or nudge) and
  `SimulateDeleteKeyAsync` act as the user does. Each completes once your component has handled what it caused,
  including an `OnObjectDrawn` handler that waits on a dialog. When the test has to close that dialog, start the draw
  without awaiting it.
- **What can't happen.** The `Simulate` methods throw when the user couldn't do what they ask, such as moving a locked
  object, drawing while the viewer is read-only, or resizing an object that isn't the one selected.
- **Commands.** As in the browser, a command that names an object the viewer doesn't have, or that the viewer refuses,
  fails with a `JSException`, and a command that needs a document waits for one that is opening.
- **State.** `Objects`, `Drafts`, `SelectedObjectIds`, `Tool`, `ReadOnly` and `CurrentPage` show what the viewer has,
  and `Commands` lists what your code sent through the controller, such as zoom changes.
- **Your own changes.** When your code changes the objects, the viewer may answer later, for example with a selection
  that ended because its object was removed. `SettleAsync` waits until your component has heard all of it.

The library runs the same scenarios against the fake and in a browser, to check that the fake behaves like the viewer it
stands in for.

## What can change

The test contract and this kit are part of the library's public API. The contract covers the attributes, classes,
element methods and events it lists. Until version 1.0 any of them can change in any release. Everything else in the
viewer's DOM, such as the canvas, pdf.js's own text-layer markup and the viewer's other class names, can change at any
time, so don't select on it.
