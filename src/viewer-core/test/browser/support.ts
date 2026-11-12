import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PvEventMap } from "../../src/events.js";
import type { NewPageObject, PageObject } from "../../src/object-store.js";
import type { Rect } from "../../src/geometry.js";
import type { PdfViewerElement, ViewerOptions, ZoomSetting } from "../../src/viewer-element.js";

const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "tests", "fixtures");

export const manifest =
  JSON.parse(readFileSync(join(fixturesDirectory, "manifest.json"), "utf8")) as Record<string, Rect[]>;

/** Opens a fixture in a new viewer with the given options applied first. */
export async function openViewer(page: Page, options: ViewerOptions, fixture = "letter"): Promise<Viewer> {
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.host.evaluate((element: PdfViewerElement, value) => element.configure(value), options);
  await viewer.open(fixture);
  return viewer;
}

export function fixtureUrl(name: string): string {
  return `/tests/fixtures/${name}.pdf`;
}

/** Drives the viewer through its public element API and test contract only. */
export class Viewer {
  readonly host: Locator;

  constructor(readonly page: Page) {
    this.host = page.locator("pdf-viewer");
  }

  async goto(): Promise<void> {
    await this.page.goto("/test/browser/harness.html");
    await this.page.waitForFunction(() => (window as unknown as { viewerReady?: boolean }).viewerReady === true);
  }

  /** Fails the test if pdf.js could not use its worker, which it reports only as a console warning. */
  failOnFakeWorker(): void {
    this.page.on("console", (message) => {
      if (message.text().includes("fake worker")) {
        throw new Error(`pdf.js fell back to a fake worker: ${message.text()}`);
      }
    });
  }

  async open(fixture: string, initialPage = 1): Promise<void> {
    await this.host.evaluate((element: PdfViewerElement, [url, page]) => {
      void element.open({ kind: "url", url: url as string }, page as number);
    }, [fixtureUrl(fixture), initialPage] as const);
    await expect(this.host).toHaveAttribute("data-document-state", "ready");
    await this.waitForPage(initialPage);
  }

  pageElement(pageNumber = 1): Locator {
    return this.page.locator(`.pv-page[data-page-number="${pageNumber}"]`);
  }

  object(id: string): Locator {
    return this.page.locator(`[data-object-id="${id}"]`);
  }

  handle(name: string): Locator {
    return this.page.locator(`[data-handle="${name}"]`);
  }

  async waitForPage(pageNumber = 1): Promise<void> {
    const page = this.pageElement(pageNumber);
    await expect(page).toHaveAttribute("data-page-state", "rendered");
    await expect(page).toHaveAttribute("data-text-state", "ready");
  }

  async setZoom(zoom: ZoomSetting): Promise<void> {
    await this.host.evaluate((element: PdfViewerElement, value) => element.setZoom(value), zoom);
    await this.waitForPage(Number(await this.host.getAttribute("data-current-page")));
  }

  async setRotation(degrees: number): Promise<void> {
    await this.host.evaluate((element: PdfViewerElement, value) => element.setRotation(value), degrees);
    await this.waitForPage(Number(await this.host.getAttribute("data-current-page")));
  }

  async setTool(tool: "select" | "draw-rect" | "none"): Promise<void> {
    await this.host.evaluate((element: PdfViewerElement, value) => element.setTool(value), tool);
  }

  async addObject(object: NewPageObject): Promise<void> {
    await this.host.evaluate((element: PdfViewerElement, value) => void element.addObject(value), object);
  }

  async getObject(id: string): Promise<PageObject | undefined> {
    return this.host.evaluate((element: PdfViewerElement, value) => element.getObject(value), id);
  }

  async getObjects(): Promise<PageObject[]> {
    return this.host.evaluate((element: PdfViewerElement) => element.getObjects());
  }

  /** Records viewer events so a test can assert on them later. */
  async recordEvents<Type extends keyof PvEventMap>(type: Type): Promise<() => Promise<PvEventMap[Type][]>> {
    const key = `events_${type.replaceAll("-", "_")}`;
    await this.page.evaluate(([name, property]) => {
      const store = window as unknown as Record<string, unknown[]>;
      store[property!] = [];
      const host = document.querySelector("pdf-viewer")!;
      host.addEventListener(name!, (event) => store[property!]!.push((event as CustomEvent).detail));
    }, [type, key]);
    return () => this.page.evaluate((property) => (window as unknown as Record<string, unknown[]>)[property]!, key) as
      Promise<PvEventMap[Type][]>;
  }

  /** The screen position of a point given as a fraction of the displayed page. */
  async pagePoint(fractionX: number, fractionY: number, pageNumber = 1): Promise<{ x: number; y: number }> {
    const box = (await this.pageElement(pageNumber).boundingBox())!;
    return { x: box.x + box.width * fractionX, y: box.y + box.height * fractionY };
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 5): Promise<void> {
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, { steps });
    await this.page.mouse.up();
  }

  async center(locator: Locator): Promise<{ x: number; y: number }> {
    const box = (await locator.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /**
   * Finds the rendered red ink's bounds in CSS pixels, relative to the page element, by reading canvas pixels. This
   * is independent of the object layer, so comparing the two tests the coordinate transforms against real rendering.
   */
  async inkBounds(pageNumber = 1): Promise<Rect> {
    return this.pageElement(pageNumber).evaluate((page) => {
      const canvas = page.querySelector("canvas")!;
      const { data, width, height } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          if (data[offset]! > 200 && data[offset + 1]! < 60 && data[offset + 2]! < 60) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      }
      const bounds = canvas.getBoundingClientRect();
      const scaleX = bounds.width / width;
      const scaleY = bounds.height / height;
      const inkWidth = (right - left + 1) * scaleX;
      const inkHeight = (bottom - top + 1) * scaleY;
      return { x: left * scaleX, y: top * scaleY, width: inkWidth, height: inkHeight };
    });
  }

  /** An element's bounds in CSS pixels, relative to the page element. */
  async boundsOnPage(locator: Locator, pageNumber = 1): Promise<Rect> {
    const page = (await this.pageElement(pageNumber).boundingBox())!;
    const box = (await locator.boundingBox())!;
    return { x: box.x - page.x, y: box.y - page.y, width: box.width, height: box.height };
  }
}

/** Compares each edge, since anti-aliasing at both edges can add up to more than the tolerance on a size. */
export function expectRectsClose(actual: Rect, expected: Rect, tolerance: number): void {
  const edges = ({ x, y, width, height }: Rect) => ({ left: x, top: y, right: x + width, bottom: y + height });
  const actualEdges = edges(actual);
  const expectedEdges = edges(expected);
  for (const edge of ["left", "top", "right", "bottom"] as const) {
    const message = `${edge}: ${actualEdges[edge]} vs ${expectedEdges[edge]}`;
    expect(Math.abs(actualEdges[edge] - expectedEdges[edge]), message).toBeLessThanOrEqual(tolerance);
  }
}

export function parseRect(value: string | null): Rect {
  const [x, y, width, height] = (value ?? "").split(",").map(Number) as [number, number, number, number];
  return { x, y, width, height };
}
