import type { EnginePage, RenderHandle, TextRender } from "./engine.js";
import { RenderCanceled } from "./engine.js";
import type { PageGeometry, Rotation } from "./geometry.js";
import type { ObjectStore } from "./object-store.js";
import { ObjectView } from "./object-view.js";
import type { ToolPresentation } from "./tool.js";

const maximumCanvasPixels = 2 ** 25;

/** How a page is displayed. */
export interface PageDisplay {
  scale: number;
  /** The rotation added to the page's own. */
  viewRotation: Rotation;
  /** The space the page's objects are measured in. */
  geometry: PageGeometry;
  hideFormFields: boolean;
}

export interface PageViewListener {
  onRendered(scale: number): void;
  onRenderError(error: unknown): void;
}

/**
 * One displayed page: its element, its canvas and text, and its objects. Its data attributes report render and text
 * state, as the test contract describes. They are written here and never read back.
 */
export class PageView {
  readonly element: HTMLElement;
  readonly objects: ObjectView;
  readonly pageNumber: number;
  readonly page: EnginePage;
  readonly #listener: PageViewListener;
  /** The render whose canvas will be shown. A render that finds another here has been replaced or canceled. */
  #canvasRender: RenderHandle | undefined;
  #textRender: TextRender | undefined;
  #textReady = false;

  constructor(pageNumber: number, page: EnginePage, geometry: PageGeometry, store: ObjectStore,
    presentation: ToolPresentation, listener: PageViewListener) {
    this.pageNumber = pageNumber;
    this.page = page;
    this.#listener = listener;
    this.element = document.createElement("div");
    this.element.className = "pv-page";
    this.element.dataset.pageNumber = String(pageNumber);
    this.objects = new ObjectView(this.element, pageNumber, geometry, store, presentation);
  }

  /** Marks the page as waiting for a size to fit, which cancels any render under way. */
  markPending(): void {
    this.#cancelCanvasRender();
    this.element.dataset.pageState = "pending";
  }

  /**
   * Sizes the page at once so objects follow the zoom immediately, then repaints. The old canvas stays visible until
   * the new one is ready, and data-render-scale changes only then, so a test can't mistake a stretched page for a
   * finished render. Resolves when this render finishes or fails, or when it's canceled or replaced.
   */
  async render({ scale, viewRotation, geometry, hideFormFields }: PageDisplay): Promise<void> {
    this.#cancelCanvasRender();
    const { element, page } = this;
    const size = page.cssSize(scale, viewRotation);
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
    element.style.setProperty("--total-scale-factor", String(page.totalScale(scale)));
    element.dataset.pageState = "rendering";
    element.dataset.rotation = String(page.geometry(viewRotation).rotation);
    element.dataset.pageWidth = String(geometry.width);
    element.dataset.pageHeight = String(geometry.height);
    this.objects.geometry = geometry;

    const canvas = document.createElement("canvas");
    canvas.className = "pv-canvas";
    canvas.setAttribute("role", "presentation");
    const canvasOptions = { maximumPixels: maximumCanvasPixels, hideFormFields };
    const canvasRender = page.renderCanvas(canvas, scale, viewRotation, canvasOptions);
    this.#canvasRender = canvasRender;
    this.#renderText(scale, viewRotation);

    try {
      await canvasRender.done;
    } catch (error) {
      if (!(error instanceof RenderCanceled) && canvasRender === this.#canvasRender) {
        element.dataset.pageState = "error";
        this.#listener.onRenderError(error);
      }
      return;
    }
    if (canvasRender === this.#canvasRender) {
      element.querySelector(":scope > .pv-canvas")?.remove();
      element.prepend(canvas);
      element.dataset.renderScale = String(scale);
      element.dataset.pageState = "rendered";
      this.#listener.onRendered(scale);
    }
  }

  dispose(): void {
    this.#cancelCanvasRender();
    this.#textRender?.cancel();
    this.#textRender = undefined;
    this.element.remove();
    this.page.release();
  }

  /**
   * Keeps text off the rendering path, because extraction can take seconds on some documents, and nothing else should
   * wait for it. A finished layer just moves to the new zoom or rotation.
   */
  #renderText(scale: number, viewRotation: Rotation): void {
    if (this.#textReady) {
      this.#textRender!.update(scale, viewRotation);
      return;
    }
    this.#textRender?.cancel();
    this.element.dataset.textState = "pending";
    const container = document.createElement("div");
    container.className = "textLayer";
    const render = this.page.renderText(container, scale, viewRotation);
    this.#textRender = render;
    render.done.then(() => {
      if (render === this.#textRender) {
        this.objects.element.before(container);
        this.#textReady = true;
        this.element.dataset.textState = "ready";
      }
    }, (error: unknown) => {
      if (render === this.#textRender && !(error instanceof RenderCanceled)) {
        this.element.dataset.textState = "error";
        this.#listener.onRenderError(error);
      }
    });
  }

  #cancelCanvasRender(): void {
    this.#canvasRender?.cancel();
    this.#canvasRender = undefined;
  }
}
