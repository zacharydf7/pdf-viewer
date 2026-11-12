import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { NewPageObject } from "../../src/object-store.js";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { fixtureUrl, openViewer, Viewer } from "./support.js";

// Timings are taken inside the page, so Playwright's round trips don't count. Each budget is several times what the
// action took when written, which leaves room for a slow or busy machine, while a change in how the cost grows with
// the number of objects still fails. Interactions are measured up to a forced layout rather than the next frame,
// because waiting for a frame adds up to a frame's worth of idle time that isn't the viewer's work.

/**
 * An interaction's own script time, and its total once the layout it leaves behind is included. Layout dominates the
 * total, so the script time gets a tight budget of its own, or extra script work would hide inside the total's margin.
 */
interface Timing {
  script: number;
  total: number;
}

interface PerformanceHelpers {
  /** Objects spread evenly over a letter-sized page, with ids from "object-<firstIndex>" onward (by default 0). */
  grid(count: number, page: number, firstIndex?: number): NewPageObject[];
  /** Brings style and layout up to date, so their cost counts toward the measured action. */
  layout(): void;
  /** Resolves after the next frame has painted. */
  nextFrame(): Promise<void>;
  /** Timings that listeners collect during a gesture. */
  samples: Timing[];
}

declare global {
  interface Window {
    // Optional: only this spec's pages set it, but the global declaration applies to every file in the project.
    perf?: PerformanceHelpers;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.perf = {
      grid(count, page, firstIndex = 0) {
        const columns = Math.ceil(Math.sqrt(count));
        const width = 612 / columns;
        const height = 792 / columns;
        return Array.from({ length: count }, (_, index) => {
          const x = (index % columns) * width;
          const y = Math.floor(index / columns) * height;
          return { id: `object-${firstIndex + index}`, page, rect: { x, y, width: width / 2, height: height / 2 } };
        });
      },
      layout() {
        document.querySelector("pdf-viewer")!.getBoundingClientRect();
      },
      nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      },
      samples: [],
    };
  });
});

function expectWithinBudget(measured: number, budget: number, part = ""): void {
  console.log(`${test.info().title}${part}: ${measured.toFixed(1)} ms, budget ${budget} ms`);
  expect(measured).toBeLessThanOrEqual(budget);
}

function expectTimingsWithinBudget(timings: Timing[], scriptBudget: number, totalBudget: number): void {
  expectWithinBudget(median(timings.map((timing) => timing.script)), scriptBudget, " (script)");
  expectWithinBudget(median(timings.map((timing) => timing.total)), totalBudget, " (total)");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function openWithObjects(page: Page, count: number): Promise<Viewer> {
  const viewer = await openViewer(page, { initialZoom: 1 });
  await viewer.host.evaluate(async (element: PdfViewerElement, value) => {
    element.setObjects(window.perf!.grid(value, 1));
    await window.perf!.nextFrame();
  }, count);
  return viewer;
}

test("open_ShouldShowFirstPageWithinBudget_WhenViewerIsNew", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();

  const time = await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
    const start = performance.now();
    await element.open({ kind: "url", url });
    return performance.now() - start;
  }, fixtureUrl("letter"));

  await expect(viewer.pageElement()).toHaveAttribute("data-page-state", "rendered");
  expectWithinBudget(time, 500);
});

for (const [count, budget] of [[1_000, 60], [5_000, 250], [10_000, 450]] as const) {
  test(`setObjects_ShouldPaintWithinBudget_WhenGiven${count}Objects`, async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    const time = await viewer.host.evaluate(async (element: PdfViewerElement, value) => {
      const objects = window.perf!.grid(value, 1);
      const start = performance.now();
      element.setObjects(objects);
      await window.perf!.nextFrame();
      return performance.now() - start;
    }, count);

    await expect(viewer.pageElement()).toHaveAttribute("data-object-count", String(count));
    expectWithinBudget(time, budget);
  });
}

test("addObject_ShouldPaintWithinBudget_WhenAdding1000ObjectsOneAtATime", async ({ page }) => {
  const viewer = await openWithObjects(page, 5_000);

  const time = await viewer.host.evaluate(async (element: PdfViewerElement) => {
    const objects = window.perf!.grid(1_000, 1, 5_000);
    const start = performance.now();
    objects.forEach((object) => element.addObject(object));
    await window.perf!.nextFrame();
    return performance.now() - start;
  });

  await expect(viewer.pageElement()).toHaveAttribute("data-object-count", "6000");
  expectWithinBudget(time, 100);
});

test("selectObject_ShouldStayWithinBudget_WhenPageHas5000Objects", async ({ page }) => {
  const viewer = await openWithObjects(page, 5_000);

  const samples = await viewer.host.evaluate((element: PdfViewerElement) => Array.from({ length: 50 }, (_, index) => {
    const start = performance.now();
    element.selectObject(`object-${index * 100}`);
    window.perf!.layout();
    return performance.now() - start;
  }));

  await expect(viewer.object("object-4900")).toHaveAttribute("aria-selected", "true");
  expectWithinBudget(median(samples), 1);
});

test("updateObject_ShouldStayWithinBudget_WhenPageHas5000Objects", async ({ page }) => {
  const viewer = await openWithObjects(page, 5_000);

  const samples = await viewer.host.evaluate((element: PdfViewerElement) => Array.from({ length: 50 }, (_, index) => {
    const start = performance.now();
    element.updateObject(`object-${index * 100}`, { rect: { x: index, y: index, width: 20, height: 20 } });
    const script = performance.now() - start;
    window.perf!.layout();
    return { script, total: performance.now() - start };
  }));

  await expect(viewer.object("object-4900")).toHaveAttribute("data-page-rect", "49,49,20,20");
  expectTimingsWithinBudget(samples, 0.5, 10);
});

test("drag_ShouldStayWithinBudgetPerMove_WhenPageHas5000Objects", async ({ page }) => {
  const viewer = await openWithObjects(page, 5_000);
  // Each move's script time is measured from the window's capturing listener, which runs first, to its bubbling
  // listener, which runs last.
  await page.evaluate(() => {
    let start = 0;
    window.addEventListener("pointermove", () => start = performance.now(), { capture: true });
    window.addEventListener("pointermove", () => {
      const script = performance.now() - start;
      window.perf!.layout();
      window.perf!.samples.push({ script, total: performance.now() - start });
    });
  });
  const from = await viewer.center(viewer.object("object-0"));

  await viewer.drag(from, { x: from.x + 200, y: from.y + 150 }, 40);

  const samples = await page.evaluate(() => window.perf!.samples);
  expect(samples.length).toBeGreaterThanOrEqual(40);
  await expect(viewer.object("object-0")).not.toHaveAttribute("data-page-rect", /^0,0,/);
  expectTimingsWithinBudget(samples, 1, 10);
});

test("setZoom_ShouldRepaintWithinBudget_WhenPageHas5000Objects", async ({ page }) => {
  const viewer = await openWithObjects(page, 5_000);

  const time = await viewer.host.evaluate(async (element: PdfViewerElement) => {
    const start = performance.now();
    await element.setZoom(2);
    await window.perf!.nextFrame();
    return performance.now() - start;
  });

  await expect(viewer.pageElement()).toHaveAttribute("data-render-scale", "2");
  expectWithinBudget(time, 250);
});

test("goToPage_ShouldShowPageWithinBudget_WhenPagesHave5000ObjectsEach", async ({ page }) => {
  const viewer = await openWithObjects(page, 5_000);
  await viewer.host.evaluate((element: PdfViewerElement) => {
    window.perf!.grid(5_000, 2, 5_000).forEach((object) => element.addObject(object));
  });

  const time = await viewer.host.evaluate(async (element: PdfViewerElement) => {
    const start = performance.now();
    await element.goToPage(2);
    await window.perf!.nextFrame();
    return performance.now() - start;
  });

  await expect(viewer.pageElement(2)).toHaveAttribute("data-object-count", "5000");
  expectWithinBudget(time, 250);
});
