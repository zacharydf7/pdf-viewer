import { DocumentSession } from "./document-session.js";
import type { DocumentSource, EngineDocument, EnginePage } from "./engine.js";
import { DocumentError, openDocument } from "./engine.js";
import type { PageInfo, PvEventMap } from "./events.js";
import { errorMessage } from "./events.js";
import type { PageGeometry, Point, Rotation, Size } from "./geometry.js";
import { displaySize, displayToPage, fitScale, moveRect, normalizeRotation, pageToDisplay } from "./geometry.js";
import { InteractionController } from "./interaction-controller.js";
import type { NewPageObject, ObjectBatch, ObjectPatch, ObjectsChanged, PageObject, SelectionChanged }
  from "./object-store.js";
import { checkAppDataKeys, ObjectStore } from "./object-store.js";
import { PageView } from "./page-view.js";
import type { DrawDefaults, ToolOptions, ViewerTool } from "./tool.js";
import { commitRect } from "./tool.js";
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
  #readOnly = false;
  #keyboardScope: Element | null = null;
  /** How many page turns are under way, from fetching the page until it has rendered. */
  #turns = 0;
  /** Where screen readers hear about changes they can't otherwise perceive, such as an object moved with a key. */
  #announcer: HTMLElement | undefined;

  connectedCallback(): void {
    if (this.#viewport !== undefined) {
      // Coming back after a teardown, which let go of the keyboard scope.
      this.#controller!.keyboardScope = this.#keyboardScope;
      return;
    }
    this.classList.add("pv-viewer");
    // The application can name the viewer itself, with aria-label or aria-labelledby.
    if (!this.hasAttribute("role")) {
      this.setAttribute("role", "region");
    }
    if (!this.hasAttribute("aria-label") && !this.hasAttribute("aria-labelledby")) {
      this.setAttribute("aria-label", "PDF viewer");
    }
    this.dataset.documentState = "idle";
    this.dataset.tool = this.#tool;
    this.dataset.readonly = String(this.#readOnly);
    this.dataset.objectHitArea = this.#options.objectHitArea;
    this.dataset.selectedObject = "";
    this.dataset.lastChange = "0";
    this.#viewport = document.createElement("div");
    this.#viewport.className = "pv-viewport";
    // A tab stop, so keyboard users can scroll a page that's zoomed past the viewer with the arrow keys.
    this.#viewport.tabIndex = 0;
    this.#announcer = document.createElement("div");
    this.#announcer.className = "pv-announcer";
    this.#announcer.setAttribute("aria-live", "polite");
    this.append(this.#viewport, this.#announcer);
    this.#resizeObserver = new ResizeObserver(() => this.#onResize());
    this.#resizeObserver.observe(this.#viewport);
    // Not passive, because it has to stop the browser from zooming the whole page.
    this.#viewport.addEventListener("wheel", (event) => this.#onWheel(event), { passive: false });
    this.#controller = new InteractionController(this.#viewport, this.#store, toolOptions(this.#options), {
      requestDelete: (id) => this.#onDeleteRequested(id),
      announceEdit: (id, resized) => this.#announceEdit(id, resized),
    });
    this.#controller.keyboardScope = this.#keyboardScope;
    this.#applyTool();
  }

  /**
   * Applies the options given. Any left out keep their current values. They take effect at once without ending a
   * gesture, and the page repaints only for options that change how it's painted or measured. A new initial zoom takes
   * effect at once while no document is open, and otherwise when the next document opens, unless keepZoom is on.
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
        this.#controller?.dispose();
        void this.close();
      }
    });
  }

  /**
   * An element outside the viewer where the keys that move and resize objects also work, acting on the selected
   * object, for example the part of the application around the viewer. Keys pressed in a field that uses arrow keys
   * itself, such as a text box, are left alone. Null, the default, keeps those keys to the viewer itself.
   */
  get keyboardScope(): Element | null {
    return this.#keyboardScope;
  }

  set keyboardScope(element: Element | null) {
    this.#keyboardScope = element;
    if (this.#controller !== undefined) {
      this.#controller.keyboardScope = element;
    }
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

  /**
   * Whether the user is kept from selecting, drawing and editing objects, for example while the application shows a
   * dialog. Objects marked editableWhenReadOnly are the exception: the user can still select and edit those. Objects,
   * the selection and the tool stay as they are, and the tool works again once this is turned off. The application's
   * own calls still change objects and the selection.
   */
  get readOnly(): boolean {
    return this.#readOnly;
  }

  set readOnly(readOnly: boolean) {
    this.#readOnly = readOnly;
    this.dataset.readonly = String(readOnly);
    this.#applyTool();
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
    // Before anything is awaited, so a zoom set while this document loads applies to it.
    if (!this.#options.keepZoom) {
      this.#zoom = this.#options.initialZoom;
    }
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
    // The first page's turn counts from here, so the viewer doesn't look idle while listeners hear the document loaded.
    this.#turns++;
    try {
      this.#setDocumentState("ready");
      const navigation = this.#navigation;
      this.#emit("pv-document-loaded", { pageCount: session.pageCount, pageLabels: session.pageLabels });
      // A listener may already have navigated or closed the document, and that has to win.
      if (session === this.#session && navigation === this.#navigation) {
        await this.#showPage(session, firstPage, previousPage);
      }
    } finally {
      this.#turns--;
      this.#updateBusy();
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
    const object = this.#requireObject(id);
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
    if (tool === "draw-rect" && defaults.kind !== undefined) {
      this.dataset.toolKind = defaults.kind;
    } else {
      delete this.dataset.toolKind;
    }
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

  /**
   * Moves an object as an arrow key does: by a distance as displayed, so positive x is right and positive y is down
   * on screen at any rotation. The object stays on its page, a locked or hidden object doesn't move, and the move is
   * reported as the user's nudge. Resolves to the object as it is afterward, and rejects if it doesn't exist.
   */
  async moveObjectBy(id: string, deltaX: number, deltaY: number): Promise<PageObject> {
    const pageOf = (object: PageObject) => object.page ?? this.#pageNumber;
    const measured = pageOf(this.#requireObject(id));
    const geometry = await this.#geometryOfPage(measured);
    // Read again, because the object can change or go while its page loads. If it's on another page by now, that
    // page is the one to measure.
    const object = this.#requireObject(id);
    if (pageOf(object) !== measured) {
      return this.moveObjectBy(id, deltaX, deltaY);
    }
    if (!object.locked && !object.hidden) {
      const moved = moveRect(geometry, object.rect, deltaX, deltaY);
      commitRect(this.#store, id, moved, "nudge", geometry, this.#options.roundCoordinates);
    }
    return this.#requireObject(id);
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
    const shown = this.#shownPage(pageNumber);
    if (shown === undefined) {
      return undefined;
    }
    const { geometry, size, bounds } = shown;
    const displayed = pageToDisplay(geometry, point);
    return {
      x: bounds.left + (displayed.x / size.width) * bounds.width,
      y: bounds.top + (displayed.y / size.height) * bounds.height,
    };
  }

  /**
   * Where a point in the browser viewport is on the displayed page, in the coordinates objects use. This reverses
   * `pageToClient`. Returns undefined unless that page is the one displayed.
   */
  clientToPage(pageNumber: number, point: Point): Point | undefined {
    const shown = this.#shownPage(pageNumber);
    if (shown === undefined) {
      return undefined;
    }
    const { geometry, size, bounds } = shown;
    return displayToPage(geometry, {
      x: ((point.x - bounds.left) / bounds.width) * size.width,
      y: ((point.y - bounds.top) / bounds.height) * size.height,
    });
  }

  /** The displayed page's geometry and where it is on screen, or undefined unless the page is the one displayed. */
  #shownPage(pageNumber: number): { geometry: PageGeometry; size: Size; bounds: DOMRect } | undefined {
    const view = this.#view;
    if (view === undefined || this.#session === undefined || pageNumber !== view.pageNumber) {
      return undefined;
    }
    const geometry = this.#viewGeometry(this.#session, view);
    return { geometry, size: displaySize(geometry), bounds: view.element.getBoundingClientRect() };
  }

  /** Counts the turn as busy until its page has rendered, or the turn has failed or been replaced. */
  async #showPage(session: DocumentSession, pageNumber: number, previousPage = this.#pageNumber): Promise<void> {
    this.#turns++;
    this.#updateBusy();
    try {
      await this.#turnTo(session, pageNumber, previousPage);
    } finally {
      this.#turns--;
      this.#updateBusy();
    }
  }

  async #turnTo(session: DocumentSession, pageNumber: number, previousPage: number): Promise<void> {
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
      onBusyChanged: () => this.#updateBusy(),
    });
    this.#replaceView(view);
    this.#viewport!.replaceChildren(view.element);
    // Another page starts at its top left, rather than where the last one was scrolled to. A new document already does,
    // because closing the last one emptied the viewport.
    if (changed) {
      this.#viewport!.scrollTop = 0;
      this.#viewport!.scrollLeft = 0;
    }
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

  /** The space objects on a page are measured in, whether or not the page is displayed. */
  async #geometryOfPage(pageNumber: number): Promise<PageGeometry> {
    if (this.#view?.pageNumber === pageNumber) {
      return this.#view.objects.geometry;
    }
    const session = await this.#requireSession();
    const page = await session.getPage(pageNumber);
    try {
      return this.#objectGeometry(page, session.viewRotation(page, pageNumber, this.#rotation));
    } finally {
      page.release();
    }
  }

  #requireObject(id: string): PageObject {
    const object = this.#store.get(id);
    if (object === undefined) {
      throw new Error(`No object with id "${id}" exists.`);
    }
    return object;
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
    this.#updateBusy();
  }

  /**
   * Sets data-busy while a document is loading, a page turn is under way, or the page shown is rendering or extracting
   * its text, so it's absent exactly when the viewer is idle.
   */
  #updateBusy(): void {
    const busy = this.dataset.documentState === "loading" || this.#turns > 0 || (this.#view?.busy ?? false);
    this.toggleAttribute("data-busy", busy);
  }

  /** The chosen tool is kept while the viewer is read-only, for when that ends. */
  #applyTool(): void {
    this.#controller?.setTool(this.#tool, this.#drawDefaults, this.#readOnly);
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
   * Asks listeners whether the user may delete an object. One that cancels the event takes the decision over, and
   * removes the object itself if it agrees. Otherwise the object is removed at once, as the user's change.
   */
  #onDeleteRequested(id: string): void {
    if (this.#emit("pv-delete-requested", { object: this.#requireObject(id) }, true)) {
      this.#store.remove(id, "user");
    }
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
    this.#updateBusy();
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

  /**
   * Tells screen readers where a key moved an object, or what size it resized it to, in the coordinates the viewer is
   * set to use.
   */
  #announceEdit(id: string, resized: boolean): void {
    const object = this.#store.get(id);
    if (object === undefined || this.#announcer === undefined) {
      return;
    }
    const { x, y, width, height } = object.rect;
    const name = this.#view?.objects.nameOf(id) ?? id;
    this.#announcer.textContent = resized
      ? `${name} resized to ${formatNumber(width)} by ${formatNumber(height)}`
      : `${name} moved to ${formatNumber(x)}, ${formatNumber(y)}`;
  }

  /** Returns false if the event could be canceled and a listener canceled it. */
  #emit<Type extends keyof PvEventMap>(type: Type, detail: PvEventMap[Type], cancelable = false): boolean {
    return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, cancelable }));
  }
}

function toolOptions({ keyboardEditing, keyboardStep, keyboardLargeStep, keyboardMoveModifier,
  keyboardLargeStepModifier, selectOnFocus, roundCoordinates }: ResolvedOptions): ToolOptions {
  return { keyboardEditing, keyboardStep, keyboardLargeStep, keyboardMoveModifier, keyboardLargeStepModifier,
    selectOnFocus, roundCoordinates };
}

/** A coordinate as a screen reader should read it: to one decimal place at most. */
function formatNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(Math.trunc(page), 1), pageCount);
}
