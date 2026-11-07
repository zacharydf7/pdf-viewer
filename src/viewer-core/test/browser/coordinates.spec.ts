import { expect, test } from "@playwright/test";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { expectRectsClose, manifest, parseRect, Viewer } from "./support.js";

const inkId = "ink";
const onePixel = 1;

// Each fixture has red ink at a location known by construction. An object placed at those page coordinates must land
// exactly on the ink as actually rendered, for every page shape, viewing rotation and zoom.
const documents = ["letter", "a4", "crop-offset", "negative-origin", "rotate-90", "rotate-180", "rotate-270",
  "crop-offset-rotate-90", "user-unit"];

test.describe("object placement over rendered ink", () => {
  for (const name of documents) {
    for (const rotation of [0, 90, 180, 270]) {
      for (const zoom of [0.75, 1.37, 2]) {
        test(`addObject_ShouldCoverInk_WhenGiven${name}AtRotation${rotation}AndZoom${zoom}`, async ({ page }) => {
          const viewer = new Viewer(page);
          await viewer.goto();
          await viewer.open(name);
          await viewer.setZoom(zoom);
          await viewer.setRotation(rotation);
          await viewer.addObject({ id: inkId, page: 1, rect: manifest[name]![0]! });

          expectRectsClose(await viewer.boundsOnPage(viewer.object(inkId)), await viewer.inkBounds(), onePixel);
        });
      }
    }
  }

  test("addObject_ShouldCoverInkOnEveryPage_WhenPagesHaveDifferentSizesAndRotations", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.open("mixed-sizes");
    for (const [index, rect] of manifest["mixed-sizes"]!.entries()) {
      const pageNumber = index + 1;
      await viewer.host.evaluate((element: PdfViewerElement, value) => element.goToPage(value), pageNumber);
      await viewer.waitForPage(pageNumber);
      await viewer.addObject({ id: `ink-${pageNumber}`, page: pageNumber, rect });

      const object = viewer.object(`ink-${pageNumber}`);
      expectRectsClose(await viewer.boundsOnPage(object, pageNumber), await viewer.inkBounds(pageNumber), onePixel);
    }
  });
});

test.describe("zoom", () => {
  test("setZoom_ShouldKeepObjectOnInkAndWriteNoObjectStyles_WhenZoomChanges", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.open("letter");
    await viewer.addObject({ id: inkId, page: 1, rect: manifest.letter![0]! });

    await page.evaluate((id) => {
      const state = window as unknown as { objectWrites: number };
      state.objectWrites = 0;
      new MutationObserver((records) => { state.objectWrites += records.length; })
        .observe(document.querySelector(`[data-object-id="${id}"]`)!, { attributes: true });
    }, inkId);

    await viewer.setZoom(2);
    expectRectsClose(await viewer.boundsOnPage(viewer.object(inkId)), await viewer.inkBounds(), onePixel);
    await viewer.setZoom(0.5);
    expectRectsClose(await viewer.boundsOnPage(viewer.object(inkId)), await viewer.inkBounds(), onePixel);

    expect(await page.evaluate(() => (window as unknown as { objectWrites: number }).objectWrites)).toBe(0);
  });

  test("renderScale_ShouldOnlyChangeWhenRenderFinishes_WhenZoomChanges", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.open("letter");
    await viewer.setZoom(1);
    await expect(viewer.pageElement()).toHaveAttribute("data-render-scale", "1");

    await viewer.setZoom(2);

    await expect(viewer.pageElement()).toHaveAttribute("data-render-scale", "2");
    const canvas = viewer.pageElement().locator("canvas");
    const canvasWidth = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
    expect(canvasWidth).toBe(1224);
  });
});

test.describe("reported coordinates", () => {
  test("pageRect_ShouldMatchObjectRectangle_WhenObjectIsAdded", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.open("letter");
    const rect = { x: 10.5, y: 20.25, width: 30, height: 40 };
    await viewer.addObject({ id: "reported", page: 1, rect });

    expect(parseRect(await viewer.object("reported").getAttribute("data-page-rect"))).toEqual(rect);
  });

  test("pageRect_ShouldStayTheSame_WhenViewChanges", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.open("letter");
    const rect = manifest.letter![0]!;
    await viewer.addObject({ id: "stable", page: 1, rect });

    await viewer.setZoom(1.7);
    await viewer.setRotation(90);

    expect(parseRect(await viewer.object("stable").getAttribute("data-page-rect"))).toEqual(rect);
    expect((await viewer.getObject("stable"))?.rect).toEqual(rect);
  });
});
