import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { expectRectsClose, manifest, openViewer, Viewer } from "./support.js";

const outer = { x: 100, y: 100, width: 300, height: 300 };
const inner = { x: 200, y: 200, width: 100, height: 100 };

test.describe("border hit area", () => {
  test("press_ShouldReachInnerObjectThroughOuterObject_WhenPressedOnInnerBorder", async ({ page }) => {
    const viewer = await openViewer(page, { objectHitArea: "border", initialZoom: 1 });
    await viewer.addObject({ id: "inner", page: 1, rect: inner });
    await viewer.addObject({ id: "outer", page: 1, rect: outer });

    const box = (await viewer.object("inner").boundingBox())!;
    await page.mouse.click(box.x + 1, box.y + box.height / 2);

    await expect(viewer.host).toHaveAttribute("data-selected-object", "inner");
  });

  test("press_ShouldClearSelection_WhenPressedInsideUnselectedObject", async ({ page }) => {
    const viewer = await openViewer(page, { objectHitArea: "border", initialZoom: 1 });
    await viewer.addObject({ id: "outer", page: 1, rect: outer });
    await viewer.addObject({ id: "other", page: 1, rect: { x: 450, y: 450, width: 100, height: 100 } });
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("other"));

    const center = await viewer.center(viewer.object("outer"));
    await page.mouse.click(center.x, center.y);

    await expect(viewer.host).toHaveAttribute("data-selected-object", "");
  });

  test("press_ShouldSelectOuterObject_WhenPressedOnItsBorder", async ({ page }) => {
    const viewer = await openViewer(page, { objectHitArea: "border", initialZoom: 1 });
    await viewer.addObject({ id: "outer", page: 1, rect: outer });

    const box = (await viewer.object("outer").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y);

    await expect(viewer.host).toHaveAttribute("data-selected-object", "outer");
  });

  test("selectedObject_ShouldDragFromInterior_WhenBorderHitAreaIsOn", async ({ page }) => {
    const viewer = await openViewer(page, { objectHitArea: "border", initialZoom: 1 });
    await viewer.addObject({ id: "outer", page: 1, rect: outer });
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("outer"));

    const from = await viewer.center(viewer.object("outer"));
    await viewer.drag(from, { x: from.x + 20, y: from.y + 10 });

    await expect(viewer.object("outer")).toHaveAttribute("data-page-rect", "120,110,300,300");
  });

  test("smallObject_ShouldCatchPointerAnywhere_WhenBorderHitAreaIsOn", async ({ page }) => {
    const viewer = await openViewer(page, { objectHitArea: "border", initialZoom: 1 });
    await viewer.addObject({ id: "small", page: 1, rect: { x: 300, y: 300, width: 20, height: 20 } });

    const center = await viewer.center(viewer.object("small"));
    await page.mouse.click(center.x, center.y);

    await expect(viewer.host).toHaveAttribute("data-selected-object", "small");
  });

  test("unselectableObject_ShouldIgnorePointerOnBorder_WhenBorderHitAreaIsOn", async ({ page }) => {
    const viewer = await openViewer(page, { objectHitArea: "border", initialZoom: 1 });
    await viewer.addObject({ id: "hidden", page: 1, rect: outer, selectable: false });

    const box = (await viewer.object("hidden").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y);

    await expect(viewer.object("hidden")).toHaveAttribute("aria-selected", "false");
  });

  test("drawTool_ShouldDrawOverExistingBorder_WhenBorderHitAreaIsOn", async ({ page }) => {
    const viewer = await openViewer(page, { objectHitArea: "border", initialZoom: 1 });
    await viewer.addObject({ id: "outer", page: 1, rect: outer });
    await viewer.setTool("draw-rect");

    const box = (await viewer.object("outer").boundingBox())!;
    await viewer.drag({ x: box.x, y: box.y }, { x: box.x + 60, y: box.y + 60 });

    await expect(page.locator("[data-object-id]")).toHaveCount(2);
    await expect(viewer.object("outer")).toHaveAttribute("data-page-rect", "100,100,300,300");
  });
});

test.describe("focus after a press", () => {
  test("arrowKey_ShouldMoveObject_WhenObjectWasClicked", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect: outer });

    const center = await viewer.center(viewer.object("a"));
    await page.mouse.click(center.x, center.y);
    await page.keyboard.press("ArrowRight");

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "101,100,300,300");
  });

  test("arrowKey_ShouldMoveObject_WhenHandleWasDragged", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect: outer });
    await viewer.object("a").click();

    const from = await viewer.center(viewer.handle("se"));
    await viewer.drag(from, { x: from.x + 10, y: from.y });
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,310,300");
    await page.keyboard.press("ArrowRight");

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "101,100,310,300");
  });

  test("press_ShouldNotScrollPage_WhenFocusingPartlyVisibleObject", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 3 });
    await viewer.addObject({ id: "a", page: 1, rect: { x: 0, y: 0, width: 600, height: 790 } });
    const viewport = page.locator(".pv-viewport");
    await viewport.evaluate((element) => { element.scrollTop = 500; });
    const before = await viewport.evaluate((element) => element.scrollTop);

    const box = (await viewport.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(viewer.host).toHaveAttribute("data-selected-object", "a");
    expect(await viewport.evaluate((element) => element.scrollTop)).toBe(before);
  });
});

test.describe("Escape during a gesture", () => {
  test("escape_ShouldRestoreObject_WhenPressedDuringMove", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect: outer });
    const events = await viewer.recordEvents("pv-object-change");
    const before = await viewer.boundsOnPage(viewer.object("a"));

    const from = await viewer.center(viewer.object("a"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 50, from.y + 50);
    await page.keyboard.press("Escape");
    await page.mouse.up();

    expectRectsClose(await viewer.boundsOnPage(viewer.object("a")), before, 0.01);
    expect(await events()).toEqual([]);
  });

  test("escape_ShouldDiscardDraft_WhenPressedDuringDraw", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.setTool("draw-rect");

    const from = await viewer.pagePoint(0.2, 0.2);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 80);
    await expect(page.locator("[data-draft]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.mouse.up();

    await expect(page.locator("[data-draft]")).toHaveCount(0);
    await expect(page.locator("[data-object-id]")).toHaveCount(0);
  });
});

test.describe("display coordinates", () => {
  test("object_ShouldUseScreenPosition_WhenPageHasItsOwnRotation", async ({ page }) => {
    const viewer = await openViewer(page, { coordinates: "display", initialZoom: 1 }, "rotate-90");
    await viewer.addObject({ id: "a", page: 1, rect: { x: 10, y: 20, width: 30, height: 40 } });

    await expect(viewer.pageElement()).toHaveAttribute("data-page-width", "792");
    await expect(viewer.pageElement()).toHaveAttribute("data-page-height", "612");
    expectRectsClose(await viewer.boundsOnPage(viewer.object("a")), { x: 10, y: 20, width: 30, height: 40 }, 0.5);
  });

  test("object_ShouldKeepItsNumbers_WhenPageRotates", async ({ page }) => {
    const viewer = await openViewer(page, { coordinates: "display", initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect: { x: 10, y: 20, width: 30, height: 40 } });

    await viewer.host.evaluate((element: PdfViewerElement) => element.setPageRotation(1, 90));
    await viewer.waitForPage();

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "10,20,30,40");
    expectRectsClose(await viewer.boundsOnPage(viewer.object("a")), { x: 10, y: 20, width: 30, height: 40 }, 0.5);
  });

  test("object_ShouldIncludeUserUnit_WhenPageHasOne", async ({ page }) => {
    const viewer = await openViewer(page, { coordinates: "display", initialZoom: 1 }, "user-unit");

    await expect(viewer.pageElement()).toHaveAttribute("data-page-width", "800");
    await viewer.addObject({ id: "a", page: 1, rect: { x: 100, y: 100, width: 50, height: 50 } });

    expectRectsClose(await viewer.boundsOnPage(viewer.object("a")), { x: 100, y: 100, width: 50, height: 50 }, 0.5);
  });

  test("drawRect_ShouldReportScreenPosition_WhenPageIsRotated", async ({ page }) => {
    const options = { coordinates: "display", initialZoom: 1, roundCoordinates: true } as const;
    const viewer = await openViewer(page, options, "rotate-90");
    await viewer.setTool("draw-rect");
    const box = (await viewer.pageElement().boundingBox())!;

    await viewer.drag({ x: box.x + 100, y: box.y + 50 }, { x: box.x + 300, y: box.y + 150 });

    const [object] = await viewer.getObjects();
    expectRectsClose(object!.rect, { x: 100, y: 50, width: 200, height: 100 }, 1);
  });

  test("drag_ShouldFollowPointer_WhenPageIsRotated", async ({ page }) => {
    const viewer = await openViewer(page, { coordinates: "display", initialZoom: 1 }, "rotate-180");
    await viewer.addObject({ id: "a", page: 1, rect: { x: 100, y: 100, width: 100, height: 100 } });

    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 30, y: from.y + 20 });

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "130,120,100,100");
  });
});

test.describe("text layer", () => {
  const firstSpanOffset = (viewer: Viewer) => viewer.pageElement().evaluate((page) => {
    const span = page.querySelector(".textLayer span")!.getBoundingClientRect();
    const bounds = page.getBoundingClientRect();
    return { x: span.left - bounds.left, y: span.top - bounds.top };
  });

  test("zoom_ShouldKeepTextLayerAndItsReadyState_WhenLayerIsFinished", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await page.locator(".textLayer").evaluate((element) => { element.setAttribute("data-marker", "same"); });
    const states: (string | undefined)[] = [];
    await page.exposeFunction("recordTextState", (state: string) => { states.push(state); });
    await viewer.pageElement().evaluate((element) => {
      new MutationObserver(() => {
        void (window as unknown as { recordTextState(state?: string): void }).recordTextState(element.dataset.textState);
      }).observe(element, { attributes: true, attributeFilter: ["data-text-state"] });
    });

    await viewer.setZoom(2);

    await expect(page.locator(".textLayer")).toHaveAttribute("data-marker", "same");
    expect(states).toEqual([]);
  });

  test("textLayer_ShouldStayOverInk_WhenZoomed", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    await viewer.setZoom(2);

    const ink = await viewer.inkBounds();
    const span = await firstSpanOffset(viewer);
    expect(Math.abs(span.x - ink.x)).toBeLessThanOrEqual(3);
    expect(span.y).toBeGreaterThan(ink.y + ink.height);
  });

  test("textLayer_ShouldFollowRotation_WhenPageIsRotatedAfterItFinished", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    await viewer.setRotation(90);

    // Rotated clockwise, text that started at the ink's left edge now starts at its top edge, to the left of the ink.
    const ink = await viewer.inkBounds();
    const span = await firstSpanOffset(viewer);
    expect(Math.abs(span.y - ink.y)).toBeLessThanOrEqual(3);
    expect(span.x).toBeLessThan(ink.x);
  });

  test("textLayer_ShouldBeSelectable_WhenZoomedAfterItFinished", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.setZoom(1.5);

    const box = (await page.locator(".textLayer span").first().boundingBox())!;
    const middle = box.y + box.height / 2;
    await viewer.drag({ x: box.x + 2, y: middle }, { x: box.x + box.width - 2, y: middle });

    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("sample");
  });

  test("pageChange_ShouldBeReportedBeforeRenderFinishes_WhenNavigating", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    const order = await page.evaluate(async () => {
      const host = document.querySelector("pdf-viewer") as PdfViewerElement;
      const events: string[] = [];
      host.addEventListener("pv-page-change", () => events.push("change"));
      host.addEventListener("pv-page-rendered", () => events.push("rendered"));
      await host.goToPage(2);
      return events;
    });

    expect(order).toEqual(["change", "rendered"]);
    await viewer.waitForPage(2);
  });
});

test.describe("many objects", () => {
  const count = 300;

  async function addMany(viewer: Viewer): Promise<void> {
    await viewer.host.evaluate((element: PdfViewerElement, total) => {
      element.setObjects(Array.from({ length: total }, (_, index) => ({
        id: `object-${index}`,
        page: 1,
        rect: { x: index % 500, y: index % 700, width: 40, height: 40 },
      })));
    }, count);
  }

  async function countChangedObjects(page: Page, action: () => Promise<unknown>): Promise<number> {
    await page.evaluate(() => {
      const state = window as unknown as { changed: Set<Node>; observer: MutationObserver };
      state.changed = new Set();
      state.observer = new MutationObserver((records) => records.forEach((record) => state.changed.add(record.target)));
      state.observer.observe(document.querySelector(".pv-objects")!, { attributes: true, subtree: true });
    });
    await action();
    return page.evaluate(() => {
      const state = window as unknown as { changed: Set<Node>; observer: MutationObserver };
      state.observer.takeRecords().forEach((record) => state.changed.add(record.target));
      return state.changed.size;
    });
  }

  test("selection_ShouldTouchOnlyAffectedObjects_WhenSelectionChanges", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await addMany(viewer);
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("object-1"));

    const changed = await countChangedObjects(page, () =>
      viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("object-2")));

    expect(changed).toBeLessThanOrEqual(2);
  });

  test("update_ShouldTouchOnlyThatObject_WhenOneObjectChanges", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await addMany(viewer);

    const changed = await countChangedObjects(page, () => viewer.host.evaluate((element: PdfViewerElement) => {
      element.updateObject("object-5", { rect: { x: 1, y: 2, width: 3, height: 4 } });
    }));

    expect(changed).toBe(1);
  });

  test("setObjects_ShouldTouchNothing_WhenObjectsAreUnchanged", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await addMany(viewer);

    const changed = await countChangedObjects(page, () => addMany(viewer));

    expect(changed).toBe(0);
  });

  test("objects_ShouldStayOnInk_WhenManyAreOnPage", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1.37 });
    await addMany(viewer);
    await viewer.addObject({ id: "ink", page: 1, rect: manifest.letter![0]! });

    expectRectsClose(await viewer.boundsOnPage(viewer.object("ink")), await viewer.inkBounds(), 1);
  });
});
