import type { DocumentSource, EngineDocument, EnginePage, RenderHandle, TextRender } from "./engine.js";
import { DocumentError, openDocument, RenderCanceled } from "./engine.js";
import type { PageGeometry, Rotation } from "./geometry.js";
import { fitScale, normalizeRotation } from "./geometry.js";
import type { DrawDefaults, ViewerTool } from "./object-layer.js";
import { ObjectLayer } from "./object-layer.js";
import type { NewPageObject, ObjectChange, PageObject, SelectionChange } from "./object-store.js";
import { ObjectStore } from "./object-store.js";

export type ZoomSetting = number | "fit-width" | "fit-page";

export interface ViewerOptions {
  /** The zoom to start with. Defaults to fit-width. */
  initialZoom?: ZoomSetting;
  /** Leaves form fields unpainted, while other annotations still appear. Defaults to false. */
  hideFormFields?: boolean;
  /**
   * Whether arrow keys and Delete edit the focused object. Turn off if the application handles them. Defaults to true.
   */
  keyboardEditing?: boolean;
  /** Rounds rectangles the user creates or changes to whole page units. Defaults to false. */
  roundCoordinates?: boolean;
  /** Whether Ctrl+wheel and pinch gestures zoom. Defaults to true. */
  wheelZoom?: boolean;
  /**
   * What object rectangles are measured against. "page" stays attached to the page's content at any rotation. "display"
   * is the page as presented after rotation, including its UserUnit, so a rectangle keeps its numbers when a page
   * rotates. Defaults to "page".
   */
  coordinates?: "page" | "display";
  /**
   * Where an object catches the pointer. "fill" is its whole area. "border" is a band along its edges, so objects inside
   * or behind it stay reachable, while a selected or very small object still catches the pointer everywhere. Defaults
   * to "fill".
   */
  objectHitArea?: "fill" | "border";
}

/** How fast Ctrl+wheel zooms, as a power of the wheel distance. A wheel notch of 100 changes zoom by about 22%. */
const wheelZoomRate = 0.002;
const minimumZoom = 0.1;
const maximumZoom = 10;
const maximumCanvasPixels = 2 ** 25;
const stylesUrl = new URL("./pv.css", import.meta.url).href;
let stylesLoaded: Promise<void> | undefined;

function loadStyles(): Promise<void> {
  stylesLoaded ??= new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = stylesUrl;
    link.onload = () => resolve();
    link.onerror = () => {
      // Forgetting the failure lets the next document try again.
      link.remove();
      stylesLoaded = undefined;
      reject(new Error(`Could not load ${stylesUrl}.`));
    };
    document.head.append(link);
  });
  return stylesLoaded;
}

/**
 * The viewer, as a framework-independent custom element.
 *
 * Its data attributes and events are the public test contract, and they stay in production builds. Host attributes
 * report document state, and each .pv-page reports its own render, text and object state, so tests can wait on those
 * rather than on timers.
 */
export class PdfViewerElement extends HTMLElement {
  readonly #store = new ObjectStore({
    onChange: (change) => this.#onObjectChange(change),
    onSelectionChange: (change) => this.#onSelectionChange(change),
  });
  #viewport: HTMLElement | undefined;
  #page: HTMLElement | undefined;
  #layer: ObjectLayer | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #document: EngineDocument | undefined;
  #enginePage: EnginePage | undefined;
  #canvasRender: RenderHandle | undefined;
  #textRender: TextRender | undefined;
  #textReady = false;
  #openGeneration = 0;
  #navigationGeneration = 0;
  #renderGeneration = 0;
  #pageNumber = 1;
  #zoom: ZoomSetting = "fit-width";
  #rotation: Rotation = 0;
  #tool: ViewerTool = "select";
  #drawDefaults: DrawDefaults = {};
  #hideFormFields = false;
  #keyboardEditing = true;
  #roundCoordinates = false;
  #wheelZoom = true;
  #coordinates: "page" | "display" = "page";
  readonly #pageRotations = new Map<number, Rotation>();

  connectedCallback(): void {
    if (this.#viewport !== undefined) {
      return;
    }
    this.classList.add("pv-viewer");
    this.dataset.documentState = "idle";
    this.dataset.tool = this.#tool;
    this.dataset.objectHitArea ??= "fill";
    this.dataset.selectedObject = "";
    this.dataset.lastChange = "0";
    this.#viewport = document.createElement("div");
    this.#viewport.className = "pv-viewport";
    this.append(this.#viewport);
    this.#resizeObserver = new ResizeObserver(() => this.#onResize());
    this.#resizeObserver.observe(this.#viewport);
    // Not passive, because it has to stop the browser from zooming the whole page.
    this.#viewport.addEventListener("wheel", (event) => this.#onWheel(event), { passive: false });
  }

  /** Applies options. Set them before opening a document, or the page repaints to apply them. */
  configure(options: ViewerOptions): void {
    if (options.initialZoom !== undefined) {
      this.#zoom = normalizeZoom(options.initialZoom) ?? this.#zoom;
    }
    this.#keyboardEditing = options.keyboardEditing ?? this.#keyboardEditing;
    this.#roundCoordinates = options.roundCoordinates ?? this.#roundCoordinates;
    this.#wheelZoom = options.wheelZoom ?? this.#wheelZoom;
    this.#hideFormFields = options.hideFormFields ?? this.#hideFormFields;
    this.#coordinates = options.coordinates ?? this.#coordinates;
    this.dataset.objectHitArea = options.objectHitArea ?? this.dataset.objectHitArea ?? "fill";
    this.#applyTool();
    void this.#renderCurrentPage();
  }

  /** Moving the element in the DOM also disconnects it, so teardown only happens if it stays disconnected. */
  disconnectedCallback(): void {
    queueMicrotask(() => {
      if (!this.isConnected) {
        void this.close();
      }
    });
  }

  /** The displayed page, or 0 when no document is open. */
  get currentPage(): number {
    return this.#document === undefined ? 0 : this.#pageNumber;
  }

  get selectedObjectId(): string | null {
    return this.#store.selectedId;
  }

  /** Opens a document, replacing any open one. An open() or close() before it finishes discards this document. */
  async open(source: DocumentSource, initialPage = 1): Promise<void> {
    const generation = ++this.#openGeneration;
    // Set first, so a test waiting for "ready" can't be satisfied by the previous document.
    this.#setDocumentState("loading");
    let opened: EngineDocument;
    try {
      // Inside the try, so if the previous document fails to close, this open ends in the error state instead of staying
      // "loading".
      await this.#closeDocument();
      if (generation !== this.#openGeneration) {
        return;
      }
      await loadStyles();
      opened = await openDocument(source);
    } catch (error) {
      if (generation === this.#openGeneration) {
        this.#fail(error);
      }
      return;
    }
    if (generation !== this.#openGeneration) {
      await opened.destroy();
      return;
    }
    this.#document = opened;
    this.dataset.pageCount = String(opened.pageCount);
    this.#pageRotations.clear();
    const previousPage = this.#pageNumber;
    const firstPage = clampPage(initialPage, opened.pageCount);
    this.#pageNumber = firstPage;
    this.dataset.currentPage = String(firstPage);
    this.#setDocumentState("ready");
    const navigation = this.#navigationGeneration;
    this.#emit("pv-document-loaded", { pageCount: opened.pageCount });
    // A listener may already have navigated or closed the document, and that has to win.
    if (navigation === this.#navigationGeneration) {
      await this.#showPage(firstPage, previousPage);
    }
  }

  async close(): Promise<void> {
    this.#openGeneration++;
    this.#setDocumentState("idle");
    await this.#closeDocument();
  }

  async goToPage(pageNumber: number): Promise<void> {
    if (this.#document !== undefined) {
      await this.#showPage(clampPage(pageNumber, this.#document.pageCount));
    }
  }

  /** Sets the zoom. A number that isn't finite is ignored, since there's no page size it could produce. */
  async setZoom(zoom: ZoomSetting): Promise<void> {
    const normalized = normalizeZoom(zoom);
    if (normalized !== undefined) {
      this.#zoom = normalized;
      await this.#renderCurrentPage();
    }
  }

  /** Sets the viewing rotation, which is added to any rotation the page already has. */
  async setRotation(degrees: number): Promise<void> {
    this.#rotation = normalizeRotation(degrees);
    await this.#renderCurrentPage();
  }

  /**
   * Sets the rotation one page ends up with, replacing both its own rotation and the viewing rotation. Pass null to
   * return to its own rotation plus the viewing rotation. The result doesn't depend on any rotation the page already has.
   */
  async setPageRotation(pageNumber: number, degrees: number | null): Promise<void> {
    if (degrees === null) {
      this.#pageRotations.delete(pageNumber);
    } else {
      this.#pageRotations.set(pageNumber, normalizeRotation(degrees));
    }
    if (pageNumber === this.#pageNumber) {
      await this.#renderCurrentPage();
    }
  }

  /** The original document's bytes. For a URL source, this fetches whatever hasn't been fetched yet. */
  async getDocumentData(): Promise<Uint8Array> {
    if (this.#document === undefined) {
      throw new Error("No document is open.");
    }
    return this.#document.getData();
  }

  setTool(tool: ViewerTool, defaults: DrawDefaults = {}): void {
    this.#tool = tool;
    this.#drawDefaults = defaults;
    this.dataset.tool = tool;
    this.#applyTool();
  }

  addObject(object: NewPageObject): PageObject {
    return this.#store.add(object, "api");
  }

  updateObject(id: string, patch: Partial<Omit<PageObject, "id">>): PageObject {
    return this.#store.update(id, patch, "api");
  }

  removeObject(id: string): void {
    this.#store.remove(id, "api");
  }

  setObjects(objects: readonly NewPageObject[]): void {
    this.#store.replaceAll(objects, "api");
  }

  selectObject(id: string | null): void {
    this.#store.select(id, "api");
  }

  /** Reads any object, including those on pages that are not displayed and so have no element. */
  getObject(id: string): PageObject | undefined {
    return this.#store.get(id);
  }

  getObjects(): PageObject[] {
    return this.#store.all();
  }

  /** Navigation has its own counter because zooming or resizing while a page loads doesn't count as navigating away. */
  async #showPage(pageNumber: number, previousPage = this.#pageNumber): Promise<void> {
    const document = this.#document!;
    const generation = ++this.#navigationGeneration;
    let page: EnginePage;
    try {
      page = await document.getPage(pageNumber);
    } catch (error) {
      if (generation === this.#navigationGeneration && document === this.#document) {
        await this.#onPageFailed(error);
      }
      return;
    }
    if (generation !== this.#navigationGeneration || document !== this.#document) {
      return;
    }
    this.#cancelCanvasRender();
    this.#disposePage();
    this.#enginePage = page;
    const changed = previousPage !== pageNumber;
    this.#pageNumber = pageNumber;
    this.dataset.currentPage = String(pageNumber);
    this.#createPageElement(pageNumber, page);
    const rendered = this.#renderCurrentPage();
    // Listeners hear about the page before it finishes painting, so they can replace its objects without waiting.
    if (changed) {
      this.#emit("pv-page-change", { page: pageNumber });
    }
    await rendered;
  }

  /** A document that can't show its first page has failed and closes. Otherwise the page already on screen stays there. */
  async #onPageFailed(error: unknown): Promise<void> {
    if (this.#page !== undefined) {
      this.#emitError("page", error);
      return;
    }
    const generation = this.#openGeneration;
    await this.#closeDocument();
    if (generation === this.#openGeneration) {
      this.#fail(error);
    }
  }

  #createPageElement(pageNumber: number, page: EnginePage): void {
    this.#page = document.createElement("div");
    this.#page.className = "pv-page";
    this.#page.dataset.pageNumber = String(pageNumber);
    this.#viewport!.replaceChildren(this.#page);
    const geometry = this.#objectGeometry(page, this.#viewRotation(page));
    this.#layer = new ObjectLayer(this.#page, pageNumber, geometry, this.#store);
    this.#applyTool();
  }

  /** The space object rectangles are measured in. Display space is just a page that isn't rotated any further. */
  #objectGeometry(page: EnginePage, viewRotation: Rotation): PageGeometry {
    return this.#coordinates === "display"
      ? { ...page.cssSize(1, viewRotation), rotation: 0 }
      : page.geometry(viewRotation);
  }

  #applyTool(): void {
    if (this.#layer !== undefined) {
      this.#layer.keyboardEditing = this.#keyboardEditing;
      this.#layer.roundCoordinates = this.#roundCoordinates;
      this.#layer.drawDefaults = this.#drawDefaults;
      this.#layer.tool = this.#tool;
    }
  }

  /** The rotation to add to the page's own: the viewing rotation, or whatever reaches the setPageRotation value. */
  #viewRotation(page: EnginePage): Rotation {
    const final = this.#pageRotations.get(this.#pageNumber);
    return final === undefined ? this.#rotation : normalizeRotation(final - page.geometry(0).rotation);
  }

  /**
   * Sizes the page at once so objects follow the zoom immediately, then repaints. The old canvas stays visible until
   * the new one is ready, and data-render-scale changes only then, so a test can't mistake a stretched page for a
   * finished render.
   */
  async #renderCurrentPage(): Promise<void> {
    const page = this.#enginePage;
    const element = this.#page;
    if (page === undefined || element === undefined) {
      return;
    }
    const generation = ++this.#renderGeneration;
    this.#cancelCanvasRender();

    const viewRotation = this.#viewRotation(page);
    const scale = this.#resolveScale(page, viewRotation);
    if (scale === undefined) {
      // There's no size to fit yet, usually because the viewer is hidden, so the resize observer renders it once there
      // is. Observing again forgets the last size, because hiding and showing within one frame would otherwise look like
      // no change. That only works at no size at all: anything else would count as a change and fire again every frame.
      element.dataset.pageState = "pending";
      if (this.#viewport!.clientWidth === 0 && this.#viewport!.clientHeight === 0) {
        this.#resizeObserver!.unobserve(this.#viewport!);
        this.#resizeObserver!.observe(this.#viewport!);
      }
      return;
    }
    const geometry = this.#objectGeometry(page, viewRotation);
    const size = page.cssSize(scale, viewRotation);
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
    element.style.setProperty("--total-scale-factor", String(page.totalScale(scale)));
    element.dataset.pageState = "rendering";
    element.dataset.rotation = String(page.geometry(viewRotation).rotation);
    element.dataset.pageWidth = String(geometry.width);
    element.dataset.pageHeight = String(geometry.height);
    this.dataset.zoom = String(scale);
    this.#layer!.geometry = geometry;

    const canvas = document.createElement("canvas");
    canvas.className = "pv-canvas";
    canvas.setAttribute("role", "presentation");
    const canvasOptions = { maximumPixels: maximumCanvasPixels, hideFormFields: this.#hideFormFields };
    const canvasRender = page.renderCanvas(canvas, scale, viewRotation, canvasOptions);
    this.#canvasRender = canvasRender;
    this.#renderText(page, element, scale, viewRotation);

    try {
      await canvasRender.done;
    } catch (error) {
      if (!(error instanceof RenderCanceled) && generation === this.#renderGeneration) {
        element.dataset.pageState = "error";
        this.#emitError("render", error);
      }
      return;
    }
    if (generation === this.#renderGeneration) {
      element.querySelector(":scope > .pv-canvas")?.remove();
      element.prepend(canvas);
      element.dataset.renderScale = String(scale);
      element.dataset.pageState = "rendered";
      this.#emit("pv-page-rendered", { page: this.#pageNumber, scale });
    }
  }

  /**
   * Keeps text off the rendering path, because extraction can take seconds on some documents, and nothing else should
   * wait for it. A finished layer just moves to the new zoom or rotation.
   */
  #renderText(page: EnginePage, element: HTMLElement, scale: number, viewRotation: Rotation): void {
    if (this.#textReady) {
      this.#textRender!.update(scale, viewRotation);
      return;
    }
    this.#textRender?.cancel();
    element.dataset.textState = "pending";
    const container = document.createElement("div");
    container.className = "textLayer";
    const render = page.renderText(container, scale, viewRotation);
    this.#textRender = render;
    render.done.then(() => {
      if (render === this.#textRender) {
        this.#layer!.element.before(container);
        this.#textReady = true;
        element.dataset.textState = "ready";
      }
    }, (error: unknown) => {
      if (render === this.#textRender && !(error instanceof RenderCanceled)) {
        element.dataset.textState = "error";
        this.#emitError("render", error);
      }
    });
  }

  /** Returns undefined if the page should fit a size the viewer doesn't have yet, which usually means it's hidden. */
  #resolveScale(page: EnginePage, viewRotation: Rotation): number | undefined {
    if (typeof this.#zoom === "number") {
      return this.#zoom;
    }
    const { clientWidth: width, clientHeight: height } = this.#viewport!;
    if (width === 0 || (this.#zoom === "fit-page" && height === 0)) {
      return undefined;
    }
    return fitScale(this.#zoom, page.cssSize(1, viewRotation), { width, height });
  }

  #onResize(): void {
    if (typeof this.#zoom !== "number") {
      void this.#renderCurrentPage();
    }
  }

  /** Zooms around the pointer, so whatever is under it stays there. */
  #onWheel(event: WheelEvent): void {
    const element = this.#page;
    if (!event.ctrlKey || !this.#wheelZoom || element === undefined) {
      return;
    }
    event.preventDefault();
    const before = element.getBoundingClientRect();
    const fractionX = (event.clientX - before.left) / before.width;
    const fractionY = (event.clientY - before.top) / before.height;

    void this.setZoom(Number(this.dataset.zoom) * Math.exp(-event.deltaY * wheelZoomRate));

    const after = element.getBoundingClientRect();
    this.#viewport!.scrollLeft += after.left + fractionX * after.width - event.clientX;
    this.#viewport!.scrollTop += after.top + fractionY * after.height - event.clientY;
  }

  #onObjectChange(change: ObjectChange): void {
    this.dataset.lastChange = String(change.sequence);
    if (change.kind === "replaced") {
      this.#layer?.sync();
    } else {
      this.#layer?.syncObject(change.object.id);
    }
    this.#emit("pv-object-change", change);
  }

  #onSelectionChange(change: SelectionChange): void {
    this.dataset.selectedObject = change.id ?? "";
    this.#layer?.syncSelection();
    this.#emit("pv-selection-change", change);
  }

  #cancelCanvasRender(): void {
    this.#canvasRender?.cancel();
    this.#canvasRender = undefined;
  }

  #disposePage(): void {
    this.#textRender?.cancel();
    this.#textRender = undefined;
    this.#textReady = false;
    this.#layer?.dispose();
    this.#layer = undefined;
    this.#page?.remove();
    this.#page = undefined;
    this.#enginePage?.release();
    this.#enginePage = undefined;
  }

  async #closeDocument(): Promise<void> {
    this.#navigationGeneration++;
    this.#renderGeneration++;
    this.#cancelCanvasRender();
    this.#disposePage();
    if (this.#store.all().length > 0) {
      this.#store.replaceAll([], "api");
    }
    const closing = this.#document;
    this.#document = undefined;
    delete this.dataset.pageCount;
    delete this.dataset.currentPage;
    delete this.dataset.zoom;
    await closing?.destroy();
  }

  #setDocumentState(state: "idle" | "loading" | "ready" | "error"): void {
    this.dataset.documentState = state;
    if (state !== "error") {
      delete this.dataset.errorCode;
    }
  }

  #fail(error: unknown): void {
    const code = error instanceof DocumentError ? error.code : "unknown";
    this.#setDocumentState("error");
    this.dataset.errorCode = code;
    this.#emit("pv-error", { code, message: errorMessage(error), documentFailed: true });
  }

  #emitError(code: "render" | "page", error: unknown): void {
    this.#emit("pv-error", { code, message: errorMessage(error), documentFailed: false });
  }

  #emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

/** Keeps a zoom within limits, or returns undefined for a number that isn't finite. */
function normalizeZoom(zoom: ZoomSetting): ZoomSetting | undefined {
  if (typeof zoom !== "number") {
    return zoom;
  }
  return Number.isFinite(zoom) ? Math.min(Math.max(zoom, minimumZoom), maximumZoom) : undefined;
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.trunc(page), 1), pageCount);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
