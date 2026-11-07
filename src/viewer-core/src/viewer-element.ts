import type { DocumentSource, EngineDocument, EnginePage, RenderHandle } from "./engine.js";
import { DocumentError, openDocument, RenderCancelled } from "./engine.js";
import type { Rotation } from "./geometry.js";
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
  /** Whether arrow keys and Delete edit the focused object. Turn off if the application handles them. Defaults to true. */
  keyboardEditing?: boolean;
  /** Rounds rectangles the user creates or changes to whole page units. Defaults to false. */
  roundCoordinates?: boolean;
  /** Whether Ctrl+wheel and pinch gestures zoom. Defaults to true. */
  wheelZoom?: boolean;
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
    link.onerror = () => reject(new Error(`Could not load ${stylesUrl}.`));
    document.head.append(link);
  });
  return stylesLoaded;
}

/**
 * The viewer, as a framework-independent custom element.
 *
 * Its data attributes and events are the public test contract, and are always present in production. Host attributes
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
  #renders: RenderHandle[] = [];
  #openGeneration = 0;
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
  readonly #pageRotations = new Map<number, Rotation>();

  connectedCallback(): void {
    if (this.#viewport !== undefined) {
      return;
    }
    this.classList.add("pv-viewer");
    this.dataset.documentState = "idle";
    this.dataset.tool = this.#tool;
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
      this.#zoom = options.initialZoom;
    }
    this.#keyboardEditing = options.keyboardEditing ?? this.#keyboardEditing;
    this.#roundCoordinates = options.roundCoordinates ?? this.#roundCoordinates;
    this.#wheelZoom = options.wheelZoom ?? this.#wheelZoom;
    this.#hideFormFields = options.hideFormFields ?? this.#hideFormFields;
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

  get pageCount(): number {
    return this.#document?.pageCount ?? 0;
  }

  get currentPage(): number {
    return this.#pageNumber;
  }

  get selectedObjectId(): string | null {
    return this.#store.selectedId;
  }

  /** Opens a document, replacing any open one. A later call makes an earlier call's result count for nothing. */
  async open(source: DocumentSource, initialPage = 1): Promise<void> {
    const generation = ++this.#openGeneration;
    await this.#closeDocument();
    this.#setDocumentState("loading");
    let opened: EngineDocument;
    try {
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
    this.#store.replaceAll([], "api");
    this.#setDocumentState("ready");
    this.#emit("pv-document-loaded", { pageCount: opened.pageCount });
    await this.#showPage(clampPage(initialPage, opened.pageCount));
  }

  async close(): Promise<void> {
    this.#openGeneration++;
    await this.#closeDocument();
    this.#setDocumentState("idle");
  }

  async goToPage(pageNumber: number): Promise<void> {
    if (this.#document !== undefined) {
      await this.#showPage(clampPage(pageNumber, this.#document.pageCount));
    }
  }

  async setZoom(zoom: ZoomSetting): Promise<void> {
    this.#zoom = typeof zoom === "number" ? Math.min(Math.max(zoom, minimumZoom), maximumZoom) : zoom;
    await this.#renderCurrentPage();
  }

  /** Sets the viewing rotation, which is added to any rotation the page already has. */
  async setRotation(degrees: number): Promise<void> {
    this.#rotation = normalizeRotation(degrees);
    await this.#renderCurrentPage();
  }

  /**
   * Sets how one page is finally displayed, replacing both its own rotation and the viewing rotation. Pass null to go
   * back to its normal rotation. Unlike adding to a rotation, the same call always gives the same result.
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

  async #showPage(pageNumber: number): Promise<void> {
    const document = this.#document!;
    const generation = ++this.#renderGeneration;
    this.#cancelRenders();
    const page = await document.getPage(pageNumber);
    if (generation !== this.#renderGeneration || document !== this.#document) {
      return;
    }
    this.#disposePage();
    this.#enginePage = page;
    const changed = this.#pageNumber !== pageNumber;
    this.#pageNumber = pageNumber;
    this.dataset.currentPage = String(pageNumber);
    this.#createPageElement(pageNumber, page);
    await this.#renderCurrentPage();
    if (changed) {
      this.#emit("pv-page-change", { page: pageNumber });
    }
  }

  #createPageElement(pageNumber: number, page: EnginePage): void {
    this.#page = document.createElement("div");
    this.#page.className = "pv-page";
    this.#page.dataset.pageNumber = String(pageNumber);
    this.#viewport!.replaceChildren(this.#page);
    this.#layer = new ObjectLayer(this.#page, pageNumber, page.geometry(this.#viewRotation(page)), this.#store);
    this.#applyTool();
  }

  #applyTool(): void {
    if (this.#layer !== undefined) {
      this.#layer.keyboardEditing = this.#keyboardEditing;
      this.#layer.roundCoordinates = this.#roundCoordinates;
      this.#layer.drawDefaults = this.#drawDefaults;
      this.#layer.tool = this.#tool;
    }
  }

  /** The rotation to add to the page's own, which a final rotation set for this page takes into account. */
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
    this.#cancelRenders();

    const viewRotation = this.#viewRotation(page);
    const scale = this.#resolveScale(page, viewRotation);
    if (scale === undefined) {
      // The viewer is hidden, so there's no size to fit yet. The resize observer renders it once it appears. Observing
      // again forgets the last size, because hiding and showing within one frame would otherwise look like no change.
      element.dataset.pageState = "pending";
      this.#resizeObserver!.unobserve(this.#viewport!);
      this.#resizeObserver!.observe(this.#viewport!);
      return;
    }
    const geometry = page.geometry(viewRotation);
    const size = page.cssSize(scale, viewRotation);
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
    element.style.setProperty("--total-scale-factor", String(page.totalScale(scale)));
    element.dataset.pageState = "rendering";
    element.dataset.textState = "pending";
    element.dataset.rotation = String(geometry.rotation);
    element.dataset.pageWidth = String(geometry.width);
    element.dataset.pageHeight = String(geometry.height);
    this.dataset.zoom = String(scale);
    this.#layer!.geometry = geometry;

    const canvas = document.createElement("canvas");
    canvas.className = "pv-canvas";
    canvas.setAttribute("role", "presentation");
    const canvasOptions = { maximumPixels: maximumCanvasPixels, hideFormFields: this.#hideFormFields };
    const canvasRender = page.renderCanvas(canvas, scale, viewRotation, canvasOptions);

    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const textRender = page.renderText(textLayer, scale, viewRotation);
    this.#renders = [canvasRender, textRender];

    await Promise.all([
      this.#settle(canvasRender, generation, () => {
        element.querySelector(":scope > .pv-canvas")?.remove();
        element.prepend(canvas);
        element.dataset.renderScale = String(scale);
        element.dataset.pageState = "rendered";
        this.#emit("pv-page-rendered", { page: this.#pageNumber, scale });
      }, () => { element.dataset.pageState = "error"; }),
      this.#settle(textRender, generation, () => {
        element.querySelector(":scope > .textLayer")?.remove();
        this.#layer!.element.before(textLayer);
        element.dataset.textState = "ready";
      }, () => { element.dataset.textState = "error"; }),
    ]);
  }

  async #settle(render: RenderHandle, generation: number, onDone: () => void, onError: () => void): Promise<void> {
    try {
      await render.done;
    } catch (error) {
      if (!(error instanceof RenderCancelled) && generation === this.#renderGeneration) {
        onError();
        this.#emit("pv-error", { code: "render", message: errorMessage(error) });
      }
      return;
    }
    if (generation === this.#renderGeneration) {
      onDone();
    }
  }

  /** Returns undefined if the page should fit a viewer that has no size, which happens while it's hidden. */
  #resolveScale(page: EnginePage, viewRotation: Rotation): number | undefined {
    if (typeof this.#zoom === "number") {
      return this.#zoom;
    }
    const { clientWidth: width, clientHeight: height } = this.#viewport!;
    if (width === 0 || height === 0) {
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
    this.#layer?.sync();
    this.#emit("pv-object-change", change);
  }

  #onSelectionChange(change: SelectionChange): void {
    this.dataset.selectedObject = change.id ?? "";
    this.#layer?.sync();
    this.#emit("pv-selection-change", change);
  }

  #cancelRenders(): void {
    for (const render of this.#renders) {
      render.cancel();
    }
    this.#renders = [];
  }

  #disposePage(): void {
    this.#layer?.dispose();
    this.#layer = undefined;
    this.#page?.remove();
    this.#page = undefined;
    this.#enginePage?.release();
    this.#enginePage = undefined;
  }

  async #closeDocument(): Promise<void> {
    this.#renderGeneration++;
    this.#cancelRenders();
    this.#disposePage();
    const closing = this.#document;
    this.#document = undefined;
    delete this.dataset.pageCount;
    delete this.dataset.currentPage;
    await closing?.destroy();
  }

  #setDocumentState(state: "idle" | "loading" | "ready" | "error"): void {
    this.dataset.documentState = state;
  }

  #fail(error: unknown): void {
    const code = error instanceof DocumentError ? error.code : "unknown";
    this.#setDocumentState("error");
    this.dataset.errorCode = code;
    this.#emit("pv-error", { code, message: errorMessage(error) });
  }

  #emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.trunc(page), 1), pageCount);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
