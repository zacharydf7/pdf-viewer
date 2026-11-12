import { expect, test } from "@playwright/test";
import { expectRectsClose, manifest, openViewer } from "./support.js";

test("page_ShouldDrawGlyphsWhereDocumentPutsThem_WhenFontIsType3", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 }, "type3-font");

  expectRectsClose(await viewer.inkBounds(), manifest["type3-font"]![0]!, 1);
});

test("textLayer_ShouldCoverGlyphs_WhenFontIsType3", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 }, "type3-font");

  const text = viewer.pageElement().locator(".textLayer span", { hasText: "ABBA" });
  const span = await viewer.boundsOnPage(text);
  const ink = await viewer.inkBounds();

  // The span is as wide as the text's advance and as tall as its line, so it's a little larger than the ink.
  expect(span.x).toBeCloseTo(ink.x, 0);
  expect(span.x + span.width).toBeGreaterThanOrEqual(ink.x + ink.width - 1);
  expect(span.x + span.width).toBeLessThanOrEqual(ink.x + ink.width + 12);
  expect(span.y).toBeLessThanOrEqual(ink.y + 1);
  expect(span.y + span.height).toBeGreaterThanOrEqual(ink.y + ink.height - 1);
});

test("textLayer_ShouldHaveJapaneseText_WhenFontNeedsCMapFiles", async ({ page }) => {
  const cMapStatuses: number[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/cmaps/")) {
      cMapStatuses.push(response.status());
    }
  });

  const viewer = await openViewer(page, { initialZoom: 1 }, "cjk-cmap");

  await expect(viewer.pageElement().locator(".textLayer")).toContainText("日本語");
  expect(cMapStatuses.length).toBeGreaterThan(0);
  expect(cMapStatuses.every((status) => status === 200)).toBe(true);
});
