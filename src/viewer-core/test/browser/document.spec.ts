import { expect, test } from "@playwright/test";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { expectRectsClose, fixtureUrl, manifest, openViewer, Viewer } from "./support.js";

test("open_ShouldUseRealWorkerAndReportPageCount_WhenGivenValidDocument", async ({ page }) => {
  const viewer = new Viewer(page);
  viewer.failOnFakeWorker();
  await viewer.goto();
  const events = await viewer.recordEvents("pv-document-loaded");

  await viewer.open("letter");

  await expect(viewer.host).toHaveAttribute("data-page-count", "3");
  expect(await events()).toEqual([{ pageCount: 3, pageLabels: null }]);
});

test("open_ShouldReportPageLabels_WhenDocumentDefinesThem", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  const events = await viewer.recordEvents("pv-document-loaded");

  await viewer.open("page-labels");

  expect(await events()).toEqual([{ pageCount: 3, pageLabels: ["i", "ii", "iii"] }]);
});

test("getPageInfo_ShouldReportUnrotatedSizeAndRotation_WhenPageIsNotDisplayed", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 }, "mixed-sizes");

  const info = await viewer.host.evaluate((element: PdfViewerElement) => element.getPageInfo(3));

  expect(info).toEqual({ page: 3, label: null, width: 400, height: 500, rotation: 90 });
  await expect(viewer.host).toHaveAttribute("data-current-page", "1");
});

test("getPageInfo_ShouldReportSizeAsDisplayed_WhenCoordinatesAreDisplay", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1, coordinates: "display" }, "mixed-sizes");

  const info = await viewer.host.evaluate((element: PdfViewerElement) => element.getPageInfo(3));

  expect(info).toEqual({ page: 3, label: null, width: 500, height: 400, rotation: 90 });
});

test("getPageInfo_ShouldReportPageLabel_WhenDocumentDefinesLabels", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 }, "page-labels");

  const info = await viewer.host.evaluate((element: PdfViewerElement) => element.getPageInfo(2));

  expect(info.label).toBe("ii");
});

test("getPageInfo_ShouldKeepPageLabel_WhenListenerTriesToChangeReportedLabels", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.host.evaluate((element: PdfViewerElement) => {
    element.addEventListener("pv-document-loaded", ({ detail }) => {
      try {
        (detail.pageLabels as string[]).reverse();
      } catch {
        // A frozen array throws here, which is what keeps the labels intact.
      }
    });
  });

  await viewer.open("page-labels");
  const info = await viewer.host.evaluate((element: PdfViewerElement) => element.getPageInfo(1));

  expect(info.label).toBe("i");
});

test("getPageInfo_ShouldReject_WhenPageIsBeyondEnd", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 });

  const message = await viewer.host.evaluate((element: PdfViewerElement) =>
    element.getPageInfo(4).then(() => "resolved", (error: Error) => error.message));

  expect(message).toContain("from 1 to 3");
});

test("open_ShouldShowInitialPage_WhenGiven", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();

  await viewer.open("letter", 2);

  await expect(viewer.host).toHaveAttribute("data-current-page", "2");
  await expect(viewer.pageElement(2).locator(".textLayer")).toContainText("Page 2 sample text");
});

test("open_ShouldUseRangeRequests_WhenServerSupportsThem", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith("range-large.pdf")) {
      statuses.push(response.status());
    }
  });

  await viewer.open("range-large");

  expect(statuses).toContain(206);
});

test("open_ShouldReportInvalidPdf_WhenGivenNonPdfData", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  const events = await viewer.recordEvents("pv-error");

  await viewer.host.evaluate((element: PdfViewerElement) => {
    void element.open({ kind: "data", data: new TextEncoder().encode("this is not a pdf") });
  });

  await expect(viewer.host).toHaveAttribute("data-document-state", "error");
  await expect(viewer.host).toHaveAttribute("data-error-code", "invalid-pdf");
  expect(await events()).toHaveLength(1);
});

test("open_ShouldReportNetworkError_WhenDocumentIsMissing", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();

  await viewer.host.evaluate((element: PdfViewerElement) => void element.open({ kind: "url", url: "/missing.pdf" }));

  await expect(viewer.host).toHaveAttribute("data-document-state", "error");
  await expect(viewer.host).toHaveAttribute("data-error-code", "network");
});

test("open_ShouldReportPasswordRequired_WhenDocumentHasUserPassword", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();

  await viewer.host.evaluate((element: PdfViewerElement, url) => void element.open({ kind: "url", url }),
    fixtureUrl("encrypted-user"));

  await expect(viewer.host).toHaveAttribute("data-document-state", "error");
  await expect(viewer.host).toHaveAttribute("data-error-code", "password-required");
});

test("open_ShouldShowDecryptedPage_WhenDocumentHasOnlyOwnerPassword", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 }, "encrypted-owner");

  await expect(viewer.pageElement().locator(".textLayer")).toContainText("Page 1 sample text");
  expectRectsClose(await viewer.inkBounds(), manifest["encrypted-owner"]![0]!, 1);
});

test("open_ShouldKeepOnlyLatestDocument_WhenCalledRapidly", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  const events = await viewer.recordEvents("pv-document-loaded");

  await viewer.host.evaluate(async (element: PdfViewerElement, urls) => {
    await Promise.all(urls.map((url) => element.open({ kind: "url", url })));
  }, [fixtureUrl("a4"), fixtureUrl("rotate-90"), fixtureUrl("mixed-sizes"), fixtureUrl("letter")]);

  await expect(viewer.host).toHaveAttribute("data-page-count", "3");
  await expect(viewer.pageElement(1)).toHaveAttribute("data-page-width", "612");
  await viewer.waitForPage();
  expect(await events()).toEqual([{ pageCount: 3, pageLabels: null }]);
});

test("open_ShouldStartAtFirstPageWithNoObjects_WhenReplacingDocumentWithShorterOne", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.open("letter", 3);
  await viewer.addObject({ id: "a", page: 3, rect: { x: 1, y: 1, width: 5, height: 5 } });

  await viewer.open("a4");

  await expect(viewer.host).toHaveAttribute("data-current-page", "1");
  expect(await viewer.getObjects()).toEqual([]);
});

test("goToPage_ShouldClampAndReportChange_WhenGivenPageBeyondEnd", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.open("letter");
  const events = await viewer.recordEvents("pv-page-change");

  await viewer.host.evaluate((element: PdfViewerElement) => element.goToPage(99));
  await viewer.waitForPage(3);

  expect(await events()).toEqual([{ page: 3 }]);
});

test("removal_ShouldReturnToIdle_WhenElementLeavesDocument", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.open("letter");

  // A removed element can't be found by a locator, so wait from inside the page. Teardown includes stopping the worker.
  await viewer.host.evaluate(async (element: PdfViewerElement) => {
    element.remove();
    while (element.dataset.documentState !== "idle") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  expect(await page.locator(".pv-page").count()).toBe(0);
});

test("close_ShouldLeaveNoWorkerOrPage_WhenDocumentsWereOpenedRepeatedly", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { liveWorkers: number };
    state.liveWorkers = 0;
    window.Worker = class extends Worker {
      constructor(...parameters: ConstructorParameters<typeof Worker>) {
        super(...parameters);
        state.liveWorkers++;
      }

      override terminate(): void {
        state.liveWorkers--;
        super.terminate();
      }
    };
  });
  const liveWorkers = () => page.evaluate(() => (window as unknown as { liveWorkers: number }).liveWorkers);
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.open("letter");
  expect(await liveWorkers()).toBe(1);

  await viewer.host.evaluate(async (element: PdfViewerElement, url) => {
    for (let cycle = 0; cycle < 10; cycle++) {
      await element.open({ kind: "url", url });
    }
    await element.close();
  }, fixtureUrl("letter"));

  expect(await liveWorkers()).toBe(0);
  await expect(page.locator(".pv-page, pdf-viewer canvas")).toHaveCount(0);
});

test("move_ShouldKeepDocumentOpen_WhenElementIsReinsertedImmediately", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  await viewer.open("letter");

  await viewer.host.evaluate(async (element: PdfViewerElement) => {
    const parent = element.parentElement!;
    parent.removeChild(element);
    parent.appendChild(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  await expect(viewer.host).toHaveAttribute("data-document-state", "ready");
});

test("multipleViewers_ShouldEachShowOwnDocument_WhenOnSamePage", async ({ page }) => {
  const viewer = new Viewer(page);
  await viewer.goto();
  await page.evaluate(async ([first, second]) => {
    const hostA = document.querySelector("pdf-viewer") as PdfViewerElement;
    const hostB = document.createElement("pdf-viewer") as PdfViewerElement;
    hostB.id = "second";
    document.body.append(hostB);
    await Promise.all([hostA.open({ kind: "url", url: first! }), hostB.open({ kind: "url", url: second! })]);
  }, [fixtureUrl("letter"), fixtureUrl("a4")]);

  await expect(page.locator("#viewer")).toHaveAttribute("data-page-count", "3");
  await expect(page.locator("#second")).toHaveAttribute("data-page-count", "1");
  await expect(page.locator("#second .pv-page")).toHaveAttribute("data-page-width", "595");
});
