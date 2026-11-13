import { DocumentSession } from "./document-session.js";
import type { DocumentSource, EngineDocument, EnginePage } from "./engine.js";
import { DocumentError, openDocument } from "./engine.js";
import type { PageInfo, PvEventMap } from "./events.js";
import { errorMessage } from "./events.js";
import type { PageGeometry, Point, Rotation } from "./geometry.js";
import { displaySize, fitScale, normalizeRotation, pageToDisplay } from "./geometry.js";
import { InteractionController } from "./interaction-controller.js";
import type { NewPageObject, ObjectBatch, ObjectPatch, ObjectsChanged, PageObject, SelectionChanged }
  from "./object-store.js";
import { checkAppDataKeys, ObjectStore } from "./object-store.js";
import { PageView } from "./page-view.js";
import type { DrawDefaults, ToolOptions, ViewerTool } from "./tool.js";
import type { ResolvedOptions, ViewerOptions, ZoomSetting } from "./viewer-options.js";
import { defaultOptions, mergeOptions, needsRepaint, normalizeZoom } from "./viewer-options.js";

/** How fast Ctrl+wheel zooms, as a power of the wheel distance. A wheel notch of 100 changes zoom by about 22%. */
const wheelZoomRate = 0.002;
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
    onChanged: (change) => this.#onObjectsChanged(change),
    onSelectionChanged: (change) => this.#onSelectionChanged(change),
    onDraftAdded: (draft) => this.#onDraftAdded(draft),
    onDraftResolved: (id, committed) => this.#onDraftResolved(id, committed),
  });
  #viewport: HTMLElement | undefined;
  /** Exists once the element is connected, as the viewport does. */
  #controller: InteractionController | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #session: DocumentSession | undefined;
  /** The displayed page. This viewer shows one page at a time. */
  #view: PageView | undefined;
  /** Stands for the latest open() or close(). An open that finds another here has been replaced. */
  #openAttempt = {};
  /** The latest open(), so commands sent while its document loads can wait for it. close() forgets it. */
  #opening: Promise<void> | undefined;
  /** A page turn asked for while a document loads. The document opens on it instead of its initial page. */
  #requestedPage: number | undefined;
  /** Stands for the latest page turn, in the same way. Zooming or resizing while a page loads doesn't replace it. */
  #navigation: object | undefined;
  #pageNumber = 1;
  #options = defaultOptions;
  #zoom: ZoomSetting = defaultOptions.initialZoom;
  /** The zoom being displayed or rendered, as a number: #zoom itself, or the scale a fit mode worked out to. */
  #scale: number | undefined;
  #rotation: Rotation = 0;
  #tool: ViewerTool = "select";
  #drawDefaults: DrawDefaults = {};

  connectedCallback(): void {
    if (this.#viewport !== undefined) {
      return;
    }
    this.classList.add("pv-viewer");
    this.dataset.documentState = "idle";
    this.dataset.tool = this.#tool;
    this.dataset.objectHitArea = this.#options.objectHitArea;
    this.dataset.selectedObject = "";
    this.dataset.lastChange = "0";
    this.#viewport = document.createElement("div");
    this.#viewport.className = "pv-viewport";
    this.append(this.#viewport);
    this.#resizeObserver = new ResizeObserver(() => this.#onResize());
    this.#resizeObserver.observe(this.#viewport);
    // Not passive, because it has to stop the browser from zooming the whole page.
    this.#viewport.addEventListener("wheel", (event) => this.#onWheel(event), { passive: false });
    this.#controller = new InteractionController(this.#viewport, this.#store, toolOptions(this.#options));
    this.#applyTool();
  }

  /**
   * Applies the options given. Any left out keep their current values. They take effect at once without ending a
   * gesture, and the page repaints only for options that change how it's painted or measured. A new initial zoom takes
   * effect only while no document is open. The zoom carries over from one document to the next, so a change made while
   * one is open has no effect.
   */
  configure(options: ViewerOptions): void {
    const before = this.#options;
    const after = this.#options = mergeOptions(before, options);
    if (this.#session === undefined && after.initialZoom !== before.initialZoom) {
      this.#zoom = after.initialZoom;
    }
    this.dataset.objectHitArea = after.objectHitArea;
    if (this.#controller !== undefined) {
      this.#controller.options = toolOptions(after);
    }
    if (needsRepaint(before, after)) {
      void this.#renderCurrentPage();
    }
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
    return this.#session === undefined ? 0 : this.#pageNumber;
  }

  /** The zoom being displayed or rendered, with 1 meaning 100%, or undefined until a page has been sized. */
  get zoom(): number | undefined {
    return this.#scale;
  }

  /** The viewing rotation, which is added to any rotation a page already has. */
  get rotation(): Rotation {
    return this.#rotation;
  }

  /** The object selected last, or null when nothing is selected. */
  get selectedObjectId(): string | null {
    return this.#store.primarySelectedId;
  }

  /** Every selected object, in the order selected. */
  get selectedObjectIds(): readonly string[] {
    return this.#store.selectedIds;
  }

  /**
   * Opens a document, replacing any open one. An open() or close() before it finishes discards this document.
   * Commands that need a document, sent while this one loads, wait for it and apply to it.
   */
  open(source: DocumentSource, initialPage = 1): Promise<void> {
    this.#requestedPage = undefined;
    this.#opening = this.#open(source, initialPage);
    return this.#opening;
  }

  async #open(source: DocumentSource, initialPage: number): Promise<void> {
    const attempt = this.#openAttempt = {};
    // Set first, so a test waiting for "ready" can't be satisfied by the previous document.
    this.#setDocumentState("loading");
    let opened: EngineDocument;
    try {
      // Inside the try, so if the previous document fails to close, this open ends in the error state instead of staying
      // "loading".
      await this.#closeDocument();
      if (attempt !== this.#openAttempt) {
        return;
      }
      await loadStyles();
      opened = await openDocument(source);
    } catch (error) {
      if (attempt === this.#openAttempt) {
        this.#fail(error);
      }
      return;
    }
    if (attempt !== this.#openAttempt) {
      await opened.destroy();
      return;
    }
    const session = this.#session = new DocumentSession(opened);
    this.dataset.pageCount = String(session.pageCount);
    const previousPage = this.#pageNumber;
    const firstPage = clampPage(this.#requestedPage ?? initialPage, session.pageCount);
    this.#pageNumber = firstPage;
    this.dataset.currentPage = String(firstPage);
    this.#setDocumentState("ready");
    const navigation = this.#navigation;
    this.#emit("pv-document-loaded", { pageCount: session.pageCount, pageLabels: session.pageLabels });
    // A listener may already have navigated or closed the document, and that has to win.
    if (session === this.#session && navigation === this.#navigation) {
      await this.#showPage(session, firstPage, previousPage);
    }
  }

  async close(): Promise<void> {
    this.#openAttempt = {};
    this.#opening = undefined;
    this.#setDocumentState("idle");
    await this.#closeDocument();
  }

  /**
   * Turns to a page, and resolves once it's shown. While a document is opening, it opens on this page instead, and this
   * resolves once that document is shown.
   */
  async goToPage(pageNumber: number): Promise<void> {
    if (this.#session === undefined && this.#opening !== undefined) {
      this.#requestedPage = pageNumber;
      await this.#opening;
    } else if (this.#session !== undefined) {
      await this.#showPage(this.#session, clampPage(pageNumber, this.#session.pageCount));
    }
  }

  /** Turns to an object's page if it isn't displayed, then scrolls only as far as it takes to show the object. */
  async scrollObjectIntoView(id: string): Promise<void> {
    const object = this.#store.get(id);
    if (object === undefined) {
      throw new Error(`No object with id "${id}" exists.`);
    }
    if (object.page !== null && object.page !== this.#view?.pageNumber) {
      await this.goToPage(object.page);
    }
    this.#view?.objects.scrollIntoView(id);
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
    const rotation = degrees === null ? null : normalizeRotation(degrees);
    (await this.#openedSession())?.setPageRotation(pageNumber, rotation);
    if (pageNumber === this.#pageNumber) {
      await this.#renderCurrentPage();
    }
  }

  /** The original document's bytes. For a URL source, this fetches whatever hasn't been fetched yet. */
  async getDocumentData(): Promise<Uint8Array> {
    return (await this.#requireSession()).getData();
  }

  /** Throws for draw defaults the store would refuse, so the mistake surfaces here rather than when the user draws. */
  setTool(tool: ViewerTool, defaults: DrawDefaults = {}): void {
    if (defaults.appData !== undefined) {
      checkAppDataKeys(defaults.appData);
    }
    this.#tool = tool;
    this.#drawDefaults = defaults;
    this.dataset.tool = tool;
    this.#applyTool();
  }

  /** Adds an object. Throws if its id is taken. */
  addObject(object: NewPageObject): PageObject {
    return this.#store.add(object, "api");
  }

  /** Adds an object, or replaces the one with its id. */
  upsertObject(object: NewPageObject): PageObject {
    return this.#store.upsert(object, "api");
  }

  /** Changes the given fields of an object. Throws if it doesn't exist. */
  updateObject(id: string, patch: ObjectPatch): PageObject {
    return this.#store.update(id, patch, "api");
  }

  /** Removes an object if it exists, and returns whether it did. */
  removeObject(id: string): boolean {
    return this.#store.remove(id, "api");
  }

  /** Makes these the only objects. Only what differs from the objects already there changes or is reported. */
  setObjects(objects: readonly NewPageObject[]): void {
    this.#store.replaceAll(objects, "api");
  }

  /**
   * Adds, replaces and removes several objects as one change, raising one pv-objects-changed event, or none if nothing
   * differs.
   */
  applyObjects(batch: ObjectBatch): void {
    this.#store.apply(batch, "api");
  }

  /**
   * Adds a drawn object that a pv-object-drawn listener kept as a draft, reported as a change the user made. Returns
   * whether there was such a draft.
   */
  commitDraft(id: string): boolean {
    return this.#store.commitDraft(id);
  }

  /** Drops a drawn object that a pv-object-drawn listener kept as a draft. Returns whether there was such a draft. */
  discardDraft(id: string): boolean {
    return this.#store.discardDraft(id);
  }

  /** Selects one object, or none when given null. */
  selectObject(id: string | null): void {
    this.#store.select(id === null ? [] : [id], "api");
  }

  /** Selects exactly these objects. Handles appear only when one object is selected. */
  selectObjects(ids: readonly string[]): void {
    this.#store.select(ids, "api");
  }

  /** Reads any object, including those on pages that are not displayed and so have no element. */
  getObject(id: string): PageObject | undefined {
    return this.#store.get(id);
  }

  getObjects(): PageObject[] {
    return this.#store.all();
  }

  /** A page's label, and its size and rotation in the coordinates objects use, whether or not it's displayed. */
  async getPageInfo(pageNumber: number): Promise<PageInfo> {
    const session = await this.#requireSession();
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > session.pageCount) {
      throw new RangeError(`Page must be from 1 to ${session.pageCount}, but was ${pageNumber}.`);
    }
    const page = await session.getPage(pageNumber);
    try {
      const viewRotation = session.viewRotation(page, pageNumber, this.#rotation);
      const { width, height } = this.#objectGeometry(page, viewRotation);
      const label = session.pageLabels?.[pageNumber - 1] ?? null;
      return { page: pageNumber, label, width, height, rotation: page.geometry(viewRotation).rotation };
    } finally {
      page.release();
    }
  }

  /**
   * Where a point on the displayed page is in the browser viewport, in the coordinates of clientX and clientY. Returns
   * undefined unless that page is the one displayed.
   */
  pageToClient(pageNumber: number, point: Point): Point | undefined {
    const view = this.#view;
    if (view === undefined || this.#session === undefined || pageNumber !== view.pageNumber) {
      return undefined;
    }
    const geometry = this.#viewGeometry(this.#session, view);
    const size = displaySize(geometry);
    const displayed = pageToDisplay(geometry, point);
    const bounds = view.element.getBoundingClientRect();
    return {
      x: bounds.left + (displayed.x / size.width) * bounds.width,
      y: bounds.top + (displayed.y / size.height) * bounds.height,
    };
  }

  async #showPage(session: DocumentSession, pageNumber: number, previousPage = this.#pageNumber): Promise<void> {
    const navigation = this.#navigation = {};
    let page: EnginePage;
    try {
      page = await session.getPage(pageNumber);
    } catch (error) {
      if (navigation === this.#navigation && session === this.#session) {
        await this.#onPageFailed(error);
      }
      return;
    }
    if (navigation !== this.#navigation || session !== this.#session) {
      page.release();
      return;
    }
    const changed = previousPage !== pageNumber;
    this.#pageNumber = pageNumber;
    this.dataset.currentPage = String(pageNumber);
    const geometry = this.#objectGeometry(page, session.viewRotation(page, pageNumber, this.#rotation));
    const view = new PageView(pageNumber, page, geometry, this.#store, this.#controller!.presentation, {
      onRendered: (scale) => this.#emit("pv-page-rendered", { page: pageNumber, scale }),
      onRenderError: (error) => this.#emitError("render", error),
    });
    this.#replaceView(view);
    this.#viewport!.replaceChildren(view.element);
    const rendered = this.#renderCurrentPage();
    // Listeners hear about the page before it finishes painting, so they can replace its objects without waiting.
    if (changed) {
      this.#emit("pv-page-change", { page: pageNumber });
    }
    await rendered;
  }

  /** A document that can't show its first page has failed and closes. Otherwise the page already on screen stays there. */
  async #onPageFailed(error: unknown): Promise<void> {
    if (this.#view !== undefined) {
      this.#emitError("page", error);
      return;
    }
    const attempt = this.#openAttempt;
    await this.#closeDocument();
    if (attempt === this.#openAttempt) {
      this.#fail(error);
    }
  }

  /** The space object rectangles are measured in. Display space is just a page that isn't rotated any further. */
  #objectGeometry(page: EnginePage, viewRotation: Rotation): PageGeometry {
    return this.#options.coordinates === "display"
      ? { ...page.cssSize(1, viewRotation), rotation: 0 }
      : page.geometry(viewRotation);
  }

  #viewGeometry(session: DocumentSession, view: PageView): PageGeometry {
    return this.#objectGeometry(view.page, session.viewRotation(view.page, view.pageNumber, this.#rotation));
  }

  /** Shows a page's view instead of the current one, ending any gesture on the one it replaces. */
  #replaceView(view: PageView | undefined): void {
    if (this.#view !== undefined) {
      this.#controller!.detach(this.#view);
      this.#view.dispose();
    }
    this.#view = view;
    if (view !== undefined) {
      this.#controller!.attach(view);
    }
  }

  #applyTool(): void {
    this.#controller?.setTool(this.#tool, this.#drawDefaults);
  }

  /** Works out the displayed page's zoom and rotation, and has it repaint. */
  async #renderCurrentPage(): Promise<void> {
    const view = this.#view;
    const session = this.#session;
    if (view === undefined || session === undefined) {
      return;
    }
    const viewRotation = session.viewRotation(view.page, view.pageNumber, this.#rotation);
    const scale = this.#resolveScale(view.page, viewRotation);
    if (scale === undefined) {
      // There's no size to fit yet, usually because the viewer is hidden, so the resize observer renders it once there
      // is. Observing again forgets the last size, because hiding and showing within one frame would otherwise look like
      // no change. That only works at no size at all: anything else would count as a change and fire again every frame.
      view.markPending();
      if (this.#viewport!.clientWidth === 0 && this.#viewport!.clientHeight === 0) {
        this.#resizeObserver!.unobserve(this.#viewport!);
        this.#resizeObserver!.observe(this.#viewport!);
      }
      return;
    }
    this.#scale = scale;
    this.dataset.zoom = String(scale);
    const geometry = this.#objectGeometry(view.page, viewRotation);
    await view.render({ scale, viewRotation, geometry, hideFormFields: this.#options.hideFormFields });
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
    const element = this.#view?.element;
    if (!event.ctrlKey || !this.#options.wheelZoom || element === undefined) {
      return;
    }
    event.preventDefault();
    if (this.#scale === undefined) {
      return;
    }
    const before = element.getBoundingClientRect();
    const fractionX = (event.clientX - before.left) / before.width;
    const fractionY = (event.clientY - before.top) / before.height;

    void this.setZoom(this.#scale * Math.exp(-event.deltaY * wheelZoomRate));

    const after = element.getBoundingClientRect();
    this.#viewport!.scrollLeft += after.left + fractionX * after.width - event.clientX;
    this.#viewport!.scrollTop += after.top + fractionY * after.height - event.clientY;
  }

  /** Brings the page up to date before listeners hear of the change. */
  #onObjectsChanged(change: ObjectsChanged): void {
    this.dataset.lastChange = String(change.sequence);
    const changed = [...change.added, ...change.removed, ...change.updated.map((update) => update.object)];
    this.#view?.objects.syncObjects(changed.map(({ id }) => id));
    this.#controller?.objectsChanged();
    this.#emit("pv-objects-changed", change);
  }

  #onSelectionChanged(change: SelectionChanged): void {
    this.dataset.selectedObject = change.primaryId ?? "";
    this.#view?.objects.syncSelection();
    this.#emit("pv-selection-change", change);
  }

  /**
   * Shows the draft, then asks listeners what becomes of it. One that cancels the event keeps it as a draft, and
   * commits or discards it later. Otherwise it's committed at once.
   */
  #onDraftAdded(draft: PageObject): void {
    this.#view?.objects.syncDrafts();
    if (this.#emit("pv-object-drawn", { object: draft }, true)) {
      this.#store.commitDraft(draft.id);
    }
  }

  /**
   * Updates the shown drafts, and selects a committed draft when selectOnCreate is on. The application may have
   * committed it as hidden or unselectable, and then it isn't selected.
   */
  #onDraftResolved(id: string, committed: boolean): void {
    this.#view?.objects.syncDrafts();
    const object = this.#store.get(id);
    if (committed && this.#options.selectOnCreate && object?.selectable && !object.hidden) {
      this.#store.select([id], "user");
    }
  }

  async #closeDocument(): Promise<void> {
    this.#navigation = undefined;
    this.#replaceView(undefined);
    this.#store.clear("api");
    const closing = this.#session;
    this.#session = undefined;
    this.#scale = undefined;
    delete this.dataset.pageCount;
    delete this.dataset.currentPage;
    delete this.dataset.zoom;
    await closing?.destroy();
  }

  /** The open document, after waiting for one being opened, so a command sent while it loads applies to it. */
  async #openedSession(): Promise<DocumentSession | undefined> {
    if (this.#session === undefined) {
      await this.#opening;
    }
    return this.#session;
  }

  async #requireSession(): Promise<DocumentSession> {
    const session = await this.#openedSession();
    if (session === undefined) {
      throw new Error("No document is open.");
    }
    return session;
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

  /** Returns false if the event could be canceled and a listener canceled it. */
  #emit<Type extends keyof PvEventMap>(type: Type, detail: PvEventMap[Type], cancelable = false): boolean {
    return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, cancelable }));
  }
}

function toolOptions({ keyboardEditing, roundCoordinates }: ResolvedOptions): ToolOptions {
  return { keyboardEditing, roundCoordinates };
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.trunc(page), 1), pageCount);
}
