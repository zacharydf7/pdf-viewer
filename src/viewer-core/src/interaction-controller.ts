import { DrawRectTool } from "./draw-rect-tool.js";
import { fractionToPage } from "./geometry.js";
import { keyAction } from "./keyboard-editing.js";
import type { ObjectStore } from "./object-store.js";
import type { ObjectView } from "./object-view.js";
import { SelectTool } from "./select-tool.js";
import type { DrawDefaults, PointerInput, Preview, Tool, ToolContext, ToolOptions, ToolPresentation, ViewerTool }
  from "./tool.js";

/** With no tool, objects ignore the pointer and the keyboard. */
const inactive: ToolPresentation = { pointer: "none", focusable: false, handles: false, readOnly: false };

/** A displayed page, as the controller needs it. */
export interface InteractivePage {
  readonly pageNumber: number;
  readonly element: HTMLElement;
  readonly objects: ObjectView;
}

/**
 * Turns one viewer's pointer and keyboard events into page-space input for the active tool, and shows the tool's
 * previews on the displayed pages. Its listeners are on the viewport, plus one on the window while a gesture is under
 * way.
 */
export class InteractionController {
  readonly #pages = new Set<InteractivePage>();
  readonly #context: ToolContext & { options: ToolOptions };
  #tool: Tool | undefined;
  /** The page a gesture's positions are measured against, and what removes the gesture's window listener. */
  #gesture: { page: InteractivePage; listener: AbortController } | undefined;
  /** What removes the listener on the keyboard scope. */
  #scopeListener: AbortController | undefined;
  /** What removes the window listeners that end a run of keys that moved or resized an object. */
  #keyEditListener: AbortController | undefined;

  /**
   * A tool that wants an object deleted calls requestDelete with its id, and one that moved or resized an object with a
   * key calls announceEdit.
   */
  constructor(root: HTMLElement, store: ObjectStore, options: ToolOptions,
    { requestDelete, announceEdit }: Pick<ToolContext, "requestDelete" | "announceEdit">) {
    this.#context = { store, show: (preview) => this.#show(preview), options, requestDelete, announceEdit };
    root.addEventListener("pointerdown", (event) => this.#onPointerDown(event));
    root.addEventListener("pointermove", (event) => this.#onPointerMove(event));
    root.addEventListener("pointerup", (event) => this.#onPointerUp(event));
    root.addEventListener("pointercancel", (event) => {
      if (this.#gestureOf(event) !== undefined) {
        this.#cancelGesture();
      }
    });
    root.addEventListener("keydown", (event) => this.#onKeyDown(event));
    root.addEventListener("focusin", (event) => this.#onFocusIn(event));
  }

  /** How objects and the page respond to the active tool. */
  get presentation(): ToolPresentation {
    return this.#tool?.presentation ?? inactive;
  }

  /** Takes effect at once, even during a gesture, which carries on under the new options. */
  set options(options: ToolOptions) {
    this.#context.options = options;
  }

  /**
   * An element outside the viewer, such as the part of the application around it, where keys that move or resize an
   * object also work. They act on the selected object, unless focus is in a field that uses arrow keys itself, such as
   * a text box. Keys pressed while nothing has focus count as pressed there too. Null for none.
   */
  set keyboardScope(element: Element | null) {
    this.#scopeListener?.abort();
    this.#scopeListener = undefined;
    if (element !== null) {
      this.#scopeListener = new AbortController();
      const { signal } = this.#scopeListener;
      element.addEventListener("keydown", (event) => this.#onScopeKeyDown(event as KeyboardEvent), { signal });
      // With nothing focused, keys go to the body, which is outside any scope but the body itself.
      const { body, documentElement } = element.ownerDocument;
      element.ownerDocument.addEventListener("keydown", (event) => {
        const { target } = event;
        if ((target === body || target === documentElement) && !element.contains(target as Node)) {
          this.#onScopeKeyDown(event);
        }
      }, { signal });
    }
  }

  /**
   * Starts a tool, canceling any gesture the previous tool had under way. The draw tool applies the defaults. While
   * the viewer is read-only, whichever tool is chosen, the user can only select and edit the objects marked to stay
   * editable.
   */
  setTool(tool: ViewerTool, drawDefaults: DrawDefaults, readOnly: boolean): void {
    this.#endKeyEdit();
    this.#cancelGesture();
    const context = this.#context;
    this.#tool = readOnly ? new SelectTool(context, true)
      : tool === "select" ? new SelectTool(context)
        : tool === "draw-rect" ? new DrawRectTool(context, drawDefaults)
          : undefined;
    for (const page of this.#pages) {
      page.objects.presentation = this.presentation;
    }
  }

  /** Starts taking input for a page, which should already show the current presentation. */
  attach(page: InteractivePage): void {
    this.#pages.add(page);
  }

  /** Stops taking input for a page, ending any gesture on it. */
  detach(page: InteractivePage): void {
    if (this.#gesture?.page === page) {
      this.#cancelGesture();
    }
    this.#pages.delete(page);
  }

  /** Call after every change to the store's objects, once the pages show it. */
  objectsChanged(): void {
    this.#tool?.objectsChanged?.();
  }

  #show(preview: Preview | undefined): void {
    for (const page of this.#pages) {
      page.objects.showPreview(preview);
    }
  }

  #onPointerDown(event: PointerEvent): void {
    const tool = this.#tool;
    const page = this.#pageOf(event.target);
    if (event.button !== 0 || tool === undefined || page === undefined) {
      return;
    }
    const target = page.objects.targetOf(event.target);
    const { gesture, focus } = tool.pointerDown({ ...this.#pointerInput(page, event), target });
    if (gesture) {
      event.preventDefault();
      page.element.setPointerCapture(event.pointerId);
      this.#startGesture(page);
    }
    // Starting a gesture prevents the browser's default, including moving focus, so arrow keys need this after a click.
    if (focus !== undefined) {
      page.objects.focus(focus);
    }
  }

  #onPointerMove(event: PointerEvent): void {
    const gesture = this.#gestureOf(event);
    if (gesture !== undefined) {
      this.#tool!.pointerMove(this.#pointerInput(gesture.page, event));
    }
  }

  #onPointerUp(event: PointerEvent): void {
    const gesture = this.#gestureOf(event);
    if (gesture !== undefined) {
      this.#endGesture();
      this.#tool!.pointerUp(this.#pointerInput(gesture.page, event));
    }
  }

  /**
   * The gesture under way, if the event belongs to it. The captured pointer's events target the gesture's page, while
   * another pointer elsewhere in the viewport, such as a second finger, mustn't move or end it.
   */
  #gestureOf(event: Event): { page: InteractivePage } | undefined {
    const gesture = this.#gesture;
    return gesture?.page.element.contains(event.target as Node) ? gesture : undefined;
  }

  /**
   * The window listener lives only as long as the gesture. It's on the window because a gesture doesn't always leave
   * focus inside the viewer, and in the capture phase so that canceling a gesture comes before anything a focused
   * object or the application does with the same key.
   */
  #startGesture(page: InteractivePage): void {
    this.#endGesture();
    const listener = new AbortController();
    const { signal } = listener;
    window.addEventListener("keydown", (event) => this.#onWindowKeyDown(event), { signal, capture: true });
    this.#gesture = { page, listener };
  }

  #endGesture(): void {
    this.#gesture?.listener.abort();
    this.#gesture = undefined;
  }

  /** Ends any gesture without changing anything, and returns whether one was under way. */
  #cancelGesture(): boolean {
    this.#endGesture();
    return this.#tool?.cancel() ?? false;
  }

  #onWindowKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.#cancelGesture()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  #onFocusIn(event: FocusEvent): void {
    const page = this.#pageOf(event.target);
    const target = page?.objects.targetOf(event.target);
    if (target?.kind === "object") {
      page!.objects.noteFocus(target.id);
      this.#tool?.focus?.(target.id);
    }
  }

  /**
   * Keys on a focused object. Moving focus between objects belongs to the list, and everything else to the tool. Only
   * handled keys stop propagating, so a host application's own shortcuts keep working.
   */
  #onKeyDown(event: KeyboardEvent): void {
    keysInViewers.add(event);
    const page = this.#pageOf(event.target);
    const target = page?.objects.targetOf(event.target);
    const action = target?.kind === "object" ? keyAction(event, this.#context.options) : undefined;
    if (action === undefined) {
      return;
    }
    if (action.kind === "focus") {
      page!.objects.moveFocus(target!.id, action.to);
    } else if (this.#tool?.keyDown?.({ id: target!.id, geometry: page!.objects.geometry, action })) {
      this.#startKeyEdit(action.kind);
    } else {
      // A move key the tool turns down, as on a locked object, still mustn't reach the browser, where Alt with an
      // arrow key goes back or forward in the browser's history.
      if (action.kind === "edit") {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /**
   * Keys in the keyboard scope outside the viewer, which only move or resize the selected object. Like a key on a
   * focused object, one the tool turns down doesn't reach the browser either. They work even when something in the
   * scope has canceled their default action, as components often do with every key they see. To keep the viewer from
   * acting on a key, stop it from propagating before it reaches the scope, or before it reaches the document for a key
   * pressed while nothing has focus. Keys pressed in any viewer belong to that viewer. When several viewers listen in
   * the same place, the first that acts on a key keeps it from the others.
   */
  #onScopeKeyDown(event: KeyboardEvent): void {
    if (keysInViewers.has(event) || takesArrowKeys(event.target)) {
      return;
    }
    const action = keyAction(event, this.#context.options);
    const id = this.#context.store.primarySelectedId;
    const page = id === null ? undefined : [...this.#pages].find(({ objects }) => objects.shows(id));
    if (action?.kind !== "edit" || page === undefined) {
      return;
    }
    event.preventDefault();
    if (this.#tool?.keyDown?.({ id: id!, geometry: page.objects.geometry, action })) {
      this.#startKeyEdit(action.kind);
      event.stopImmediatePropagation();
    }
  }

  /**
   * After a key that edits an object, the run of keys goes on until the move modifier is released, a key other than
   * an edit or modifier key is pressed, the pointer is pressed or the window loses focus. The listeners are on the
   * window, in the capture phase, because those can happen anywhere and the run must end before anything else handles
   * them.
   */
  #startKeyEdit(kind: string): void {
    if (kind !== "edit" || this.#keyEditListener !== undefined) {
      return;
    }
    const listener = this.#keyEditListener = new AbortController();
    const options = { signal: listener.signal, capture: true };
    const end = () => this.#endKeyEdit();
    window.addEventListener("keyup", (event) => {
      if (!event[`${this.#context.options.keyboardMoveModifier}Key`]) {
        end();
      }
    }, options);
    window.addEventListener("keydown", (event) => {
      if (!modifierKeys.has(event.key) && keyAction(event, this.#context.options)?.kind !== "edit") {
        end();
      }
    }, options);
    window.addEventListener("pointerdown", end, options);
    // Not in the capture phase, which would also catch each element that loses focus, not just the window.
    window.addEventListener("blur", end, { signal: listener.signal });
  }

  #endKeyEdit(): void {
    this.#keyEditListener?.abort();
    this.#keyEditListener = undefined;
    this.#tool?.endKeyEdit?.();
  }

  /** Ends any run of edit keys, and detaches from the keyboard scope, which can outlive the viewer. */
  dispose(): void {
    this.#endKeyEdit();
    this.keyboardScope = null;
  }

  #pageOf(target: EventTarget | null): InteractivePage | undefined {
    for (const page of this.#pages) {
      if (page.element.contains(target as Node)) {
        return page;
      }
    }
    return undefined;
  }

  #pointerInput(page: InteractivePage, event: PointerEvent): PointerInput {
    const bounds = page.element.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    const { geometry } = page.objects;
    return { page: page.pageNumber, geometry, point: fractionToPage(geometry, x, y) };
  }
}

/** Modifier keys. Pressing one, or holding it until it repeats, doesn't end a run of edit keys. */
const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);

/**
 * Keys pressed inside a viewer. They belong to that viewer, even when it's inside another viewer's keyboard scope and
 * turns them down.
 */
const keysInViewers = new WeakSet<Event>();

/** Input types that don't use arrow keys, so the viewer's keys still work while one has focus. */
const inputsWithoutArrowKeys = new Set(["button", "checkbox", "color", "file", "image", "reset", "submit"]);

/**
 * Whether an element uses arrow keys itself, as a text box, list or slider does, so keys pressed in it belong to it
 * rather than to the viewer. A combobox counts too, because Alt with the down arrow opens its list. With the default
 * Alt modifier, other widgets, such as a tree, don't conflict, because they use arrow keys without it.
 */
function takesArrowKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return !inputsWithoutArrowKeys.has(target.type);
  }
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    || target.getAttribute("role") === "combobox";
}
