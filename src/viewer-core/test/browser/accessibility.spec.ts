import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { openViewer, Viewer } from "./support.js";

/** The viewer's serious and critical violations, each with the elements it was found on. */
async function seriousViolations(page: Page): Promise<string[]> {
  // Only the viewer, since the test harness page around it isn't what's being checked.
  const results = await new AxeBuilder({ page }).include("pdf-viewer").analyze();
  return results.violations
    .filter(({ impact }) => impact === "serious" || impact === "critical")
    .map(({ id, help, nodes }) => `${id}: ${help} (${nodes.map(({ target }) => target.join(" ")).join(", ")})`);
}

test("viewer_ShouldHaveNoSeriousAccessibilityViolations_WhenShowingPageWithObjects", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 });
  await viewer.host.evaluate((element: PdfViewerElement) => {
    element.setObjects([
      { id: "heading", page: 1, rect: { x: 100, y: 100, width: 200, height: 40 }, label: "Heading" },
      { id: "figure", page: 1, rect: { x: 100, y: 200, width: 300, height: 200 } },
      { id: "footer", page: 1, rect: { x: 100, y: 700, width: 400, height: 30 }, locked: true },
    ]);
    element.selectObject("figure");
  });
  await expect(viewer.object("figure")).toHaveAttribute("aria-selected", "true");

  expect(await seriousViolations(page)).toEqual([]);
});

test("viewer_ShouldHaveNoSeriousAccessibilityViolations_WhenPageHasNoObjects", async ({ page }) => {
  await openViewer(page, { initialZoom: 1 });

  expect(await seriousViolations(page)).toEqual([]);
});

test("viewer_ShouldHaveNoSeriousAccessibilityViolations_WhenLastObjectIsRemoved", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 });
  await viewer.addObject({ id: "only", page: 1, rect: { x: 100, y: 100, width: 200, height: 40 } });
  await viewer.host.evaluate((element: PdfViewerElement) => element.setObjects([]));
  await expect(viewer.object("only")).toHaveCount(0);

  expect(await seriousViolations(page)).toEqual([]);
});

test("viewer_ShouldHaveNoSeriousAccessibilityViolations_WhenZoomedSoPageScrolls", async ({ page }) => {
  await openViewer(page, { initialZoom: 3 });
  const scrolls = await page.locator(".pv-viewport")
    .evaluate((element) => element.scrollHeight > element.clientHeight);

  expect(scrolls).toBe(true);
  expect(await seriousViolations(page)).toEqual([]);
});

test("viewer_ShouldHaveNoSeriousAccessibilityViolations_WhenNoDocumentIsOpen", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();

  expect(await seriousViolations(page)).toEqual([]);
});
