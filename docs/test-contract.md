# Test contract

The viewer's DOM is part of its public API. These attributes aren't stripped from production builds, so what you test is
what ships. Wait on them instead of using timers, and use them from any test framework.

Everything sits inside `<pdf-viewer>`, in the light DOM, so ordinary selectors reach it.

## Viewer: `pdf-viewer`

| Attribute | Values |
|---|---|
| `data-document-state` | `idle`, `loading`, `ready`, `error` |
| `data-error-code` | Present only in the `error` state: `invalid-pdf`, `network`, `password-required`, `password-incorrect`, `unknown` |
| `data-page-count` | Number of pages, once the document is open |
| `data-current-page` | The displayed page, starting at 1 |
| `data-zoom` | The zoom being displayed or rendered, with 1 meaning 100%. Absent until a page has been sized. The element's `zoom` property gives the same number |
| `data-tool` | `select`, `draw-rect`, `none` |
| `data-object-hit-area` | `fill`, or `border` when only an unselected object's edges catch the pointer |
| `data-selected-object` | ID of the selected object, or empty. With several selected, the one selected last |
| `data-last-change` | Sequence number of the latest object change |

## Page: `.pv-page`

| Attribute | Values |
|---|---|
| `data-page-number` | The page number, starting at 1 |
| `data-page-state` | `pending` (no size to fit yet, usually because the viewer is hidden), `rendering`, `rendered`, `error` |
| `data-text-state` | `pending`, `ready`, `error` |
| `data-render-scale` | The zoom of the last finished render |
| `data-rotation` | Total clockwise rotation, including the page's own |
| `data-page-width`, `data-page-height` | Size in the coordinates objects use: unrotated in `page` coordinates, as displayed in `display` coordinates |
| `data-object-count` | Number of objects on this page |

Text can take seconds to extract on some documents and doesn't hold up painting, so `data-page-state` can be `rendered`
while `data-text-state` is still `pending`. Zooming or rotating a finished page leaves `data-text-state` at `ready`.

A page counts as ready when `data-page-state` is `rendered` and `data-text-state` is `ready`. During a zoom the old canvas
stays visible, stretched, until the new one is ready. Only then does `data-render-scale` change, so check it if your test
depends on sharp pixels.

## Object: `[data-object-id]`

| Attribute | Values |
|---|---|
| `data-object-id` | The ID your application gave it, or a generated version 4 UUID for objects the user draws |
| `data-object-kind` | The application's own category, if it gave one |
| `data-object-shape` | `rect` |
| `data-app-*` | One attribute per entry in the object's app data, such as `data-app-section="3"` |
| `hidden` | Present when the object is hidden, which leaves it neither visible nor reachable by pointer or keyboard |
| `class` | `pv-object`, followed by the object's own CSS classes |
| `data-page-rect` | `x,y,width,height` in the coordinates objects use |
| `data-locked`, `data-selectable` | `true` or `false` |
| `aria-selected` | `true` or `false` |

Objects also have `role="option"` and an accessible name, so `getByRole("option", { name: "..." })` works. An object
without a label is named "Object 3 on page 2" or similar, with a number no other object on its page has. Which object
gets which number depends on the order objects were shown, so use `data-object-id` for identity, as names can also be
localized or repeated.

Objects appear only for the displayed page. An object whose `page` is `null` appears on whichever page is displayed, at
the same coordinates, and is clipped where that page is smaller than its rectangle. To read any object in the document,
call `getObject(id)` or `getObjects()` on the element. `data-object-count` gives the number on the displayed page. The
objects these return are frozen, so change one with `updateObject`.

To set up a test's objects in one step, call `setObjects(list)`, which makes the list the only objects, or
`applyObjects({ upsert, remove })`, which adds or replaces some and removes others. Either one raises at most one
`pv-objects-changed` event, listing only what actually differed, and none when nothing did.

The selected object's handles are `[data-handle="nw|n|ne|e|se|s|sw|w"]`, with `data-handle-for` set to its ID. Handles are
real elements, so a test can drag them with the real mouse. They appear only when exactly one object is selected.

`selectObjects(ids)` selects several objects, each with `aria-selected="true"`. `selectedObjectIds` on the element lists
them in the order selected.

## Draft: `[data-draft-id]`

A drawn object becomes a draft when a `pv-object-drawn` listener cancels the event, and stays one until something
decides whether to keep it. The Blazor component cancels the event whenever `OnObjectDrawn` has a handler. Otherwise a
drawn object is added at once and never shows as a draft.

| Attribute | Values |
|---|---|
| `data-draft-id` | The ID the object will have if it's kept, a generated version 4 UUID |
| `data-page-rect` | `x,y,width,height` in the coordinates objects use |
| `class` | `pv-draft` |

A draft is visible, but it isn't an object. It has no `data-object-id`, isn't counted in `data-object-count`, isn't
returned by `getObjects()`, and can't be selected, moved or resized. Like an object, it appears only while its page is
displayed.

`commitDraft(id)` on the element adds the draft as an object and reports it as a change the user made.
`discardDraft(id)` drops it. Each returns whether there was such a draft. Adding an object with a draft's ID, through
`addObject`, `upsertObject`, `setObjects` or `applyObjects`, also commits the draft, with the values given instead of
those drawn. Closing the document discards its drafts.

The rectangle that follows the pointer during a draw is `.pv-draft[data-draft="true"]`. It has no ID, and it's gone
when the pointer is released.

## Page space

By default, every public rectangle uses page space: PDF user-space units, measured from the top-left corner of the unrotated
crop box, with y growing downward. A rectangle stays attached to the page's content at any zoom or rotation. To turn it into
PDF user space, where y grows upward, use `pdfX = cropLeft + x` and `pdfY = cropTop - y`.

With the `display` coordinates option, rectangles are measured from the top-left corner of the page as presented after
rotation, and are scaled by its UserUnit. A rectangle keeps its numbers when the page rotates, so it moves relative to the content.

Two methods on the element give geometry without reading attributes. `getPageInfo(page)` resolves to
`{ page, label, width, height, rotation }` for any page, displayed or not. The size is in the coordinates objects use,
and `label` is the page's label, or `null` if the document defines none. `pageToClient(page, { x, y })` returns where a
point on the displayed page is in the browser viewport, as `clientX` and `clientY` would report it, or `undefined` for a
page that isn't displayed. Use it to aim the real mouse at page coordinates.

## Events

These are bubbling `CustomEvent`s on `<pdf-viewer>`.

| Event | Detail |
|---|---|
| `pv-document-loaded` | `{ pageCount, pageLabels }`, where `pageLabels` has each page's label in page order, or is `null` if the document defines none |
| `pv-page-rendered` | `{ page, scale }` |
| `pv-page-change` | `{ page }` |
| `pv-object-drawn` | `{ object }`, the object the user finished drawing, with the draw tool's defaults applied. It's raised before the object is added, and it's the only event that can be canceled. Unless a listener calls `preventDefault()`, the object is added at once and `pv-objects-changed` follows. A listener that cancels it keeps the object as a draft, and commits or discards it later |
| `pv-objects-changed` | `{ sequence, origin, added, updated, removed }`, where `origin` is `user` or `api`. One event reports one change, however many objects it touched. `added` and `removed` list objects, the removed ones as they were. `updated` lists `{ object, previous, gesture }`, where `previous` is the object before the change. `gesture` is set when the user changed the rectangle: `move` for dragging the object, `resize` for dragging a handle or pressing Shift with an arrow key, `nudge` for an arrow key without Shift |
| `pv-selection-change` | `{ sequence, origin, ids, primaryId }`. `ids` has every selected object in the order selected, and `primaryId` is the last of them, or `null` |
| `pv-error` | `{ code, message, documentFailed }`, where `code` is one of the `data-error-code` values when `documentFailed` is true. Otherwise it's `page` or `render` for a page that failed, or `command` for a rejected command from .NET. For a URL source, `network` also covers any other error from pdf.js, because it reports a refused connection as a generic error |

Object changes fire when a gesture finishes, never during a drag. `sequence` counts every change to objects and selection,
so it tells which of two events is newer.

## Writing tests

- **Don't retry.** This project's own suites run without test-level retries, and yours can too if they wait on the
  attributes above.
- **Wait for the tool.** On Blazor Server, a button that switches tools goes through the circuit, so a drag that starts at
  once can begin with the old tool. Wait for `data-tool` to show the new value first.
- **Use the real mouse.** Don't use Playwright's `force: true`. A click that can't reach an object is a real defect.
- **Press an edge when objects use the border hit area.** The center of an unselected object doesn't catch the pointer, so
  Playwright's `click()` on its locator reports it as covered. Press near its edge, or select it first.
- **Read positions from the page.** Don't hard-code pixel coordinates, because they break at the first change of page size,
  zoom or viewport. See `tests/Pv.EndToEnd/ViewerPage.cs` for an example.
- **Assert page units for geometry.** `data-page-rect` is exact at any zoom. On-screen measurements need a tolerance of
  about 1 CSS pixel.
- **Wait for the draft when a handler decides on drawn objects.** With `OnObjectDrawn` handled, a finished draw leaves
  `[data-draft-id]` and no object. The object appears, under the same ID, only once the handler keeps it.
- **After a drag, the DOM is right immediately, but .NET hears about it slightly later.** Use retrying assertions on anything
  Razor renders from a change event.
- **`bUnit` can't see objects.** They belong to JavaScript, so test your handlers in bUnit and the objects in a browser.
