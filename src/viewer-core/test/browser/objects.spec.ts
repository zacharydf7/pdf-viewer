import { expect, test } from "@playwright/test";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { expectRectsClose, parseRect, Viewer } from "./support.js";

const start = { x: 100, y: 100, width: 200, height: 100 };

async function openViewer(page: import("@playwright/test").Page, fixture = "letter", zoom = 1): Promise<Viewer> {
  const viewer = new Viewer(page);
  viewer.failOnFakeWorker();
  await viewer.goto();
  await viewer.open(fixture);
  await viewer.setZoom(zoom);
  return viewer;
}

test.describe("drawing", () => {
  for (const rotation of [0, 90, 180, 270]) {
    test(`drawRect_ShouldCreateObjectWhereDragged_WhenRotatedBy${rotation}`, async ({ page }) => {
      const viewer = await openViewer(page);
      await viewer.setRotation(rotation);
      await viewer.setTool("draw-rect");
      const from = await viewer.pagePoint(0.2, 0.2);
      const to = await viewer.pagePoint(0.6, 0.5);

      await viewer.drag(from, to);

      const object = page.locator("[data-object-id]");
      await expect(object).toHaveCount(1);
      const pageBox = (await viewer.pageElement().boundingBox())!;
      expectRectsClose(await viewer.boundsOnPage(object), {
        x: from.x - pageBox.x, y: from.y - pageBox.y, width: to.x - from.x, height: to.y - from.y,
      }, 1);
    });
  }

  test("drawRect_ShouldWork_WhenBrowserDeliversOnlyOneIntermediateMove", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.setTool("draw-rect");
    const events = await viewer.recordEvents("pv-object-added");

    await viewer.drag(await viewer.pagePoint(0.1, 0.1), await viewer.pagePoint(0.3, 0.3), 1);

    await expect(page.locator("[data-object-id]")).toHaveCount(1);
    expect((await events()).map(({ origin }) => origin)).toEqual(["user"]);
  });

  test("drawRect_ShouldIgnoreClick_WhenPointerDoesNotMoveFarEnough", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.setTool("draw-rect");
    const point = await viewer.pagePoint(0.5, 0.5);

    await viewer.drag(point, point);

    await expect(page.locator("[data-object-id]")).toHaveCount(0);
    await expect(page.locator("[data-draft]")).toHaveCount(0);
  });

  test("drawRect_ShouldGiveObjectUniqueUuid_WhenFinished", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.setTool("draw-rect");

    await viewer.drag(await viewer.pagePoint(0.1, 0.1), await viewer.pagePoint(0.2, 0.2));
    await viewer.drag(await viewer.pagePoint(0.3, 0.3), await viewer.pagePoint(0.4, 0.4));

    const ids = (await viewer.getObjects()).map(({ id }) => id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  test("drawRect_ShouldSelectNewObject_WhenFinished", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.setTool("draw-rect");

    await viewer.drag(await viewer.pagePoint(0.1, 0.1), await viewer.pagePoint(0.3, 0.3));

    await expect(page.getByRole("option", { selected: true })).toHaveCount(1);
  });
});

test.describe("selecting", () => {
  test("object_ShouldBecomeSelected_WhenClicked", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, label: "First region" });

    await page.getByRole("option", { name: "First region" }).click();

    await expect(viewer.object("a")).toHaveAttribute("aria-selected", "true");
    await expect(viewer.host).toHaveAttribute("data-selected-object", "a");
  });

  test("selection_ShouldClear_WhenClickingEmptyPageArea", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await viewer.object("a").click();

    const empty = await viewer.pagePoint(0.9, 0.9);
    await page.mouse.click(empty.x, empty.y);

    await expect(viewer.object("a")).toHaveAttribute("aria-selected", "false");
  });

  test("object_ShouldIgnoreClicks_WhenNotSelectable", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, selectable: false });

    const center = await viewer.center(viewer.object("a"));
    await page.mouse.click(center.x, center.y);

    await expect(viewer.object("a")).toHaveAttribute("aria-selected", "false");
  });
});

test.describe("moving and resizing", () => {
  test("object_ShouldMoveByDraggedDistance_WhenDraggedAtZoom", async ({ page }) => {
    const viewer = await openViewer(page, "letter", 2);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    const events = await viewer.recordEvents("pv-object-updated");

    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 100, y: from.y + 60 });

    // Zoom is 2, so 100 by 60 CSS pixels is 50 by 30 page units.
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "150,130,200,100");
    expect(await events()).toMatchObject([{ origin: "user", gesture: "move", previous: { rect: start } }]);
  });

  test("object_ShouldNotReportChange_WhenClickedWithoutMoving", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    const events = await viewer.recordEvents("pv-object-updated");

    await viewer.object("a").click();

    await expect(viewer.object("a")).toHaveAttribute("aria-selected", "true");
    expect(await events()).toEqual([]);
  });

  test("object_ShouldStayOnPage_WhenDraggedPastEdge", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    // The page is narrower than the window, so the pointer crosses the page's edge without leaving the window.
    const from = await viewer.center(viewer.object("a"));
    const box = (await viewer.pageElement().boundingBox())!;
    await viewer.drag(from, { x: box.x - 50, y: from.y });
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "0,100,200,100");

    const again = await viewer.center(viewer.object("a"));
    await viewer.drag(again, { x: box.x + box.width + 50, y: again.y });
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "412,100,200,100");
  });

  test("object_ShouldNotMove_WhenLocked", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, locked: true });

    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 50, y: from.y + 50 });

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,200,100");
    await expect(viewer.object("a")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("[data-handle]")).toHaveCount(0);
  });

  test("handle_ShouldResizeFromThatCorner_WhenDragged", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await viewer.object("a").click();
    const events = await viewer.recordEvents("pv-object-updated");

    const from = await viewer.center(viewer.handle("se"));
    await viewer.drag(from, { x: from.x + 40, y: from.y + 20 });

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,240,120");
    expect((await events()).map(({ gesture }) => gesture)).toEqual(["resize"]);
  });

  test("handle_ShouldNotJump_WhenGrabbedOffCenter", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await viewer.object("a").click();

    const center = await viewer.center(viewer.handle("se"));
    const from = { x: center.x + 8, y: center.y + 8 };
    await viewer.drag(from, { x: from.x + 40, y: from.y + 20 });

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,240,120");
  });

  for (const rotation of [90, 180, 270]) {
    test(`object_ShouldNotReportChange_WhenClickedWithoutMovingAtRotation${rotation}`, async ({ page }) => {
      const viewer = await openViewer(page);
      await viewer.setRotation(rotation);
      await viewer.addObject({ id: "a", page: 1, rect: { x: 100.1, y: 200.7, width: 33.3, height: 77.7 } });
      const events = await viewer.recordEvents("pv-object-updated");

      await viewer.object("a").click();

      await expect(viewer.object("a")).toHaveAttribute("aria-selected", "true");
      expect(await events()).toEqual([]);
    });

    test(`handle_ShouldFollowPointerOnScreen_WhenRotatedBy${rotation}`, async ({ page }) => {
      const viewer = await openViewer(page);
      await viewer.setRotation(rotation);
      await viewer.addObject({ id: "a", page: 1, rect: start });
      await viewer.object("a").click();
      const before = await viewer.boundsOnPage(viewer.object("a"));

      const from = await viewer.center(viewer.handle("se"));
      await viewer.drag(from, { x: from.x + 40, y: from.y + 20 });

      const expected = { ...before, width: before.width + 40, height: before.height + 20 };
      expectRectsClose(await viewer.boundsOnPage(viewer.object("a")), expected, 1);
    });
  }

  test("objects_ShouldNotBlockTextSelection_WhenPointerIsOutsideThem", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: { x: 400, y: 600, width: 100, height: 100 } });
    const text = viewer.pageElement().locator(".textLayer span").first();
    const box = (await text.boundingBox())!;

    const middle = box.y + box.height / 2;
    await viewer.drag({ x: box.x + 2, y: middle }, { x: box.x + box.width - 2, y: middle });

    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("sample");
  });
});

test.describe("keyboard", () => {
  test("arrowKey_ShouldMoveFocusedObject_WhenPressed", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    const events = await viewer.recordEvents("pv-object-updated");

    await viewer.object("a").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+ArrowDown");

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "101,110,200,100");
    expect((await events()).map(({ gesture }) => gesture)).toEqual(["nudge", "nudge"]);
  });

  test("shiftArrowKey_ShouldResizeFocusedObject_WhenPressed", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    const events = await viewer.recordEvents("pv-object-updated");

    await viewer.object("a").focus();
    await page.keyboard.press("Shift+ArrowRight");

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,201,100");
    expect((await events()).map(({ gesture }) => gesture)).toEqual(["resize"]);
  });

  test("arrowKey_ShouldMoveObjectAsDisplayed_WhenPageIsRotated", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.setRotation(90);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    const before = (await viewer.object("a").boundingBox())!;

    await viewer.object("a").focus();
    await page.keyboard.press("Control+ArrowRight");

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,90,200,100");
    const after = (await viewer.object("a").boundingBox())!;
    expect(after.x - before.x).toBeCloseTo(10, 0);
    expect(after.y - before.y).toBeCloseTo(0, 0);
  });

  test("escapeKey_ShouldClearSelection_WhenObjectIsFocused", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    await viewer.object("a").focus();
    await expect(viewer.host).toHaveAttribute("data-selected-object", "a");
    await page.keyboard.press("Escape");

    await expect(viewer.host).toHaveAttribute("data-selected-object", "");
  });

  test("deleteKey_ShouldRemoveFocusedObject_WhenNotLocked", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    await viewer.object("a").focus();
    await page.keyboard.press("Delete");

    await expect(viewer.object("a")).toHaveCount(0);
  });

  test("deleteKey_ShouldDoNothing_WhenLocked", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, locked: true });

    await viewer.object("a").focus();
    await page.keyboard.press("Delete");

    await expect(viewer.object("a")).toHaveCount(1);
  });

  test("otherKeys_ShouldReachHost_WhenObjectIsFocused", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await page.evaluate(() => {
      document.addEventListener("keydown", (event) => {
        (window as unknown as { lastKey: string }).lastKey = event.key;
      });
    });

    await viewer.object("a").focus();
    await page.keyboard.press("q");

    expect(await page.evaluate(() => (window as unknown as { lastKey: string }).lastKey)).toBe("q");
  });
});

test.describe("removing and replacing", () => {
  test("removeObject_ShouldReportObjectAsItWas_WhenRemovedByCode", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, kind: "note" });
    const events = await viewer.recordEvents("pv-object-removed");

    await viewer.host.evaluate((element: PdfViewerElement) => element.removeObject("a"));

    expect(await events()).toMatchObject([{ origin: "api", object: { id: "a", rect: start, kind: "note" } }]);
  });

  test("setObjects_ShouldReportOneReplacement_WhenGivenSeveralObjects", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    const replaced = await viewer.recordEvents("pv-objects-replaced");
    const added = await viewer.recordEvents("pv-object-added");

    await viewer.host.evaluate((element: PdfViewerElement, rect) => {
      element.setObjects([{ id: "b", page: 1, rect }, { id: "c", page: 1, rect }]);
    }, start);

    expect((await replaced()).map(({ origin }) => origin)).toEqual(["api"]);
    expect(await added()).toEqual([]);
    await expect(viewer.pageElement()).toHaveAttribute("data-object-count", "2");
  });
});

test.describe("selecting several objects", () => {
  test("selectObjects_ShouldMarkEachAndShowNoHandles_WhenGivenTwo", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await viewer.addObject({ id: "b", page: 1, rect: { x: 100, y: 300, width: 50, height: 50 } });
    const events = await viewer.recordEvents("pv-selection-change");

    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObjects(["a", "b"]));

    await expect(viewer.object("a")).toHaveAttribute("aria-selected", "true");
    await expect(viewer.object("b")).toHaveAttribute("aria-selected", "true");
    await expect(viewer.host).toHaveAttribute("data-selected-object", "b");
    await expect(page.locator("[data-handle]")).toHaveCount(0);
    expect(await events()).toMatchObject([{ origin: "api", ids: ["a", "b"], primaryId: "b" }]);
  });

  test("click_ShouldSelectOnlyThatObject_WhenSeveralWereSelected", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await viewer.addObject({ id: "b", page: 1, rect: { x: 100, y: 300, width: 50, height: 50 } });
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObjects(["a", "b"]));

    await viewer.object("a").click();

    await expect(viewer.object("b")).toHaveAttribute("aria-selected", "false");
    await expect(page.locator('[data-handle-for="a"]')).toHaveCount(8);
    expect(await viewer.host.evaluate((element: PdfViewerElement) => element.selectedObjectIds)).toEqual(["a"]);
  });
});

test.describe("programmatic changes", () => {
  test("change_ShouldReportApiOrigin_WhenObjectIsAddedByCode", async ({ page }) => {
    const viewer = await openViewer(page);
    const events = await viewer.recordEvents("pv-object-added");

    await viewer.addObject({ id: "a", page: 1, rect: start });

    expect((await events()).map(({ origin }) => origin)).toEqual(["api"]);
  });

  test("objectCount_ShouldTrackPage_WhenObjectsSpanPages", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await viewer.addObject({ id: "b", page: 2, rect: start });

    await expect(viewer.pageElement()).toHaveAttribute("data-object-count", "1");
    expect(await viewer.getObjects()).toHaveLength(2);
    await expect(viewer.object("b")).toHaveCount(0);
  });

  test("pageRect_ShouldUpdateElement_WhenObjectIsUpdatedByCode", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    await viewer.host.evaluate((element: PdfViewerElement) => {
      element.updateObject("a", { rect: { x: 1, y: 2, width: 3, height: 4 } });
    });

    const value = await viewer.object("a").getAttribute("data-page-rect");
    expect(parseRect(value)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});

test.describe("application fields", () => {
  test("object_ShouldShowKindShapeClassesAndAppData_WhenGivenThem", async ({ page }) => {
    const viewer = await openViewer(page);

    await viewer.addObject({ id: "a", page: 1, rect: start, kind: "heading", cssClass: "emphasized important",
      appData: { section: "3", "review-step": "2" } });

    const object = viewer.object("a");
    await expect(object).toHaveAttribute("data-object-kind", "heading");
    await expect(object).toHaveAttribute("data-object-shape", "rect");
    await expect(object).toHaveAttribute("class", "pv-object emphasized important");
    await expect(object).toHaveAttribute("data-app-section", "3");
    await expect(object).toHaveAttribute("data-app-review-step", "2");
    await expect(page.locator('[data-object-kind="heading"][data-app-section="3"]')).toHaveCount(1);
  });

  test("updateObject_ShouldRemoveAppDataAttributes_WhenKeysAreLeftOut", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, appData: { section: "3", "review-step": "2" } });

    await viewer.host.evaluate((element: PdfViewerElement) => {
      element.updateObject("a", { appData: { section: "4" } });
    });

    await expect(viewer.object("a")).toHaveAttribute("data-app-section", "4");
    await expect(viewer.object("a")).not.toHaveAttribute("data-app-review-step");
  });

  test("cssClass_ShouldLetApplicationStyleObject_WhenItsStylesheetTargetsTheClass", async ({ page }) => {
    const viewer = await openViewer(page);
    await page.addStyleTag({ content: ".pv-object.emphasized { border-color: rgb(0, 128, 0); }" });

    await viewer.addObject({ id: "a", page: 1, rect: start, cssClass: "emphasized" });

    await expect(viewer.object("a")).toHaveCSS("border-top-color", "rgb(0, 128, 0)");
  });

  test("object_ShouldBeNeitherVisibleNorReachable_WhenHidden", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, hidden: true });
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("a"));

    const center = await viewer.host.evaluate((element: PdfViewerElement, { x, y, width, height }) =>
      element.pageToClient(1, { x: x + width / 2, y: y + height / 2 }), start);
    const reached = await viewer.object("a").evaluate((object, point) => {
      object.focus();
      const hit = document.elementFromPoint(point!.x, point!.y) === object;
      return { hit, focused: document.activeElement === object };
    }, center);

    await expect(viewer.object("a")).toBeHidden();
    expect(reached).toEqual({ hit: false, focused: false });
    await expect(page.locator("[data-handle]")).toHaveCount(0);
  });

  test("hiddenObject_ShouldReappearInPlaceWithHandles_WhenShownAgain", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, hidden: true });
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("a"));

    await viewer.host.evaluate((element: PdfViewerElement) => { element.updateObject("a", { hidden: false }); });

    await expect(viewer.object("a")).toBeVisible();
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,200,100");
    await expect(page.locator("[data-handle]")).toHaveCount(8);
  });

  test("defaultLabels_ShouldBeUniqueOnPage_WhenObjectsHaveNoLabel", async ({ page }) => {
    const viewer = await openViewer(page);

    for (const id of ["a", "b", "c"]) {
      await viewer.addObject({ id, page: 1, rect: start });
    }

    for (const [index, id] of ["a", "b", "c"].entries()) {
      await expect(viewer.object(id)).toHaveAttribute("aria-label", `Object ${index + 1} on page 1`);
    }
  });
});
