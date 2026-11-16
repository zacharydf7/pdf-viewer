import type { PageGeometry, Rect, ResizeHandle } from "./geometry.js";
import { compareReadingOrder, pageRectToDisplay, pageRectToPercent, readingOrder } from "./geometry.js";
import type { ObjectStore, ObjectStyle, PageObject } from "./object-store.js";
import { isOnPage } from "./object-store.js";
import type { DrawDefaults, PointerTarget, Preview, ToolPresentation } from "./tool.js";
import { respondsToUser } from "./tool.js";

const handles: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const appDataPrefix = "data-app-";

/**
 * Displays one page's objects as real DOM elements, along with the selected object's handles and any gesture's
 * preview. It takes no input: the interaction controller does, and asks it what an element stands for.
 *
 * Geometry is percent-based inside a page that CSS scales, so zooming writes no per-object styles. The page space
 * rectangle in the store is the source of truth, and on-screen values are only ever derived from it.
 */
export class ObjectView {
  readonly element: HTMLElement;
  readonly #objectsElement: HTMLElement;
  readonly #handlesElement: HTMLElement;
  readonly #objectElements = new Map<string, HTMLElement>();
  /** What each object and handle element stands for, so input finds its object without reading the DOM back. */
  readonly #targets = new WeakMap<Element, PointerTarget>();
  /** What each element last displayed, so unchanged objects cost nothing to bring up to date. */
  readonly #appliedStates = new Map<string, string>();
  /** Each object's number on this page, for its default accessible name, given in the order objects appear. */
  readonly #numbers = new Map<string, number>();
  /** The app data keys each element shows, so keys an object drops can be removed without reading the DOM back. */
  readonly #appDataKeys = new Map<string, readonly string[]>();
  #nextNumber = 1;
  readonly #page: HTMLElement;
  readonly #pageNumber: number;
  readonly #store: ObjectStore;
  #geometry: PageGeometry;
  #presentation: ToolPresentation;
  #shownSelection: readonly string[] = [];
  /** The object whose handles are shown. */
  #handlesFor: string | undefined;
  /** An object a gesture is showing away from where the store has it. */
  #movedObject: { id: string; rect: Rect } | undefined;
  /** The rectangle a draw gesture is showing. */
  #draft: HTMLElement | undefined;
  /** The store's drafts on this page, which are drawn but not objects yet, so they're shown and take no input. */
  readonly #draftElements = new Map<string, HTMLElement>();
  /**
   * The one object Tab reaches, as in a listbox: the selected object, or else the object focused last, or else the
   * first in reading order.
   */
  #tabStop: string | undefined;
  /** Which of those the tab stop is, which decides what a change to other objects can do to it. */
  #tabStopIs: "selected" | "focused" | "first" = "first";
  /** Where the focused object was when a change removed it, so focus can go to its neighbor. */
  #lostFocusAt: Rect | undefined;

  constructor(page: HTMLElement, pageNumber: number, geometry: PageGeometry, store: ObjectStore,
    presentation: ToolPresentation) {
    this.#page = page;
    this.#pageNumber = pageNumber;
    this.#geometry = geometry;
    this.#store = store;
    this.#presentation = presentation;

    this.element = document.createElement("div");
    this.element.className = "pv-object-layer";
    this.element.dataset.pointer = presentation.pointer;
    this.#objectsElement = document.createElement("div");
    this.#objectsElement.className = "pv-objects";
    this.#handlesElement = document.createElement("div");
    this.#handlesElement.className = "pv-handles";
    this.#handlesElement.setAttribute("aria-hidden", "true");
    this.element.append(this.#objectsElement, this.#handlesElement);
    page.append(this.element);
    this.sync();
  }

  get geometry(): PageGeometry {
    return this.#geometry;
  }

  set geometry(geometry: PageGeometry) {
    const { width, height, rotation } = this.#geometry;
    if (geometry.width !== width || geometry.height !== height || geometry.rotation !== rotation) {
      this.#geometry = geometry;
      this.#appliedStates.clear();
      this.sync();
    }
  }

  set presentation(presentation: ToolPresentation) {
    this.#presentation = presentation;
    this.element.dataset.pointer = presentation.pointer;
    this.sync();
  }

  /** What an element stands for, or undefined for anything that isn't an object or a handle. */
  targetOf(element: EventTarget | null): PointerTarget | undefined {
    return this.#targets.get(element as Element);
  }

  /** Focuses an object without scrolling, since the press that asks for it was on screen already. */
  focus(id: string): void {
    this.#objectElements.get(id)?.focus({ preventScroll: true });
  }

  /** Whether an object is shown on this page. */
  shows(id: string): boolean {
    return this.#objectElements.has(id);
  }

  /** An object's accessible name, as screen readers announce it. */
  nameOf(id: string): string | undefined {
    return this.#objectElements.get(id)?.getAttribute("aria-label") ?? undefined;
  }

  /** Makes a focused object the one Tab reaches, so leaving the list and coming back returns to it. */
  noteFocus(id: string): void {
    this.#setTabStop(id, "focused");
  }

  /**
   * Moves focus from an object to another in reading order, without wrapping at either end, and scrolls only as far
   * as it takes to show it.
   */
  moveFocus(from: string, to: "previous" | "next" | "first" | "last"): void {
    const order = this.#focusableInReadingOrder();
    const index = order.findIndex(({ id }) => id === from);
    const target = to === "first" ? order[0]
      : to === "last" ? order.at(-1)
        : order[Math.min(Math.max(index + (to === "next" ? 1 : -1), 0), order.length - 1)];
    if (target !== undefined && target.id !== from) {
      this.#setTabStop(target.id, "focused");
      const element = this.#objectElements.get(target.id)!;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /** Scrolls the viewport only as far as it takes to show the object. */
  scrollIntoView(id: string): void {
    this.#objectElements.get(id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    this.syncDrafts();
    this.#syncFocus();
  }

  /** Brings the draft elements in line with the store's drafts on this page. */
  syncDrafts(): void {
    const drafts = this.#store.draftsForPage(this.#pageNumber);
    const ids = new Set(drafts.map(({ id }) => id));
    for (const [id, element] of this.#draftElements) {
      if (!ids.has(id)) {
        element.remove();
        this.#draftElements.delete(id);
      }
    }
    for (const draft of drafts) {
      const { id, rect } = draft;
      let element = this.#draftElements.get(id);
      if (element === undefined) {
        element = document.createElement("div");
        element.dataset.draftId = id;
        this.#draftElements.set(id, element);
        this.element.append(element);
      }
      styleDraft(element, draft);
      this.#position(element, rect);
      element.dataset.pageRect = formatRect(rect);
    }
  }

  /** Brings these objects up to date after a change, without visiting the others. */
  syncObjects(ids: readonly string[]): void {
    for (const id of ids) {
      const object = this.#store.get(id);
      if (object !== undefined && isOnPage(object, this.#pageNumber)) {
        this.#applyObject(object);
      } else {
        const element = this.#objectElements.get(id);
        if (element !== undefined) {
          this.#removeElement(id, element);
        }
      }
    }
    const count = this.#objectElements.size;
    this.#page.dataset.objectCount = String(count);
    this.#syncListboxRole(count);
    const primary = this.#store.primarySelectedId;
    if (primary !== null && ids.includes(primary)) {
      this.#syncHandles();
    }
    // A draft that has just become one of these objects stops showing as a draft at the same time.
    if (this.#draftElements.size > 0) {
      this.syncDrafts();
    }
    this.#syncFocus(ids);
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
      if (object !== undefined && isOnPage(object, this.#pageNumber)) {
        this.#applyObject(object);
      }
    }
    this.#shownSelection = this.#store.selectedIds;
    this.#syncHandles();
    this.#syncFocus();
  }

  /** Shows the part of a gesture's preview on this page. Undefined puts every object back where the store has it. */
  showPreview(preview: Preview | undefined): void {
    if (preview?.kind === "draft" && preview.page === this.#pageNumber) {
      if (this.#draft === undefined) {
        this.#draft = document.createElement("div");
        this.#draft.dataset.draft = "true";
        styleDraft(this.#draft, preview.defaults);
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

  #removeElement(id: string, element: HTMLElement): void {
    if (element.contains(document.activeElement)) {
      this.#lostFocusAt = parseRect(element.dataset.pageRect);
    }
    element.remove();
    this.#objectElements.delete(id);
    this.#appliedStates.delete(id);
    this.#numbers.delete(id);
    this.#appDataKeys.delete(id);
  }

  /**
   * A page with no objects has no list, and an element without a role can't be named, so the role and its label are
   * added and removed together.
   */
  #syncListboxRole(count: number): void {
    const hasRole = this.#objectsElement.hasAttribute("role");
    if (count > 0 && !hasRole) {
      this.#objectsElement.setAttribute("role", "listbox");
      this.#objectsElement.setAttribute("aria-label", `Objects on page ${this.#pageNumber}`);
    } else if (count === 0 && hasRole) {
      this.#objectsElement.removeAttribute("role");
      this.#objectsElement.removeAttribute("aria-label");
    }
  }

  #applyObject(object: PageObject): void {
    const selected = this.#store.isSelected(object.id);
    const focusable = respondsToUser(object, this.#presentation.readOnly) && this.#presentation.focusable;
    const state = JSON.stringify([object, selected, focusable]);
    if (this.#appliedStates.get(object.id) === state) {
      return;
    }
    this.#appliedStates.set(object.id, state);

    let element = this.#objectElements.get(object.id);
    if (element === undefined) {
      element = document.createElement("div");
      element.setAttribute("role", "option");
      element.dataset.objectId = object.id;
      this.#objectElements.set(object.id, element);
      this.#numbers.set(object.id, this.#nextNumber++);
      this.#targets.set(element, { kind: "object", id: object.id });
      this.#objectsElement.append(element);
    }
    this.#position(element, object.rect);
    element.dataset.pageRect = formatRect(object.rect);
    element.className = object.cssClass === undefined ? "pv-object" : `pv-object ${object.cssClass}`;
    element.dataset.objectShape = object.shape;
    if (object.kind === undefined) {
      delete element.dataset.objectKind;
    } else {
      element.dataset.objectKind = object.kind;
    }
    element.hidden = object.hidden;
    this.#applyAppData(element, object);
    element.dataset.locked = String(object.locked);
    element.dataset.selectable = String(object.selectable);
    element.dataset.editableWhenReadOnly = String(object.editableWhenReadOnly);
    const label = object.label ?? `Object ${this.#numbers.get(object.id)} on page ${this.#pageNumber}`;
    element.setAttribute("aria-label", label);
    element.setAttribute("aria-selected", String(selected));
    element.tabIndex = focusable && object.id === this.#tabStop ? 0 : -1;
    element.style.setProperty("--pv-object-color", object.style?.color ?? "");
    element.style.setProperty("--pv-object-fill", object.style?.fill ?? "");
    element.style.setProperty("--pv-object-border-width", borderWidthCss(object.style?.borderWidth));
    element.style.setProperty("--pv-object-border-style", object.style?.borderStyle ?? "");
  }

  /** Writes each value as a data-app-* attribute, and removes those for keys the object no longer has. */
  #applyAppData(element: HTMLElement, { id, appData = {} }: PageObject): void {
    for (const key of this.#appDataKeys.get(id) ?? []) {
      if (!Object.hasOwn(appData, key)) {
        element.removeAttribute(appDataPrefix + key);
      }
    }
    const keys = Object.keys(appData);
    for (const key of keys) {
      element.setAttribute(appDataPrefix + key, appData[key]!);
    }
    if (keys.length > 0) {
      this.#appDataKeys.set(id, keys);
    } else {
      this.#appDataKeys.delete(id);
    }
  }

  #position(element: HTMLElement, rect: Rect): void {
    const percent = pageRectToPercent(this.#geometry, rect);
    element.style.left = `${percent.x}%`;
    element.style.top = `${percent.y}%`;
    element.style.width = `${percent.width}%`;
    element.style.height = `${percent.height}%`;
  }

  /**
   * Gives focus a new home when a change removed the focused object: its next neighbor in reading order, the one before
   * it if it was last, or the page once the list is empty. Then keeps the tab stop on an object Tab can reach. While
   * the tab stop is the first object, only the objects a change touched are compared with it, so adding objects one at
   * a time doesn't visit every object each time.
   */
  #syncFocus(changed?: readonly string[]): void {
    const lostAt = this.#lostFocusAt;
    this.#lostFocusAt = undefined;
    if (lostAt !== undefined) {
      const lost = pageRectToDisplay(this.#geometry, lostAt);
      const order = this.#focusableInReadingOrder();
      const after = order.find(({ rect }) => compareReadingOrder(pageRectToDisplay(this.#geometry, rect), lost) >= 0);
      const target = after ?? order.at(-1);
      if (target === undefined) {
        // Focus the page, which has an accessible name, rather than the list, which has no role or name once it's
        // empty.
        this.#page.tabIndex = -1;
        this.#page.focus({ preventScroll: true });
      } else {
        this.#setTabStop(target.id, "focused");
        this.#objectElements.get(target.id)!.focus({ preventScroll: true });
      }
    }
    // Once focus is in the list, the tab stop follows it.
    const tabStop = this.#tabStop;
    const valid = tabStop !== undefined && this.#canFocus(tabStop);
    if (this.#objectsElement.contains(document.activeElement)) {
      if (!valid) {
        this.#setTabStop(this.#firstFocusable(this.#objectElements.keys()), "first");
      }
      return;
    }
    const primary = this.#store.primarySelectedId;
    if (primary !== null && this.#canFocus(primary)) {
      this.#setTabStop(primary, "selected");
    } else if (valid && this.#tabStopIs === "focused") {
      // Leaving the list and coming back returns to the object focused last.
    } else if (valid && this.#tabStopIs === "first" && changed !== undefined && !changed.includes(tabStop)) {
      this.#setTabStop(this.#firstFocusable([tabStop, ...changed]), "first");
    } else {
      this.#setTabStop(this.#firstFocusable(this.#objectElements.keys()), "first");
    }
  }

  /** The first object in reading order that the user can focus, among these, found without sorting them. */
  #firstFocusable(ids: Iterable<string>): string | undefined {
    let first: { id: string; position: Rect } | undefined;
    for (const id of ids) {
      if (this.#canFocus(id)) {
        const position = pageRectToDisplay(this.#geometry, this.#store.get(id)!.rect);
        if (first === undefined || compareReadingOrder(position, first.position) < 0) {
          first = { id, position };
        }
      }
    }
    return first?.id;
  }

  #setTabStop(id: string | undefined, is: "selected" | "focused" | "first"): void {
    this.#tabStopIs = is;
    if (id === this.#tabStop) {
      return;
    }
    const previous = this.#tabStop === undefined ? undefined : this.#objectElements.get(this.#tabStop);
    if (previous !== undefined) {
      previous.tabIndex = -1;
    }
    this.#tabStop = id;
    const next = id === undefined ? undefined : this.#objectElements.get(id);
    if (next !== undefined && this.#canFocus(id!)) {
      next.tabIndex = 0;
    }
  }

  /** Whether the user can focus an object here: it's shown, not hidden, and responds to the active tool. */
  #canFocus(id: string): boolean {
    const object = this.#store.get(id);
    return object !== undefined && this.#objectElements.has(id) && !object.hidden && this.#presentation.focusable
      && respondsToUser(object, this.#presentation.readOnly);
  }

  #focusableInReadingOrder(): PageObject[] {
    const focusable = [...this.#objectElements.keys()].filter((id) => this.#canFocus(id))
      .map((id) => this.#store.get(id)!);
    return readingOrder(focusable, this.#geometry, ({ rect }) => rect);
  }

  /** Handles appear only when one object is selected, because they resize that object alone. */
  #syncHandles(): void {
    this.#handlesElement.replaceChildren();
    this.#handlesFor = undefined;
    const [id, ...others] = this.#store.selectedIds;
    const selected = id === undefined || others.length > 0 ? undefined : this.#store.get(id);
    if (selected === undefined || !isOnPage(selected, this.#pageNumber) || selected.locked || selected.hidden
      || !respondsToUser(selected, this.#presentation.readOnly) || !this.#presentation.handles) {
      return;
    }
    for (const handle of handles) {
      const element = document.createElement("div");
      element.className = "pv-handle";
      element.dataset.handle = handle;
      element.dataset.handleFor = selected.id;
      this.#targets.set(element, { kind: "handle", id: selected.id, handle });
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
}

/** Gives a draft the kind, classes, color and border width its object will have, so it looks like that object. */
function styleDraft(element: HTMLElement, { kind, cssClass, style }: DrawDefaults): void {
  element.className = cssClass === undefined ? "pv-draft" : `pv-draft ${cssClass}`;
  if (kind !== undefined) {
    element.dataset.objectKind = kind;
  }
  element.style.setProperty("--pv-object-color", style?.color ?? "");
  element.style.setProperty("--pv-object-border-width", borderWidthCss(style?.borderWidth));
}

/**
 * A border width as CSS. A number is in page units, which the page's --pv-unit turns into CSS pixels at the current
 * zoom, and a string is a CSS length already. Empty when there's none, so the stylesheet's default applies.
 */
export function borderWidthCss(width: ObjectStyle["borderWidth"]): string {
  return typeof width === "number" ? `calc(var(--pv-unit) * ${width})` : width ?? "";
}

/** Reads back what formatRect wrote. */
function parseRect(value: string | undefined): Rect {
  const [x = 0, y = 0, width = 0, height = 0] = (value ?? "").split(",").map(Number);
  return { x, y, width, height };
}

/** A rectangle as data-page-rect shows it: x, y, width and height, to three decimal places at most. */
function formatRect({ x, y, width, height }: Rect): string {
  return [x, y, width, height].map((value) => String(Math.round(value * 1000) / 1000)).join(",");
}
