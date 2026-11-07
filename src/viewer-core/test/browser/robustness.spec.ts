import { expect, test, type Page } from "@playwright/test";
import type { PageObject } from "../../src/object-store.js";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { fixtureUrl, openViewer, Viewer } from "./support.js";

const rect = { x: 100, y: 100, width: 200, height: 100 };

test.describe("commands that overlap", () => {
  test("goToPage_ShouldStillNavigate_WhenZoomChangesWhilePageLoads", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    await viewer.host.evaluate(async (element: PdfViewerElement) => {
      const navigating = element.goToPage(2);
      await element.setZoom(2);
      await navigating;
    });

    await expect(viewer.host).toHaveAttribute("data-current-page", "2");
    await viewer.waitForPage(2);
    await expect(viewer.pageElement(2)).toHaveAttribute("data-render-scale", "2");
  });

  test("goToPage_ShouldShowLastRequestedPage_WhenCalledRepeatedly", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    await viewer.host.evaluate(async (element: PdfViewerElement) => {
      await Promise.all([element.goToPage(2), element.goToPage(3), element.goToPage(2)]);
    });

    await viewer.waitForPage(2);
    await expect(viewer.pageElement(3)).toHaveCount(0);
  });

  test("close_ShouldDiscardFile_WhenReadFinishesAfterwards", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
      const bytes = await (await fetch(url)).arrayBuffer();
      const file = new Blob([bytes]);
      let finishRead = () => {};
      const readStarted = new Promise<void>((started) => {
        file.arrayBuffer = () => new Promise((resolve) => {
          finishRead = () => resolve(bytes);
          started();
        });
      });
      const opening = element.open({ kind: "file", file });
      await readStarted;
      await element.close();
      finishRead();
      await opening;
    }, fixtureUrl("letter"));

    await expect(viewer.host).toHaveAttribute("data-document-state", "idle");
    await expect(page.locator(".pv-page")).toHaveCount(0);
  });

  test("open_ShouldKeepLaterFile_WhenEarlierFileFinishesReadingLast", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    await viewer.host.evaluate(async (element: PdfViewerElement, [slowUrl, fastUrl]) => {
      const slowBytes = await (await fetch(slowUrl!)).arrayBuffer();
      const fastBytes = await (await fetch(fastUrl!)).arrayBuffer();
      const slowFile = new Blob([slowBytes]);
      let finishSlowRead = () => {};
      const readStarted = new Promise<void>((started) => {
        slowFile.arrayBuffer = () => new Promise((resolve) => {
          finishSlowRead = () => resolve(slowBytes);
          started();
        });
      });
      const opening = element.open({ kind: "file", file: slowFile });
      await readStarted;
      await element.open({ kind: "file", file: new Blob([fastBytes]) });
      finishSlowRead();
      await opening;
    }, [fixtureUrl("letter"), fixtureUrl("a4")]);

    await expect(viewer.host).toHaveAttribute("data-document-state", "ready");
    await expect(viewer.host).toHaveAttribute("data-page-count", "1");
  });

  test("close_ShouldEndIdle_WhenCalledRightAfterOpen", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.open("letter");

    await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
      const opening = element.open({ kind: "url", url });
      await Promise.all([opening, element.close()]);
    }, fixtureUrl("a4"));

    await expect(viewer.host).toHaveAttribute("data-document-state", "idle");
    await expect(page.locator(".pv-page")).toHaveCount(0);
  });

  test("open_ShouldEndReady_WhenCalledRightAfterClose", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.open("letter");

    await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
      await Promise.all([element.close(), element.open({ kind: "url", url })]);
    }, fixtureUrl("a4"));

    await expect(viewer.host).toHaveAttribute("data-document-state", "ready");
    await expect(viewer.host).toHaveAttribute("data-page-count", "1");
  });
});

test.describe("state during transitions", () => {
  test("open_ShouldReportLoadingAtOnce_WhenReplacingDocument", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    const state = await viewer.host.evaluate((element: PdfViewerElement, url) => {
      void element.open({ kind: "url", url });
      return element.dataset.documentState;
    }, fixtureUrl("a4"));

    expect(state).toBe("loading");
    await viewer.waitForPage();
  });

  test("close_ShouldReportIdleAtOnce_WhenDocumentIsOpen", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    const state = await viewer.host.evaluate((element: PdfViewerElement) => {
      void element.close();
      return element.dataset.documentState;
    });

    expect(state).toBe("idle");
  });
});

test.describe("bad zoom", () => {
  test("configure_ShouldIgnoreInitialZoom_WhenValueIsNotFinite", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: Number.NaN });

    expect((await viewer.pageElement().boundingBox())!.width).toBeGreaterThan(100);
  });

  test("configure_ShouldKeepInitialZoomInLimits_WhenValueIsTooLarge", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 50 });

    await expect(viewer.host).toHaveAttribute("data-zoom", "10");
  });

  test("setZoom_ShouldBeIgnored_WhenValueIsNotFinite", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    await viewer.host.evaluate((element: PdfViewerElement) => element.setZoom(Number.NaN));

    await expect(viewer.host).toHaveAttribute("data-zoom", "1");
    await viewer.setZoom(1.5);
    await expect(viewer.pageElement()).toHaveAttribute("data-render-scale", "1.5");
  });

  test("setZoom_ShouldNotBreakNextDocument_WhenGivenNaNBeforeAnyPage", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    await viewer.host.evaluate((element: PdfViewerElement) => element.setZoom(Number.NaN));
    await viewer.open("letter");

    expect((await viewer.pageElement().boundingBox())!.width).toBeGreaterThan(100);
  });
});

test.describe("failures after opening", () => {
  test("goToPage_ShouldReportErrorAndKeepPage_WhenPageCannotLoad", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    const errors = await viewer.recordEvents("pv-error");

    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(Number.NaN));

    await expect.poll(errors).toHaveLength(1);
    expect((await errors())[0]).toMatchObject({ code: "page", documentFailed: false });
    await expect(viewer.host).toHaveAttribute("data-document-state", "ready");
    await expect(viewer.pageElement(1)).toHaveAttribute("data-page-state", "rendered");
  });

  test("open_ShouldFailDocument_WhenFirstPageCannotLoad", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    const errors = await viewer.recordEvents("pv-error");

    await viewer.host.evaluate((element: PdfViewerElement, url) => {
      void element.open({ kind: "url", url }, Number.NaN);
    }, fixtureUrl("letter"));

    await expect(viewer.host).toHaveAttribute("data-document-state", "error");
    expect((await errors())[0]).toMatchObject({ documentFailed: true });
    await expect(viewer.host).not.toHaveAttribute("data-page-count");
    expect(await viewer.host.evaluate((element: PdfViewerElement) => element.currentPage)).toBe(0);
  });

  test("open_ShouldSucceed_WhenStylesFailedToLoadEarlier", async ({ page }) => {
    const viewer = new Viewer(page);
    await page.route("**/pv.css", (route) => route.abort());
    await viewer.goto();
    await viewer.host.evaluate((element: PdfViewerElement, url) => {
      void element.open({ kind: "url", url });
    }, fixtureUrl("letter"));
    await expect(viewer.host).toHaveAttribute("data-document-state", "error");

    await page.unroute("**/pv.css");
    await viewer.open("letter");

    await expect(viewer.host).toHaveAttribute("data-page-count", "3");
  });

  test("open_ShouldReportNetworkError_WhenConnectionIsRefused", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await page.route("**/letter.pdf", (route) => route.abort("connectionrefused"));

    await viewer.host.evaluate((element: PdfViewerElement, url) => {
      void element.open({ kind: "url", url });
    }, fixtureUrl("letter"));

    await expect(viewer.host).toHaveAttribute("data-document-state", "error");
    await expect(viewer.host).toHaveAttribute("data-error-code", "network");
  });

  test("open_ShouldFailDocument_WhenFileCannotBeRead", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    const errors = await viewer.recordEvents("pv-error");

    await viewer.host.evaluate((element: PdfViewerElement) => {
      const file = new Blob(["unused"]);
      file.arrayBuffer = () => Promise.reject(new Error("The file was deleted."));
      void element.open({ kind: "file", file });
    });

    await expect(viewer.host).toHaveAttribute("data-document-state", "error");
    expect((await errors())[0]).toMatchObject({ message: "The file was deleted.", documentFailed: true });
  });

  test("errorCode_ShouldClear_WhenGoodDocumentFollowsBadOne", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await viewer.host.evaluate((element: PdfViewerElement) => {
      void element.open({ kind: "data", data: new TextEncoder().encode("not a pdf") });
    });
    await expect(viewer.host).toHaveAttribute("data-error-code", "invalid-pdf");

    await viewer.open("letter");

    await expect(viewer.host).not.toHaveAttribute("data-error-code");
  });
});

test.describe("removing an object during its own drag", () => {
  async function pressAndMove(viewer: Viewer): Promise<{ x: number; y: number }> {
    const from = await viewer.center(viewer.object("a"));
    await viewer.page.mouse.move(from.x, from.y);
    await viewer.page.mouse.down();
    await viewer.page.mouse.move(from.x + 20, from.y + 20);
    return { x: from.x + 40, y: from.y + 40 };
  }

  test("drag_ShouldEndWithoutErrors_WhenObjectIsRemovedByCode", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });
    await viewer.addObject({ id: "b", page: 1, rect: { x: 400, y: 400, width: 100, height: 100 } });

    const next = await pressAndMove(viewer);
    await viewer.host.evaluate((element: PdfViewerElement) => element.removeObject("a"));
    await page.mouse.move(next.x, next.y);
    await page.mouse.up();

    await expect(viewer.object("a")).toHaveCount(0);
    const other = await viewer.center(viewer.object("b"));
    await viewer.drag(other, { x: other.x + 10, y: other.y });
    await expect(viewer.object("b")).toHaveAttribute("data-page-rect", "410,400,100,100");
    expect(pageErrors).toEqual([]);
  });

  test("deleteKey_ShouldBeIgnored_WhenPressedDuringDrag", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });

    const next = await pressAndMove(viewer);
    await page.keyboard.press("Delete");
    await page.mouse.move(next.x, next.y);
    await page.mouse.up();

    await expect(viewer.object("a")).toHaveAttribute("data-page-rect", "140,140,200,100");
    expect(pageErrors).toEqual([]);
  });
});

test.describe("layout", () => {
  test("viewer_ShouldShowPage_WhenParentHasNoHeight", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    await page.evaluate(() => {
      const parent = document.createElement("div");
      parent.id = "auto-height";
      document.body.replaceChildren(parent);
      parent.append(document.createElement("pdf-viewer"));
    });
    const host = page.locator("#auto-height pdf-viewer");

    await host.evaluate((element: PdfViewerElement, url) => {
      element.style.height = "auto";
      void element.open({ kind: "url", url });
    }, fixtureUrl("letter"));

    await expect(host.locator(".pv-page")).toHaveAttribute("data-page-state", "rendered");
    expect((await host.boundingBox())!.height).toBeGreaterThanOrEqual(300);
    expect((await host.locator(".pv-page").boundingBox())!.width).toBeGreaterThan(100);
  });

  test("viewer_ShouldFitWidth_WhenViewportHasWidthButNoHeight", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    await viewer.host.evaluate((element: PdfViewerElement, url) => {
      element.style.minHeight = "0";
      element.style.height = "0";
      void element.open({ kind: "url", url });
    }, fixtureUrl("letter"));

    await expect(viewer.pageElement()).toHaveAttribute("data-page-state", "rendered");
  });
});

test.describe("lifecycle attributes", () => {
  test("host_ShouldReportEmptyState_WhenNothingHasHappened", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    await expect(viewer.host).toHaveAttribute("data-document-state", "idle");
    await expect(viewer.host).toHaveAttribute("data-selected-object", "");
    await expect(viewer.host).toHaveAttribute("data-last-change", "0");
    await expect(viewer.host).not.toHaveAttribute("data-zoom");
  });

  test("close_ShouldForgetObjectsAndZoomAttribute_WhenDocumentHadThem", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("a"));

    await viewer.host.evaluate((element: PdfViewerElement) => element.close());

    expect(await viewer.getObjects()).toEqual([]);
    await expect(viewer.host).toHaveAttribute("data-selected-object", "");
    await expect(viewer.host).not.toHaveAttribute("data-zoom");
    expect(await viewer.host.evaluate((element: PdfViewerElement) => element.currentPage)).toBe(0);
  });

  test("addObject_ShouldAcceptReusedId_WhenDocumentWasReplaced", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });

    await viewer.open("a4");
    await viewer.addObject({ id: "a", page: 1, rect });

    await expect(viewer.object("a")).toHaveCount(1);
  });

  test("currentPage_ShouldBeNewPage_WhenDocumentLoadedEventFires", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(3));
    await viewer.waitForPage(3);

    const [pageAtLoad, changes] = await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
      let seen = -1;
      const pages: number[] = [];
      element.addEventListener("pv-document-loaded", () => { seen = element.currentPage; });
      element.addEventListener("pv-page-change", (event) => pages.push((event as CustomEvent).detail.page));
      await element.open({ kind: "url", url });
      return [seen, pages] as const;
    }, fixtureUrl("a4"));

    expect(pageAtLoad).toBe(1);
    expect(changes).toEqual([1]);
  });
});

test.describe("listeners of the document loaded event", () => {
  test("goToPage_ShouldWin_WhenCalledFromListener", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    await viewer.host.evaluate((element: PdfViewerElement, url) => {
      element.addEventListener("pv-document-loaded", () => void element.goToPage(3), { once: true });
      void element.open({ kind: "url", url });
    }, fixtureUrl("letter"));

    await viewer.waitForPage(3);
    await expect(viewer.host).toHaveAttribute("data-current-page", "3");
  });

  test("close_ShouldReportNoError_WhenCalledFromListener", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();
    const errors = await viewer.recordEvents("pv-error");

    await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
      element.addEventListener("pv-document-loaded", () => void element.close(), { once: true });
      await element.open({ kind: "url", url });
    }, fixtureUrl("letter"));

    await expect(viewer.host).toHaveAttribute("data-document-state", "idle");
    expect(await errors()).toEqual([]);
  });
});

test.describe("handles", () => {
  test("handles_ShouldHide_WhenSelectedObjectStopsBeingSelectable", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect });
    await viewer.host.evaluate((element: PdfViewerElement) => element.selectObject("a"));
    await expect(page.locator("[data-handle]")).toHaveCount(8);

    await viewer.host.evaluate((element: PdfViewerElement) => { element.updateObject("a", { selectable: false }); });

    await expect(page.locator("[data-handle]")).toHaveCount(0);
  });
});

test.describe("Blazor bridge", () => {
  /** Attaches with the given subscriptions, adds and selects an object, and returns the .NET methods called. */
  async function notifiedMethods(page: Page, subscriptions: { objects: boolean; selection: boolean }) {
    const viewer = await openViewer(page, { initialZoom: 1 });
    return viewer.host.evaluate(async (element: PdfViewerElement, { value, flags }) => {
      const { attach } = await import("/dist/pv.js" as string) as typeof import("../../src/index.js");
      const calls: string[] = [];
      const dotNet = { invokeMethodAsync: (method: string) => { calls.push(method); return Promise.resolve(); } };
      attach(element, dotNet, {}, flags);
      element.addObject({ id: "a", page: 1, rect: value });
      element.selectObject("a");
      return calls;
    }, { value: rect, flags: subscriptions });
  }

  test("notifications_ShouldNotReachDotNet_WhenItHasNoHandlers", async ({ page }) => {
    expect(await notifiedMethods(page, { objects: false, selection: false })).toEqual([]);
  });

  test("notifications_ShouldReachDotNetOnlyForHandledKinds_WhenSomeHaveHandlers", async ({ page }) => {
    expect(await notifiedMethods(page, { objects: true, selection: false })).toEqual(["NotifyObjectChanged"]);
  });

  test("updateObject_ShouldClearValues_WhenDotNetLeavesThemOut", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    await viewer.addObject({ id: "a", page: 1, rect, tag: "heading", label: "Region", style: { color: "red" } });

    const updated = await viewer.host.evaluate(async (element: PdfViewerElement, value) => {
      const { attach } = await import("/dist/pv.js" as string) as typeof import("../../src/index.js");
      const bridge = attach(element, { invokeMethodAsync: () => Promise.resolve() }, {},
        { objects: true, selection: true });
      return bridge.updateObject(value as PageObject);
    }, { id: "a", page: 1, rect, kind: "rect", locked: false, selectable: true });

    expect(updated.tag).toBeUndefined();
    expect(updated.label).toBeUndefined();
    expect(updated.style).toBeUndefined();
    await expect(viewer.object("a")).not.toHaveAttribute("data-object-tag");
  });

  test("open_ShouldCloseDocument_WhenFileInputHasNoFile", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });

    await viewer.host.evaluate(async (element: PdfViewerElement) => {
      const { attach } = await import("/dist/pv.js" as string) as typeof import("../../src/index.js");
      const bridge = attach(element, { invokeMethodAsync: () => Promise.resolve() }, {},
        { objects: true, selection: true });
      bridge.open({ kind: "file-input", input: document.createElement("input") }, 1);
    });

    await expect(viewer.host).toHaveAttribute("data-document-state", "idle");
  });

  test("zoomBy_ShouldDoNothing_WhenNoPageHasBeenSized", async ({ page }) => {
    const viewer = new Viewer(page);
    await viewer.goto();

    await viewer.host.evaluate(async (element: PdfViewerElement) => {
      const { attach } = await import("/dist/pv.js" as string) as typeof import("../../src/index.js");
      attach(element, { invokeMethodAsync: () => Promise.resolve() }, {},
        { objects: true, selection: true }).zoomBy(1.25);
    });
    await viewer.open("letter");

    expect((await viewer.pageElement().boundingBox())!.width).toBeGreaterThan(100);
  });

  test("failedCommand_ShouldRaiseError_WhenSentFromDotNet", async ({ page }) => {
    const viewer = await openViewer(page, { initialZoom: 1 });
    const errors = await viewer.recordEvents("pv-error");

    await viewer.host.evaluate(async (element: PdfViewerElement) => {
      const { attach } = await import("/dist/pv.js" as string) as typeof import("../../src/index.js");
      attach(element, { invokeMethodAsync: () => Promise.resolve() }, {},
        { objects: true, selection: true }).setRotation(45);
    });

    await expect.poll(errors).toHaveLength(1);
    expect((await errors())[0]).toMatchObject({ code: "command", documentFailed: false });
  });
});
