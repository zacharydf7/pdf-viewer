import { expect, test } from "@playwright/test";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { openViewer } from "./support.js";

const rect = { x: 100, y: 100, width: 200, height: 100 };

declare global {
  interface Window {
    // Optional: only this spec's pages set it, but the global declaration applies to every file in the project.
    windowKeyListeners?: { active: number };
  }
}

test.describe("window listener", () => {
  test.beforeEach(async ({ page }) => {
    // Counts capturing keydown listeners on the window, however they are later removed.
    await page.addInitScript(() => {
      const state = { active: 0 };
      window.windowKeyListeners = state;
      const isCapture = (options?: boolean | EventListenerOptions) =>
        typeof options === "boolean" ? options : options?.capture === true;
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      window.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
        if (type === "keydown" && isCapture(options)) {
          state.active++;
          options?.signal?.addEventListener("abort", () => state.active--);
        }
        add(type, listener, options);
      }) as typeof window.addEventListener;
      window.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
        if (type === "keydown" && isCapture(options)) {
          state.active--;
        }
        remove(type, listener, options);
      }) as typeof window.removeEventListener;
    });
  });

  test("window_ShouldHaveOneCapturingListenerOnlyWhileDragging_WhenPagesHaveChanged", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 }, "mixed-sizes");
    await viewer.host.evaluate(async (element: PdfViewerElement) => {
      await element.goToPage(2);
      await element.goToPage(1);
    });
    await viewer.waitForPage(1);
    await viewer.addObject({ id: "a", page: 1, rect });
    const active = () => page.evaluate(() => window.windowKeyListeners!.active);
    const before = await active();

    const from = await viewer.center(viewer.object("a"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 20);
    const during = await active();
    await page.mouse.up();

    expect([before, during, await active()]).toEqual([0, 1, 0]);
  });

  test("window_ShouldHaveNoCapturingListener_WhenDocumentClosesDuringDrag", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });

    const from = await viewer.center(viewer.object("a"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 20);
    const active = () => page.evaluate(() => window.windowKeyListeners!.active);
    const during = await active();
    await viewer.host.evaluate((element: PdfViewerElement) => element.close());
    const afterClose = await active();
    await page.mouse.up();

    expect([during, afterClose]).toEqual([1, 0]);
  });
});

test.describe("what catches the pointer", () => {
  for (const [tool, catches] of [["select", true], ["draw-rect", false], ["none", false]] as const) {
    test(`object_ShouldCatchPointerOnlyForSelect_WhenToolIs${tool}`, async ({ page }) => {
      const viewer = await openViewer(page, { initialZoom: 1 });
      await viewer.addObject({ id: "a", page: 1, rect });
      await viewer.setTool(tool);

      const center = await viewer.center(viewer.object("a"));
      const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.hasAttribute("data-object-id"),
        center);

      expect(hit).toBe(catches);
    });
  }

  test("object_ShouldNotBeTabStop_WhenToolIsNone", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });

    await viewer.setTool("none");

    await expect(viewer.object("a")).toHaveAttribute("tabindex", "-1");
  });
});

test.describe("other pointers during a gesture", () => {
  test("drag_ShouldIgnoreAnotherPointer_WhenItMovesAndLiftsOutsidePage", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });

    const from = await viewer.center(viewer.object("a"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 20);
    await page.locator(".pv-viewport").evaluate((viewport) => {
      for (const type of ["pointermove", "pointerup", "pointercancel"]) {
        viewport.dispatchEvent(new PointerEvent(type, { pointerId: 99, bubbles: true, clientX: 5, clientY: 5 }));
      }
    });
    await page.mouse.move(from.x + 40, from.y + 40);
    await page.mouse.up();

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "140,140,200,100");
  });
});

test.describe("page change during a gesture", () => {
  test("drawRect_ShouldAddNothing_WhenPageChangesBeforeRelease", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 }, "mixed-sizes");
    await viewer.setTool("draw-rect");
    const events = await viewer.recordEvents("pv-object-added");

    const from = await viewer.pagePoint(0.2, 0.2);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 80);
    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(2));
    await viewer.waitForPage(2);
    await page.mouse.move(from.x + 100, from.y + 100);
    await page.mouse.up();

    expect(await events()).toEqual([]);
    expect(await viewer.getObjects()).toEqual([]);
  });

  test("move_ShouldReportNothing_WhenPageChangesBeforeRelease", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 }, "mixed-sizes");
    await viewer.addObject({ id: "a", page: 1, rect });
    const events = await viewer.recordEvents("pv-object-updated");

    const from = await viewer.center(viewer.object("a"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 40);
    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(2));
    await viewer.waitForPage(2);
    await page.mouse.move(from.x + 60, from.y + 60);
    await page.mouse.up();

    expect(await events()).toEqual([]);
    expect((await viewer.getObject("a"))!.rect).toEqual(rect);
  });
});
