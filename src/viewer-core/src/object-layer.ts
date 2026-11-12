import type { PageGeometry, Point, Rect, ResizeHandle } from "./geometry.js";
import { clampPoint, displaySize, fractionToPage, moveRect, pageRectToPercent, rectFromCorners, resizeRectBy,
  roundRect } from "./geometry.js";
import { rectAfterArrowKey } from "./keyboard-editing.js";
import type { ObjectStore, ObjectStyle, PageObject } from "./object-store.js";

export type ViewerTool = "select" | "draw-rect" | "none";

const handles: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const minimumDrawSize = 2;
const minimumResizeSize = 1;

type Drag =
  | { kind: "draw"; start: Point; current: Point }
  | { kind: "move"; id: string; start: Point; original: Rect; rect: Rect; moved: boolean }
  | { kind: "resize"; id: string; handle: ResizeHandle; start: Point; original: Rect; rect: Rect; moved: boolean };

export interface DrawDefaults {
  style?: ObjectStyle;
  label?: string;
  tag?: string;
}

/**
 * Displays one page's objects as real DOM elements and handles pointer and keyboard input for them.
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
  #tool: ViewerTool = "select";
  #drawDefaults: DrawDefaults = {};
  #keyboardEditing = true;
  #roundCoordinates = false;
  #shownSelection: string | null = null;
  #drag: Drag | undefined;
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
    page.addEventListener("pointercancel", () => this.#cancelDrag(), { signal });
    this.element.addEventListener("keydown", (event) => this.#onKeyDown(event), { signal });
    this.element.addEventListener("focusin", (event) => this.#onFocusIn(event), { signal });
    // On the window, because a gesture doesn't always leave focus inside the viewer, and in the capture phase so that
    // canceling a gesture comes before anything a focused object or the application does with the same key.
    window.addEventListener("keydown", (event) => this.#onWindowKeyDown(event), { signal, capture: true });
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

  set drawDefaults(defaults: DrawDefaults) {
    this.#drawDefaults = defaults;
  }

  /** Whether arrow keys and Delete edit the focused object. When off, those keys go to the host application. */
  set keyboardEditing(enabled: boolean) {
    this.#keyboardEditing = enabled;
  }

  /** Whether rectangles the user creates or changes are rounded to whole page units. */
  set roundCoordinates(enabled: boolean) {
    this.#roundCoordinates = enabled;
  }

  set tool(tool: ViewerTool) {
    this.#cancelDrag();
    this.#tool = tool;
    this.element.dataset.tool = tool;
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
    this.#shownSelection = this.#store.selectedId;
    this.#syncHandles();
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
    if (this.#store.selectedId === id) {
      this.#syncHandles();
    }
  }

  /** Updates only the objects whose selected state changed, which matters on pages with hundreds of objects. */
  syncSelection(): void {
    for (const id of [this.#shownSelection, this.#store.selectedId]) {
      const object = id === null ? undefined : this.#store.get(id);
      if (object?.page === this.#pageNumber) {
        this.#applyObject(object);
      }
    }
    this.#shownSelection = this.#store.selectedId;
    this.#syncHandles();
  }

  #removeElement(id: string, element: HTMLElement): void {
    if (this.#drag !== undefined && this.#drag.kind !== "draw" && this.#drag.id === id) {
      this.#drag = undefined;
    }
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
    const selected = this.#store.selectedId === object.id;
    const state = JSON.stringify([object, selected, this.#tool]);
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
    element.tabIndex = object.selectable && this.#tool !== "none" ? 0 : -1;
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

  #syncHandles(): void {
    this.#handlesElement.replaceChildren();
    const selected = this.#store.selectedId === null ? undefined : this.#store.get(this.#store.selectedId);
    if (selected === undefined || selected.page !== this.#pageNumber || selected.locked || !selected.selectable
      || this.#tool !== "select") {
      return;
    }
    const rect = this.#currentRect(selected);
    for (const handle of handles) {
      const element = document.createElement("div");
      element.className = "pv-handle";
      element.dataset.handle = handle;
      element.dataset.handleFor = selected.id;
      this.#handlesElement.append(element);
    }
    this.#positionHandles(rect);
  }

  #positionHandles(rect: Rect): void {
    const percent = pageRectToPercent(this.#geometry, rect);
    for (const element of this.#handlesElement.children as HTMLCollectionOf<HTMLElement>) {
      const handle = element.dataset.handle as ResizeHandle;
      const left = handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5;
      const top = handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5;
      element.style.left = `${percent.x + percent.width * left}%`;
      element.style.top = `${percent.y + percent.height * top}%`;
    }
  }

  #currentRect(object: PageObject): Rect {
    const drag = this.#drag;
    return drag !== undefined && drag.kind !== "draw" && drag.id === object.id ? drag.rect : object.rect;
  }

  #onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.#tool === "none") {
      return;
    }
    const target = event.target as Element;

    if (this.#tool === "draw-rect") {
      const start = this.#pointerToPage(event);
      this.#beginDrag(event, { kind: "draw", start, current: start });
      this.#draft = document.createElement("div");
      this.#draft.className = "pv-draft";
      this.#draft.dataset.draft = "true";
      this.element.append(this.#draft);
      this.#position(this.#draft, rectFromCorners(start, start));
      return;
    }

    const handle = target.closest<HTMLElement>("[data-handle]");
    if (handle !== null) {
      const { id, rect } = this.#store.get(handle.dataset.handleFor!)!;
      const name = handle.dataset.handle as ResizeHandle;
      const start = this.#pointerToDisplay(event);
      this.#beginDrag(event, { kind: "resize", id, handle: name, start, original: rect, rect, moved: false });
      this.#objectElements.get(id)?.focus({ preventScroll: true });
      return;
    }

    const objectElement = target.closest<HTMLElement>("[data-object-id]");
    if (objectElement === null) {
      this.#store.select(null, "user");
      return;
    }
    const object = this.#store.get(objectElement.dataset.objectId!)!;
    if (!object.selectable) {
      return;
    }
    this.#store.select(object.id, "user");
    if (!object.locked) {
      const { id, rect } = object;
      const start = this.#pointerToDisplay(event);
      this.#beginDrag(event, { kind: "move", id, start, original: rect, rect, moved: false });
    }
    // Starting a gesture prevents the browser's default, including moving focus, so arrow keys need this after a click.
    objectElement.focus({ preventScroll: true });
  }

  #beginDrag(event: PointerEvent, drag: Drag): void {
    event.preventDefault();
    this.#page.setPointerCapture(event.pointerId);
    this.#drag = drag;
  }

  #onPointerMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag !== undefined) {
      this.#applyPointer(drag, event);
    }
  }

  #applyPointer(drag: Drag, event: PointerEvent): void {
    if (drag.kind === "draw") {
      drag.current = this.#pointerToPage(event);
      this.#position(this.#draft!, rectFromCorners(drag.start, drag.current));
      return;
    }
    const position = this.#pointerToDisplay(event);
    const deltaX = position.x - drag.start.x;
    const deltaY = position.y - drag.start.y;
    // Converting a rectangle to display space and back can change it by rounding error, so a click must not convert.
    if (deltaX === 0 && deltaY === 0 && !drag.moved) {
      return;
    }
    drag.moved = true;
    this.#appliedStates.delete(drag.id);
    drag.rect = drag.kind === "move"
      ? moveRect(this.#geometry, drag.original, deltaX, deltaY)
      : resizeRectBy(this.#geometry, drag.original, drag.handle, deltaX, deltaY, minimumResizeSize);
    this.#position(this.#objectElements.get(drag.id)!, drag.rect);
    this.#positionHandles(drag.rect);
  }

  #onPointerUp(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined) {
      return;
    }
    this.#drag = undefined;
    // The release position counts, even if the browser delivered no move before it.
    this.#applyPointer(drag, event);
    switch (drag.kind) {
      case "draw":
        this.#commitDraw(drag.start, drag.current);
        break;
      case "move":
      case "resize":
        if (drag.moved) {
          this.#commitRect(drag.id, drag.original, drag.rect);
        }
        break;
    }
  }

  #commitDraw(start: Point, end: Point): void {
    this.#draft?.remove();
    this.#draft = undefined;
    const rect = rectFromCorners(start, end);
    if (rect.width < minimumDrawSize || rect.height < minimumDrawSize) {
      return;
    }
    const object = { id: newObjectId(), page: this.#pageNumber, rect: this.#finalRect(rect), ...this.#drawDefaults };
    const added = this.#store.add(object, "user");
    this.#store.select(added.id, "user");
  }

  /** A change that rounds back to the original isn't a change, so the element also has to return to where it was. */
  #commitRect(id: string, original: Rect, rect: Rect): void {
    const final = this.#finalRect(rect);
    if (rectsEqual(final, original)) {
      this.syncObject(id);
    } else {
      this.#store.update(id, { rect: final }, "user");
    }
  }

  #finalRect(rect: Rect): Rect {
    return this.#roundCoordinates ? roundRect(this.#geometry, rect) : rect;
  }

  #cancelDrag(): void {
    const drag = this.#drag;
    this.#drag = undefined;
    this.#draft?.remove();
    this.#draft = undefined;
    if (drag !== undefined && drag.kind !== "draw") {
      this.syncObject(drag.id);
    }
  }

  #onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.#drag !== undefined) {
      this.#cancelDrag();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  #onFocusIn(event: FocusEvent): void {
    const element = (event.target as Element).closest<HTMLElement>("[data-object-id]");
    const object = element === null ? undefined : this.#store.get(element.dataset.objectId!);
    if (object !== undefined && object.selectable && this.#tool === "select") {
      this.#store.select(object.id, "user");
    }
  }

  /** Only handled keys stop propagating, so a host application's own shortcuts keep working. */
  #onKeyDown(event: KeyboardEvent): void {
    const element = (event.target as Element).closest<HTMLElement>("[data-object-id]");
    const object = element === null ? undefined : this.#store.get(element.dataset.objectId!);
    if (!this.#keyboardEditing || this.#drag !== undefined || object === undefined || this.#tool !== "select"
      || !object.selectable) {
      return;
    }
    if (event.key === "Escape") {
      this.#store.select(null, "user");
    } else if (object.locked) {
      return;
    } else if (event.key === "Delete") {
      this.#store.remove(object.id, "user");
    } else if (event.key.startsWith("Arrow")) {
      const rect = rectAfterArrowKey(this.#geometry, object.rect, event, minimumResizeSize);
      this.#commitRect(object.id, object.rect, rect);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  #pointerToPage(event: PointerEvent): Point {
    const { x, y } = this.#pointerToFraction(event);
    return clampPoint(this.#geometry, fractionToPage(this.#geometry, x, y));
  }

  /** The pointer's position in display space, which has the same scale as page space but matches the screen. */
  #pointerToDisplay(event: PointerEvent): Point {
    const { x, y } = this.#pointerToFraction(event);
    const size = displaySize(this.#geometry);
    return { x: x * size.width, y: y * size.height };
  }

  #pointerToFraction(event: PointerEvent): Point {
    const bounds = this.#page.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }
}

function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** A version 4 UUID, built by hand because crypto.randomUUID only exists on secure origins. */
function newObjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
