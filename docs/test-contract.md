# Test contract

The viewer's DOM is part of its public API. These attributes are always present, including in production, so what you
test is what ships. Wait on them instead of using timers, and use them from any test framework.

Everything sits inside `<pdf-viewer>`, in the light DOM, so ordinary selectors reach it.

## Viewer: `pdf-viewer`

| Attribute | Values |
|---|---|
| `data-document-state` | `idle`, `loading`, `ready`, `error` |
| `data-error-code` | Set in the `error` state: `invalid-pdf`, `network`, `password-required`, `password-incorrect`, `unknown` |
| `data-page-count` | Number of pages, once the document is open |
| `data-current-page` | The displayed page, starting at 1 |
| `data-zoom` | The zoom being displayed or rendered, with 1 meaning 100% |
| `data-tool` | `select`, `draw-rect`, `none` |
| `data-object-hit-area` | `fill`, or `border` when only an unselected object's edges catch the pointer |
| `data-selected-object` | ID of the selected object, or empty |
| `data-last-change` | Sequence number of the latest object change |

## Page: `.pv-page`

| Attribute | Values |
|---|---|
| `data-page-number` | The page number, starting at 1 |
| `data-page-state` | `pending` (hidden, so there's no size to fit yet), `rendering`, `rendered`, `error` |
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
| `data-object-id` | The ID your application gave it, or a generated one for objects the user draws |
| `data-object-kind` | `rect` |
| `data-object-tag` | The application's own category, if it gave one |
| `data-page-rect` | `x,y,width,height` in page units |
| `data-locked`, `data-selectable` | `true` or `false` |
| `aria-selected` | `true` or `false` |

Objects also have `role="option"` and an accessible name, so `getByRole("option", { name: "..." })` works. Prefer
`data-object-id` for identity, because names can be localized or repeated.

Objects appear only for the displayed page. To read any object in the document, call `getObject(id)` or `getObjects()` on
the element, and check `data-object-count` on the page.

The selected object's handles are `[data-handle="nw|n|ne|e|se|s|sw|w"]`, with `data-handle-for` set to its ID. Handles are
real elements, so a test can drag them with the real mouse.

## Page space

By default, every public rectangle uses page space: PDF user-space units, measured from the top-left corner of the unrotated
crop box, with y growing downward. A rectangle stays attached to the page's content at any zoom or rotation. To turn it into
PDF user space, where y grows upward, use `pdfX = cropLeft + x` and `pdfY = cropTop - y`.

With the `display` coordinates option, rectangles are measured from the top-left corner of the page as presented after
rotation, and include its UserUnit. A rectangle keeps its numbers when the page rotates, so it moves relative to the content.

## Events

These are bubbling `CustomEvent`s on `<pdf-viewer>`.

| Event | Detail |
|---|---|
| `pv-document-loaded` | `{ pageCount }` |
| `pv-page-rendered` | `{ page, scale }` |
| `pv-page-change` | `{ page }` |
| `pv-object-change` | `{ sequence, origin, kind, object }`, where `origin` is `user` or `api` |
| `pv-selection-change` | `{ sequence, origin, id }` |
| `pv-error` | `{ code, message }` |

Object changes fire when a gesture finishes, never during a drag.

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
- **After a drag, the DOM is right immediately, but .NET hears about it slightly later.** Use retrying assertions on anything
  Razor renders from a change event.
- **`bUnit` can't see objects.** They belong to JavaScript, so test your handlers in bUnit and the objects in a browser.
