import { DrawRectTool } from "./draw-rect-tool.js";
import type { PageGeometry, Rect, ResizeHandle } from "./geometry.js";
import { fractionToPage, pageRectToPercent } from "./geometry.js";
import type { ObjectStore, PageObject } from "./object-store.js";
import { SelectTool } from "./select-tool.js";
import type { PointerInput, PointerTarget, Preview, Tool, ToolOptions, ToolPresentation, ViewerTool } from "./tool.js";

const handles: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** With no tool, objects ignore the pointer and the keyboard. */
const inactive: ToolPresentation = { focusable: false, handles: false };

/**
 * Displays one page's objects as real DOM elements and passes pointer and keyboard input for them to the active tool.
 *
 * Geometry is percent-based inside a page that CSS scales, so zooming writes no per-object styles. The page space
 * rectangle in the store is the source of truth, and on-screen values are only ever derived from it.
 */
export class ObjectLayer {
  readonly element: HTMLElement;
  readonly #objectsElement: HTMLElement;
  readonly #handlesElement: HTMLElement;
  readonly #objectElements = new Map<string, HTMLElement>();
  /** What each element last displayed, so unchanged objects cost nothing to bring up to date. */
  readonly #appliedStates = new Map<string, string>();
  readonly #page: HTMLElement;
  readonly #pageNumber: number;
  readonly #store: ObjectStore;
  readonly #abort = new AbortController();
  #geometry: PageGeometry;
  #tool: Tool | undefined;
  #presentation: ToolPresentation = inactive;
  /** Whether a press started a gesture that hasn't ended, so moves go to the tool. */
  #pressed = false;
  #shownSelection: readonly string[] = [];
  /** The object whose handles are shown. */
  #handlesFor: string | undefined;
  /** An object a gesture is showing away from where the store has it. */
  #movedObject: { id: string; rect: Rect } | undefined;
  #draft: HTMLElement | undefined;

  constructor(page: HTMLElement, pageNumber: number, geometry: PageGeometry, store: ObjectStore) {
    this.#page = page;
    this.#pageNumber = pageNumber;
    this.#geometry = geometry;
    this.#store = store;

    this.element = document.createElement("div");
    this.element.className = "pv-object-layer";
    this.#objectsElement = document.createElement("div");
    this.#objectsElement.className = "pv-objects";
    this.#objectsElement.setAttribute("aria-label", `Objects on page ${pageNumber}`);
    this.#handlesElement = document.createElement("div");
    this.#handlesElement.className = "pv-handles";
    this.#handlesElement.setAttribute("aria-hidden", "true");
    this.element.append(this.#objectsElement, this.#handlesElement);
    page.append(this.element);

    const { signal } = this.#abort;
    page.addEventListener("pointerdown", (event) => this.#onPointerDown(event), { signal });
    page.addEventListener("pointermove", (event) => this.#onPointerMove(event), { signal });
    page.addEventListener("pointerup", (event) => this.#onPointerUp(event), { signal });
    page.addEventListener("pointercancel", () => this.#cancelGesture(), { signal });
    this.element.addEventListener("keydown", (event) => this.#onKeyDown(event), { signal });
    this.element.addEventListener("focusin", (event) => this.#onFocusIn(event), { signal });
    // On the window, because a gesture doesn't always leave focus inside the viewer, and in the capture phase so that
    // canceling a gesture comes before anything a focused object or the application does with the same key.
    window.addEventListener("keydown", (event) => this.#onWindowKeyDown(event), { signal, capture: true });
    this.#startTool("select", { keyboardEditing: true, roundCoordinates: false, drawDefaults: {} });
    this.sync();
  }

  set geometry(geometry: PageGeometry) {
    const { width, height, rotation } = this.#geometry;
    if (geometry.width !== width || geometry.height !== height || geometry.rotation !== rotation) {
      this.#geometry = geometry;
      this.#appliedStates.clear();
      this.sync();
    }
  }

  /** Starts a tool with these options, canceling any gesture the previous tool had under way. */
  setTool(tool: ViewerTool, options: ToolOptions): void {
    this.#cancelGesture();
    this.#startTool(tool, options);
    this.sync();
  }

  dispose(): void {
    this.#abort.abort();
    this.element.remove();
  }

  /** Brings the DOM in line with the store, keeping existing elements so focus survives updates. */
  sync(): void {
    const objects = this.#store.forPage(this.#pageNumber);
    this.#page.dataset.objectCount = String(objects.length);

    const ids = new Set(objects.map((object) => object.id));
    for (const [id, element] of this.#objectElements) {
      if (!ids.has(id)) {
        this.#removeElement(id, element);
      }
    }
    for (const object of objects) {
      this.#applyObject(object);
    }
    this.#syncListboxRole(objects.length);
    this.#shownSelection = this.#store.selectedIds;
    this.#syncHandles();
    this.#tool?.objectsChanged?.();
  }

  /** Brings one object up to date after a change, without visiting the others. */
  syncObject(id: string): void {
    const object = this.#store.get(id);
    if (object?.page === this.#pageNumber) {
      this.#applyObject(object);
    } else {
      const element = this.#objectElements.get(id);
      if (element !== undefined) {
        this.#removeElement(id, element);
      }
    }
    const count = this.#objectElements.size;
    this.#page.dataset.objectCount = String(count);
    this.#syncListboxRole(count);
    if (this.#store.primarySelectedId === id) {
      this.#syncHandles();
    }
    this.#tool?.objectsChanged?.();
  }

  /** Updates only the objects whose selected state changed, which matters on pages with hundreds of objects. */
  syncSelection(): void {
    const changed = new Set(this.#shownSelection);
    for (const id of this.#store.selectedIds) {
      // An id in both selections hasn't changed, and one in only the new selection has.
      if (!changed.delete(id)) {
        changed.add(id);
      }
    }
    for (const id of changed) {
      const object = this.#store.get(id);
      if (object?.page === this.#pageNumber) {
        this.#applyObject(object);
      }
    }
    this.#shownSelection = this.#store.selectedIds;
    this.#syncHandles();
  }

  #startTool(tool: ViewerTool, options: ToolOptions): void {
    const context = { store: this.#store, show: (preview: Preview | undefined) => this.#showPreview(preview) };
    this.#tool = tool === "select" ? new SelectTool(context, options)
      : tool === "draw-rect" ? new DrawRectTool(context, options)
        : undefined;
    this.#presentation = this.#tool?.presentation ?? inactive;
    this.element.dataset.tool = tool;
  }

  #removeElement(id: string, element: HTMLElement): void {
    element.remove();
    this.#objectElements.delete(id);
    this.#appliedStates.delete(id);
  }

  #syncListboxRole(count: number): void {
    const hasRole = this.#objectsElement.hasAttribute("role");
    if (count > 0 && !hasRole) {
      this.#objectsElement.setAttribute("role", "listbox");
    } else if (count === 0 && hasRole) {
      this.#objectsElement.removeAttribute("role");
    }
  }

  #applyObject(object: PageObject): void {
    const selected = this.#store.isSelected(object.id);
    const focusable = object.selectable && this.#presentation.focusable;
    const state = JSON.stringify([object, selected, focusable]);
    if (this.#appliedStates.get(object.id) === state) {
      return;
    }
    this.#appliedStates.set(object.id, state);

    let element = this.#objectElements.get(object.id);
    if (element === undefined) {
      element = document.createElement("div");
      element.className = "pv-object";
      element.setAttribute("role", "option");
      element.dataset.objectId = object.id;
      this.#objectElements.set(object.id, element);
      this.#objectsElement.append(element);
    }
    this.#position(element, object.rect);
    const { x, y, width, height } = object.rect;
    element.dataset.pageRect = [x, y, width, height].map(formatNumber).join(",");
    element.dataset.objectKind = object.kind;
    if (object.tag === undefined) {
      delete element.dataset.objectTag;
    } else {
      element.dataset.objectTag = object.tag;
    }
    element.dataset.locked = String(object.locked);
    element.dataset.selectable = String(object.selectable);
    element.setAttribute("aria-label", object.label ?? `Object on page ${this.#pageNumber}`);
    element.setAttribute("aria-selected", String(selected));
    element.tabIndex = focusable ? 0 : -1;
    element.style.setProperty("--pv-object-color", object.style?.color ?? "");
    element.style.setProperty("--pv-object-fill", object.style?.fill ?? "");
    element.style.setProperty("--pv-object-border-width", object.style?.borderWidth ?? "");
  }

  #position(element: HTMLElement, rect: Rect): void {
    const percent = pageRectToPercent(this.#geometry, rect);
    element.style.left = `${percent.x}%`;
    element.style.top = `${percent.y}%`;
    element.style.width = `${percent.width}%`;
    element.style.height = `${percent.height}%`;
  }

  /** Handles appear only when one object is selected, because they resize that object alone. */
  #syncHandles(): void {
    this.#handlesElement.replaceChildren();
    this.#handlesFor = undefined;
    const [id, ...others] = this.#store.selectedIds;
    const selected = id === undefined || others.length > 0 ? undefined : this.#store.get(id);
    if (selected === undefined || selected.page !== this.#pageNumber || selected.locked || !selected.selectable
      || !this.#presentation.handles) {
      return;
    }
    for (const handle of handles) {
      const element = document.createElement("div");
      element.className = "pv-handle";
      element.dataset.handle = handle;
      element.dataset.handleFor = selected.id;
      this.#handlesElement.append(element);
    }
    this.#handlesFor = selected.id;
    const moved = this.#movedObject;
    this.#positionHandles(moved?.id === selected.id ? moved.rect : selected.rect);
  }

  #positionHandles(rect: Rect): void {
    const percent = pageRectToPercent(this.#geometry, rect);
    handles.forEach((handle, index) => {
      const element = this.#handlesElement.children[index] as HTMLElement;
      const left = handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5;
      const top = handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5;
      element.style.left = `${percent.x + percent.width * left}%`;
      element.style.top = `${percent.y + percent.height * top}%`;
    });
  }

  #showPreview(preview: Preview | undefined): void {
    if (preview?.kind === "draft" && preview.page === this.#pageNumber) {
      if (this.#draft === undefined) {
        this.#draft = document.createElement("div");
        this.#draft.className = "pv-draft";
        this.#draft.dataset.draft = "true";
        this.element.append(this.#draft);
      }
      this.#position(this.#draft, preview.rect);
    } else {
      this.#draft?.remove();
      this.#draft = undefined;
    }

    const previous = this.#movedObject;
    const moved = this.#movedObject = preview?.kind === "object" ? preview : undefined;
    if (previous !== undefined && previous.id !== moved?.id) {
      const object = this.#store.get(previous.id);
      if (object !== undefined) {
        this.#placeObject(previous.id, object.rect);
      }
    }
    if (moved !== undefined) {
      this.#placeObject(moved.id, moved.rect);
    }
  }

  /**
   * Positions an object and its handles without touching its applied state, because that describes what the store
   * has, not a preview.
   */
  #placeObject(id: string, rect: Rect): void {
    const element = this.#objectElements.get(id);
    if (element !== undefined) {
      this.#position(element, rect);
      if (this.#handlesFor === id) {
        this.#positionHandles(rect);
      }
    }
  }

  #onPointerDown(event: PointerEvent): void {
    const tool = this.#tool;
    if (event.button !== 0 || tool === undefined) {
      return;
    }
    const { gesture, focus } = tool.pointerDown({ ...this.#pointerInput(event), target: targetOf(event.target) });
    if (gesture) {
      event.preventDefault();
      this.#page.setPointerCapture(event.pointerId);
      this.#pressed = true;
    }
    // Starting a gesture prevents the browser's default, including moving focus, so arrow keys need this after a click.
    if (focus !== undefined) {
      this.#objectElements.get(focus)?.focus({ preventScroll: true });
    }
  }

  #onPointerMove(event: PointerEvent): void {
    if (this.#pressed) {
      this.#tool!.pointerMove(this.#pointerInput(event));
    }
  }

  #onPointerUp(event: PointerEvent): void {
    if (this.#pressed) {
      this.#pressed = false;
      this.#tool!.pointerUp(this.#pointerInput(event));
    }
  }

  /** Ends any gesture without changing anything, and returns whether one was under way. */
  #cancelGesture(): boolean {
    this.#pressed = false;
    return this.#tool?.cancel() ?? false;
  }

  #onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.#cancelGesture()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  #onFocusIn(event: FocusEvent): void {
    const element = (event.target as Element).closest<HTMLElement>("[data-object-id]");
    if (element !== null) {
      this.#tool?.focus?.(element.dataset.objectId!);
    }
  }

  /** Only handled keys stop propagating, so a host application's own shortcuts keep working. */
  #onKeyDown(event: KeyboardEvent): void {
    const element = (event.target as Element).closest<HTMLElement>("[data-object-id]");
    if (element === null) {
      return;
    }
    const { key, shiftKey, ctrlKey } = event;
    const input = { id: element.dataset.objectId!, geometry: this.#geometry, key, shiftKey, ctrlKey };
    if (this.#tool?.keyDown?.(input)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  #pointerInput(event: PointerEvent): PointerInput {
    const bounds = this.#page.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    return { page: this.#pageNumber, geometry: this.#geometry, point: fractionToPage(this.#geometry, x, y) };
  }
}

function targetOf(target: EventTarget | null): PointerTarget | undefined {
  const handle = (target as Element).closest<HTMLElement>("[data-handle]");
  if (handle !== null) {
    return { kind: "handle", id: handle.dataset.handleFor!, handle: handle.dataset.handle as ResizeHandle };
  }
  const object = (target as Element).closest<HTMLElement>("[data-object-id]");
  return object === null ? undefined : { kind: "object", id: object.dataset.objectId! };
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
