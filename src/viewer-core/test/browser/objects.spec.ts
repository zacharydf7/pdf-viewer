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
    const events = await viewer.recordAdded();

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

  test("drawRect_ShouldNotSelectNewObject_WhenSelectOnCreateIsOff", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.host.evaluate((element: PdfViewerElement) => element.configure({ selectOnCreate: false }));
    await viewer.setTool("draw-rect");

    await viewer.drag(await viewer.pagePoint(0.1, 0.1), await viewer.pagePoint(0.3, 0.3));

    await expect(page.locator("[data-object-id]")).toHaveCount(1);
    await expect(page.getByRole("option", { selected: true })).toHaveCount(0);
  });
});

test.describe("drafts", () => {
  test("objectDrawn_ShouldReportDraftBeforeItBecomesObject_WhenDrawFinishes", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.host.evaluate((element: PdfViewerElement) => {
      element.setTool("draw-rect", { kind: "heading" });
      element.addEventListener("pv-object-drawn", ({ detail: { object } }) => {
        const shown = element.querySelectorAll(`[data-draft-id="${object.id}"]`).length;
        (window as unknown as { drawn: unknown }).drawn = { object, shown, stored: element.getObject(object.id) };
      });
    });

    await viewer.drag(await viewer.pagePoint(0.2, 0.2), await viewer.pagePoint(0.4, 0.3));

    const [added] = await viewer.getObjects();
    const drawn = await page.evaluate(() => (window as unknown as { drawn: Record<string, unknown> }).drawn);
    expect(drawn).toEqual({ object: added, shown: 1, stored: undefined });
    expect(added).toMatchObject({ page: 1, kind: "heading" });
    await expect(viewer.drafts).toHaveCount(0);
  });

  test("objectDrawn_ShouldLeaveVisibleDraftAndNoObject_WhenListenerCancelsEvent", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const changes = await viewer.recordEvents("pv-objects-changed");
    const from = await viewer.pagePoint(0.2, 0.2);
    const to = await viewer.pagePoint(0.4, 0.3);
    await viewer.setTool("draw-rect");

    await viewer.drag(from, to);

    await expect(viewer.drafts).toBeVisible();
    const pageBox = (await viewer.pageElement().boundingBox())!;
    expectRectsClose(await viewer.boundsOnPage(viewer.drafts), {
      x: from.x - pageBox.x, y: from.y - pageBox.y, width: to.x - from.x, height: to.y - from.y,
    }, 1);
    const rect = parseRect(await viewer.drafts.getAttribute("data-page-rect"));
    expect(rect.width).toBeCloseTo(612 * 0.2, 0);
    await expect(viewer.pageElement()).toHaveAttribute("data-object-count", "0");
    await expect(viewer.host).toHaveAttribute("data-selected-object", "");
    expect(await viewer.getObjects()).toEqual([]);
    expect(await changes()).toEqual([]);
  });

  test("commitDraft_ShouldAddDrawnObjectAsUserChangeAndSelectIt_WhenListenerKeptDraft", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const added = await viewer.recordAdded();
    const id = await viewer.drawDraft();

    const committed = await viewer.host.evaluate((element: PdfViewerElement, value) => element.commitDraft(value), id);

    expect(committed).toBe(true);
    await expect(viewer.object(id)).toBeVisible();
    await expect(viewer.drafts).toHaveCount(0);
    await expect(viewer.host).toHaveAttribute("data-selected-object", id);
    expect((await added()).map(({ origin, object }) => [origin, object.id])).toEqual([["user", id]]);
  });

  test("discardDraft_ShouldLeaveNothingBehind_WhenListenerKeptDraft", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const changes = await viewer.recordEvents("pv-objects-changed");
    const id = await viewer.drawDraft();

    const discarded = await viewer.host.evaluate((element: PdfViewerElement, value) => element.discardDraft(value), id);

    expect(discarded).toBe(true);
    await expect(viewer.drafts).toHaveCount(0);
    await expect(page.locator("[data-object-id]")).toHaveCount(0);
    expect(await changes()).toEqual([]);
  });

  test("addObject_ShouldCommitDraftUnderGivenValues_WhenObjectHasDraftId", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const added = await viewer.recordAdded();
    const id = await viewer.drawDraft();

    await viewer.addObject({ id, page: 1, rect: start, label: "Kept region" });

    await expect(page.locator("[data-object-id]")).toHaveCount(1);
    await expect(viewer.object(id)).toHaveAttribute("aria-label", "Kept region");
    await expect(viewer.object(id)).toHaveAttribute("aria-selected", "true");
    await expect(viewer.drafts).toHaveCount(0);
    expect((await added()).map(({ origin }) => origin)).toEqual(["api"]);
  });

  for (const [state, values] of [["Unselectable", { selectable: false }], ["Hidden", { hidden: true }]] as const) {
    test(`addObject_ShouldNotSelectCommittedDraft_WhenObjectIs${state}`, async ({ page }) => {
      const viewer = await openViewer(page);
      await viewer.keepDrawnObjectsAsDrafts();
      const id = await viewer.drawDraft();

      await viewer.addObject({ id, page: 1, rect: start, ...values });

      await expect(viewer.drafts).toHaveCount(0);
      await expect(viewer.host).toHaveAttribute("data-selected-object", "");
    });
  }

  test("draft_ShouldBeGoneFromPage_WhenObjectsChangedReportsItsCommit", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const id = await viewer.drawDraft();

    const shownDuringEvent = await viewer.host.evaluate((element: PdfViewerElement, value) => {
      let shown = -1;
      element.addEventListener("pv-objects-changed", () => {
        shown = element.querySelectorAll("[data-draft-id]").length;
      });
      element.commitDraft(value);
      return shown;
    }, id);

    expect(shownDuringEvent).toBe(0);
  });

  test("draft_ShouldLetPressReachObjectUnderIt_WhenSelectToolIsActive", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "under", page: 1, rect: { x: 0, y: 0, width: 612, height: 792 } });
    await viewer.keepDrawnObjectsAsDrafts();
    await viewer.drawDraft();
    await viewer.setTool("select");

    const center = await viewer.center(viewer.drafts);
    await page.mouse.click(center.x, center.y);

    await expect(viewer.host).toHaveAttribute("data-selected-object", "under");
    await expect(viewer.drafts).toHaveCount(1);
  });

  test("drawRect_ShouldKeepEarlierDraft_WhenUserDrawsAgainWhileItIsPending", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const first = await viewer.drawDraft();

    await viewer.drag(await viewer.pagePoint(0.25, 0.22), await viewer.pagePoint(0.6, 0.6));

    await expect(viewer.drafts).toHaveCount(2);
    const ids = await viewer.drafts.evaluateAll((elements) => elements.map((element) => element.dataset.draftId));
    expect(ids[0]).toBe(first);
    expect(ids[1]).not.toBe(first);
  });

  test("draft_ShouldShowOnlyOnItsPage_WhenPageTurnsAwayAndBack", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const id = await viewer.drawDraft();
    const rect = await viewer.drafts.getAttribute("data-page-rect");

    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(2));
    const onSecondPage = await viewer.drafts.count();
    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(1));

    expect(onSecondPage).toBe(0);
    await expect(viewer.drafts).toHaveAttribute("data-draft-id", id);
    await expect(viewer.drafts).toHaveAttribute("data-page-rect", rect!);
  });

  test("draft_ShouldShowWhereItsObjectWillBe_WhenPageIsRotatedBeforeCommit", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const id = await viewer.drawDraft();

    await viewer.setRotation(90);
    const draftBounds = await viewer.boundsOnPage(viewer.drafts);
    await viewer.host.evaluate((element: PdfViewerElement, value) => element.commitDraft(value), id);

    expect(draftBounds.height).toBeGreaterThan(draftBounds.width);
    expectRectsClose(await viewer.boundsOnPage(viewer.object(id)), draftBounds, 0.01);
  });

  test("close_ShouldDiscardDrafts_WhenDocumentCloses", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.keepDrawnObjectsAsDrafts();
    const id = await viewer.drawDraft();

    await viewer.host.evaluate((element: PdfViewerElement) => element.close());
    await viewer.open("letter");

    await expect(viewer.drafts).toHaveCount(0);
    expect(await viewer.host.evaluate((element: PdfViewerElement, value) => element.commitDraft(value), id))
      .toBe(false);
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
    const events = await viewer.recordUpdated();

    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 100, y: from.y + 60 });

    // Zoom is 2, so 100 by 60 CSS pixels is 50 by 30 page units.
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "150,130,200,100");
    expect(await events()).toMatchObject([{ origin: "user", gesture: "move", previous: { rect: start } }]);
  });

  test("object_ShouldNotReportChange_WhenClickedWithoutMoving", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    const events = await viewer.recordUpdated();

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
    const events = await viewer.recordUpdated();

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
      const events = await viewer.recordUpdated();

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

    const events = await viewer.recordUpdated();

    await viewer.object("a").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+ArrowDown");

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "101,110,200,100");
    expect((await events()).map(({ gesture }) => gesture)).toEqual(["nudge", "nudge"]);
  });

  test("shiftArrowKey_ShouldResizeFocusedObject_WhenPressed", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    const events = await viewer.recordUpdated();

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
    const events = await viewer.recordRemoved();

    await viewer.host.evaluate((element: PdfViewerElement) => element.removeObject("a"));

    expect(await events()).toMatchObject([{ origin: "api", object: { id: "a", rect: start, kind: "note" } }]);
  });

  test("setObjects_ShouldReportOneChangeWithOnlyWhatDiffers_WhenSomeObjectsStay", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await viewer.addObject({ id: "b", page: 1, rect: start });
    const changes = await viewer.recordEvents("pv-objects-changed");

    await viewer.host.evaluate((element: PdfViewerElement, rect) => {
      element.setObjects([{ id: "b", page: 1, rect }, { id: "c", page: 1, rect }]);
    }, start);

    const reported = (await changes()).map(({ origin, added, updated, removed }) =>
      [origin, added.map(({ id }) => id), updated.length, removed.map(({ id }) => id)]);
    expect(reported).toEqual([["api", ["c"], 0, ["a"]]]);
    await expect(viewer.pageElement()).toHaveAttribute("data-object-count", "2");
  });

  test("applyObjects_ShouldReportOneChange_WhenBatchAddsReplacesAndRemoves", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start, label: "Old" });
    await viewer.addObject({ id: "b", page: 1, rect: start });
    const changes = await viewer.recordEvents("pv-objects-changed");

    await viewer.host.evaluate((element: PdfViewerElement, rect) => {
      const upsert = [{ id: "a", page: 1, rect }, { id: "c", page: 1, rect }];
      element.applyObjects({ upsert, remove: ["b", "missing"] });
    }, start);

    expect(await changes()).toHaveLength(1);
    await expect(viewer.object("a")).toHaveAttribute("aria-label", /^Object/);
    await expect(viewer.object("b")).toHaveCount(0);
    await expect(viewer.object("c")).toHaveCount(1);
  });

  test("applyObjects_ShouldApplyToReusedId_WhenUserMovedThatIdInPreviousDocument", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });
    const changes = await viewer.recordEvents("pv-objects-changed");
    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 40, y: from.y + 20 });
    const basedOn = (await changes())[0]!.sequence - 1;

    await viewer.open("letter");
    await viewer.host.evaluate((element: PdfViewerElement, { rect, basedOn }) => {
      element.applyObjects({ upsert: [{ id: "a", page: 1, rect }], basedOn });
    }, { rect: start, basedOn });

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,200,100");
  });

  test("upsertObject_ShouldAddThenReplace_WhenCalledTwiceWithSameId", async ({ page }) => {
    const viewer = await openViewer(page);

    await viewer.host.evaluate((element: PdfViewerElement, rect) => {
      element.upsertObject({ id: "a", page: 1, rect, kind: "note" });
      element.upsertObject({ id: "a", page: 1, rect: { ...rect, x: 5 } });
    }, start);

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "5,100,200,100");
    await expect(viewer.object("a")).not.toHaveAttribute("data-object-kind");
  });

  test("removeObject_ShouldReturnFalseWithoutThrowing_WhenObjectDoesNotExist", async ({ page }) => {
    const viewer = await openViewer(page);
    await viewer.addObject({ id: "a", page: 1, rect: start });

    const removed = await viewer.host.evaluate((element: PdfViewerElement) =>
      [element.removeObject("a"), element.removeObject("a")]);

    expect(removed).toEqual([true, false]);
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
    const events = await viewer.recordAdded();

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

test.describe("objects on every page", () => {
  test("object_ShouldAppearOnEveryPage_WhenItsPageIsNull", async ({ page }) => {
    const viewer = await openViewer(page, "mixed-sizes");
    await viewer.addObject({ id: "a", page: null, rect: start });
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,200,100");

    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(2));

    await expect(viewer.pageElement(2).locator('[data-object-id="a"]'))
      .toHaveAttribute("data-page-rect", "100,100,200,100");
    await expect(viewer.pageElement(2)).toHaveAttribute("data-object-count", "1");
  });

  test("object_ShouldBeClippedNotMoved_WhenPageIsTooSmallForItsRectangle", async ({ page }) => {
    const viewer = await openViewer(page, "mixed-sizes");
    // Below the bottom of page 2, which is 612 units high, but on page 1, which is 792.
    await viewer.addObject({ id: "a", page: null, rect: { x: 100, y: 650, width: 100, height: 100 } });
    await expect(viewer.object("a")).toBeInViewport();

    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(2));
    await viewer.waitForPage(2);

    const object = viewer.pageElement(2).locator('[data-object-id="a"]');
    await expect(object).toHaveAttribute("data-page-rect", "100,650,100,100");
    const pageBox = (await viewer.pageElement(2).boundingBox())!;
    expect((await object.boundingBox())!.y).toBeGreaterThanOrEqual(pageBox.y + pageBox.height);
    await expect(viewer.pageElement(2)).toHaveCSS("overflow", "hidden");
  });

  test("drag_ShouldLeaveObjectOnEveryPage_WhenUserMovesIt", async ({ page }) => {
    const viewer = await openViewer(page, "mixed-sizes");
    await viewer.addObject({ id: "a", page: null, rect: start });

    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 30, y: from.y + 10 });

    const moved = { x: 130, y: 110, width: 200, height: 100 };
    expect(await viewer.getObject("a")).toMatchObject({ page: null, rect: moved });
    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(2));
    await expect(viewer.pageElement(2).locator('[data-object-id="a"]'))
      .toHaveAttribute("data-page-rect", "130,110,200,100");
  });
});
