import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { ObjectChange } from "../../src/object-store.js";
import type { PdfViewerElement, ViewerOptions } from "../../src/viewer-element.js";
import { expectRectsClose, fixtureUrl, manifest, Viewer } from "./support.js";

const start = { x: 100, y: 100, width: 200, height: 100 };

async function openViewer(page: Page, options: ViewerOptions, fixture = "letter"): Promise<Viewer> {
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.host.evaluate((element: PdfViewerElement, value) => element.configure(value), options);
  await viewer.open(fixture);
  return viewer;
}

async function isVisibleColor(viewer: Viewer, channels: [number, number, number]): Promise<boolean> {
  return viewer.pageElement().evaluate((page, [red, green, blue]) => {
    const canvas = page.querySelector("canvas")!;
    const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < data.length; offset += 4) {
      const close = (index: number, value: number) => Math.abs(data[offset + index]! - value) < 30;
      if (close(0, red!) && close(1, green!) && close(2, blue!)) {
        return true;
      }
    }
    return false;
  }, channels);
}

test.describe("hidden start", () => {
  test("viewer_ShouldRenderOnceShown_WhenOpenedWhileHidden", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.host.evaluate((element: PdfViewerElement, url) => {
      element.style.display = "none";
      void element.open({ kind: "url", url });
    }, fixtureUrl("letter"));
    await expect(viewer.host).toHaveAttribute("data-document-state", "ready");
    await expect(viewer.pageElement()).toHaveAttribute("data-page-state", "pending");

    await viewer.host.evaluate((element: PdfViewerElement) => { element.style.display = ""; });

    await viewer.waitForPage();
    await expect(viewer.pageElement().locator("canvas")).toBeVisible();
    expect((await viewer.pageElement().boundingBox())!.width).toBeGreaterThan(100);
  });

  test("addObject_ShouldKeepItsPosition_WhenAddedWhileHidden", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.host.evaluate((element: PdfViewerElement, url) => {
      element.style.display = "none";
      void element.open({ kind: "url", url });
    }, fixtureUrl("letter"));
    await expect(viewer.pageElement()).toHaveAttribute("data-page-state", "pending");
    await viewer.addObject({ id: "ink", page: 1, rect: manifest.letter![0]! });

    await viewer.host.evaluate((element: PdfViewerElement) => { element.style.display = ""; });

    await viewer.waitForPage();
    expectRectsClose(await viewer.boundsOnPage(viewer.object("ink")), await viewer.inkBounds(), 1);
  });
});

test.describe("fit and center", () => {
  test("page_ShouldBeCenteredAndFullyVisible_WhenFittingPage", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: "fit-page" }, "a4");

    const box = (await viewer.pageElement().boundingBox())!;
    const host = (await viewer.host.boundingBox())!;

    expect(box.height).toBeLessThanOrEqual(host.height);
    expect(box.width).toBeLessThanOrEqual(host.width);
    // Rounded widths and a reserved scrollbar gutter mean the sides can differ, but only by the gutter.
    const leftGap = box.x - host.x;
    const rightGap = host.x + host.width - (box.x + box.width);
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(20);
    expect(box.y - host.y).toBeLessThanOrEqual(1);
  });

  test("page_ShouldBeCenteredBothWays_WhenSmallerThanViewer", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 0.5 });

    const box = (await viewer.pageElement().boundingBox())!;
    const host = (await viewer.host.boundingBox())!;

    expect(Math.abs(box.y - host.y - (host.y + host.height - (box.y + box.height)))).toBeLessThanOrEqual(20);
    expect(box.x - host.x).toBeGreaterThan(100);
  });

  test("page_ShouldBeFullyScrollable_WhenLargerThanViewer", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 3 });

    const reachedTop = await page.locator(".pv-viewport").evaluate((viewport) => {
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
      const pageBox = viewport.querySelector(".pv-page")!.getBoundingClientRect();
      const viewportBox = viewport.getBoundingClientRect();
      return pageBox.top >= viewportBox.top - 1 && pageBox.left >= viewportBox.left - 1;
    });

    expect(reachedTop).toBe(true);
  });
});

test.describe("page rotation", () => {
  test("setPageRotation_ShouldGiveFinalRotation_WhenPageAlreadyHasOne", async ({ page }) => {
    const viewer = await openViewer(page, {}, "rotate-90");
    await expect(viewer.pageElement()).toHaveAttribute("data-rotation", "90");

    await viewer.host.evaluate((element: PdfViewerElement) => element.setPageRotation(1, 180));
    await viewer.waitForPage();

    await expect(viewer.pageElement()).toHaveAttribute("data-rotation", "180");
  });

  test("setPageRotation_ShouldNotAccumulate_WhenCalledRepeatedly", async ({ page }) => {
    const viewer = await openViewer(page, {});

    await viewer.host.evaluate(async (element: PdfViewerElement) => {
      await element.setPageRotation(1, 90);
      await element.setPageRotation(1, 90);
    });
    await viewer.waitForPage();

    await expect(viewer.pageElement()).toHaveAttribute("data-rotation", "90");
  });

  test("setPageRotation_ShouldApplyOnlyToThatPage_WhenNavigating", async ({ page }) => {
    const viewer = await openViewer(page, {});

    await viewer.host.evaluate((element: PdfViewerElement) => element.setPageRotation(2, 270));
    await expect(viewer.pageElement(1)).toHaveAttribute("data-rotation", "0");

    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(2));
    await viewer.waitForPage(2);
    await expect(viewer.pageElement(2)).toHaveAttribute("data-rotation", "270");

    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(3));
    await viewer.waitForPage(3);
    await expect(viewer.pageElement(3)).toHaveAttribute("data-rotation", "0");
  });

  test("setPageRotation_ShouldKeepObjectOnInk_WhenRotated", async ({ page }) => {
    const viewer = await openViewer(page, {}, "rotate-90");
    await viewer.addObject({ id: "ink", page: 1, rect: manifest["rotate-90"]![0]! });

    await viewer.host.evaluate((element: PdfViewerElement) => element.setPageRotation(1, 270));
    await viewer.waitForPage();
    await expect(viewer.pageElement()).toHaveAttribute("data-rotation", "270");

    expectRectsClose(await viewer.boundsOnPage(viewer.object("ink")), await viewer.inkBounds(), 1);
  });

  test("setPageRotation_ShouldRestorePageRotation_WhenGivenNull", async ({ page }) => {
    const viewer = await openViewer(page, {}, "rotate-90");
    await viewer.host.evaluate((element: PdfViewerElement) => element.setPageRotation(1, 0));
    await viewer.waitForPage();

    await viewer.host.evaluate((element: PdfViewerElement) => element.setPageRotation(1, null));
    await viewer.waitForPage();

    await expect(viewer.pageElement()).toHaveAttribute("data-rotation", "90");
  });

  test("open_ShouldForgetPageRotations_WhenReplacingDocument", async ({ page }) => {
    const viewer = await openViewer(page, {});
    await viewer.host.evaluate((element: PdfViewerElement) => element.setPageRotation(1, 90));
    await viewer.waitForPage();

    await viewer.open("a4");

    await expect(viewer.pageElement()).toHaveAttribute("data-rotation", "0");
  });
});

test.describe("wheel zoom", () => {
  test("controlWheel_ShouldZoomAndKeepPointOverPointer_WhenScrolled", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    const point = await viewer.pagePoint(0.5, 0.25);
    const box = (await viewer.pageElement().boundingBox())!;
    const fractionX = (point.x - box.x) / box.width;
    const fractionY = (point.y - box.y) / box.height;
    await page.mouse.move(point.x, point.y);

    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");

    await expect.poll(async () => Number(await viewer.host.getAttribute("data-zoom"))).toBeGreaterThan(1.2);
    await viewer.waitForPage();
    const after = (await viewer.pageElement().boundingBox())!;
    expect(Math.abs(after.x + after.width * fractionX - point.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.y + after.height * fractionY - point.y)).toBeLessThanOrEqual(2);
  });

  test("controlWheel_ShouldDoNothing_WhenWheelZoomIsOff", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1, wheelZoom: false });
    const point = await viewer.pagePoint(0.5, 0.25);
    await page.mouse.move(point.x, point.y);

    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await page.evaluate(() => new Promise(requestAnimationFrame));

    await expect(viewer.host).toHaveAttribute("data-zoom", "1");
  });

  test("wheel_ShouldScrollNotZoom_WhenControlIsNotHeld", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 2 });
    const point = await viewer.pagePoint(0.5, 0.25);
    await page.mouse.move(point.x, point.y);

    await page.mouse.wheel(0, 200);

    await expect.poll(() => page.locator(".pv-viewport").evaluate((viewport) => viewport.scrollTop)).toBeGreaterThan(0);
    await expect(viewer.host).toHaveAttribute("data-zoom", "2");
    await expect(viewer.host).toHaveAttribute("data-page-count", "3");
    await expect(viewer.host).toHaveAttribute("data-current-page", "1");
  });
});

test.describe("form fields", () => {
  test("canvas_ShouldShowFieldsAndAnnotations_WhenFormFieldsAreNotHidden", async ({ page }) => {
    const viewer = await openViewer(page, {}, "annotations");

    expect(await isVisibleColor(viewer, [0, 255, 0])).toBe(true);
    expect(await isVisibleColor(viewer, [0, 0, 255])).toBe(true);
  });

  test("canvas_ShouldHideFieldsButKeepAnnotations_WhenFormFieldsAreHidden", async ({ page }) => {
    const viewer = await openViewer(page, { hideFormFields: true }, "annotations");

    expect(await isVisibleColor(viewer, [0, 255, 0])).toBe(false);
    expect(await isVisibleColor(viewer, [0, 0, 255])).toBe(true);
  });
});

test.describe("keyboard editing off", () => {
  test("keys_ShouldReachHostAndChangeNothing_WhenKeyboardEditingIsOff", async ({ page }) => {
    const viewer = await openViewer(page, { keyboardEditing: false });
    await viewer.addObject({ id: "a", page: 1, rect: start });
    await page.evaluate(() => {
      (window as unknown as { keys: string[] }).keys = [];
      document.addEventListener("keydown", (event) => {
        (window as unknown as { keys: string[] }).keys.push(event.key);
      });
    });

    await viewer.object("a").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");

    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual(["ArrowRight", "Delete"]);
    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "100,100,200,100");
  });
});

test.describe("rounding", () => {
  test("drawRect_ShouldProduceWholeUnits_WhenRoundingIsOn", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1.37, roundCoordinates: true });
    await viewer.setTool("draw-rect");

    await viewer.drag(await viewer.pagePoint(0.21, 0.23), await viewer.pagePoint(0.47, 0.41));

    const objects = await viewer.getObjects();
    expect(objects).toHaveLength(1);
    for (const value of Object.values(objects[0]!.rect)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  test("move_ShouldProduceWholeUnits_WhenRoundingIsOn", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1.37, roundCoordinates: true });
    await viewer.addObject({ id: "a", page: 1, rect: start });

    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 33, y: from.y + 17 });

    const { rect } = (await viewer.getObject("a"))!;
    expect(Number.isInteger(rect.x) && Number.isInteger(rect.y)).toBe(true);
    expect([rect.width, rect.height]).toEqual([200, 100]);
    expect(rect.x).toBeGreaterThan(100);
  });

  test("move_ShouldReportNoChangeAndRestorePosition_WhenItRoundsBackToOriginal", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 4, roundCoordinates: true });
    await viewer.addObject({ id: "a", page: 1, rect: start });
    const events = await viewer.recordEvents("pv-object-change");
    const before = await viewer.boundsOnPage(viewer.object("a"));

    const from = await viewer.center(viewer.object("a"));
    await viewer.drag(from, { x: from.x + 1, y: from.y });

    expect(await events()).toEqual([]);
    expectRectsClose(await viewer.boundsOnPage(viewer.object("a")), before, 0.01);
  });

  test("keyboardMove_ShouldStayOnWholeUnits_WhenRoundingIsOn", async ({ page }) => {
    const viewer = await openViewer(page, { roundCoordinates: true });
    await viewer.addObject({ id: "a", page: 1, rect: start });

    await viewer.object("a").focus();
    await page.keyboard.press("ArrowRight");

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "101,100,200,100");
  });
});

test.describe("tags and styles", () => {
  test("drawRect_ShouldCarryTagThroughToChangeEvent_WhenToolHasTag", async ({ page }) => {
    const viewer = await openViewer(page, {});
    await viewer.host.evaluate((element: PdfViewerElement) => {
      element.setTool("draw-rect", { tag: "heading", style: { color: "rgb(255, 0, 0)", borderWidth: "5px" } });
    });
    const events = await viewer.recordEvents("pv-object-change");

    await viewer.drag(await viewer.pagePoint(0.2, 0.2), await viewer.pagePoint(0.4, 0.4));

    const [change] = (await events()) as ObjectChange[];
    expect(change).toMatchObject({ kind: "added", origin: "user", object: { tag: "heading" } });
    const object = page.locator('[data-object-tag="heading"]');
    await expect(object).toHaveCSS("border-top-color", "rgb(255, 0, 0)");
    // Browsers snap borders to device pixels, so the computed width can be slightly under the 5px asked for.
    const width = await object.evaluate((element) => parseFloat(getComputedStyle(element).borderTopWidth));
    expect(width).toBeGreaterThan(4);
    expect(width).toBeLessThanOrEqual(5);
  });
});

test.describe("document bytes", () => {
  test("getDocumentData_ShouldReturnOriginalBytes_WhenOpenedFromLocalData", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    const [length, matches] = await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
      const original = new Uint8Array(await (await fetch(url)).arrayBuffer());
      await element.open({ kind: "data", data: original.slice() });
      const data = await element.getDocumentData();
      return [data.length, data.length === original.length && data.every((value, index) => value === original[index])];
    }, fixtureUrl("letter"));

    expect(length).toBeGreaterThan(0);
    expect(matches).toBe(true);
  });

  test("getDocumentData_ShouldReject_WhenNoDocumentIsOpen", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    const message = await viewer.host.evaluate((element: PdfViewerElement) =>
      element.getDocumentData().then(() => "", (error: Error) => error.message));

    expect(message).toContain("No document");
  });
});
