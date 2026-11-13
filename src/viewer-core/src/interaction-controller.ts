import { DrawRectTool } from "./draw-rect-tool.js";
import { fractionToPage } from "./geometry.js";
import type { ObjectStore } from "./object-store.js";
import type { ObjectView } from "./object-view.js";
import { SelectTool } from "./select-tool.js";
import type { DrawDefaults, PointerInput, Preview, Tool, ToolContext, ToolOptions, ToolPresentation, ViewerTool }
  from "./tool.js";

/** With no tool, objects ignore the pointer and the keyboard. */
const inactive: ToolPresentation = { pointer: "none", focusable: false, handles: false };

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

  constructor(root: HTMLElement, store: ObjectStore, options: ToolOptions) {
    this.#context = { store, show: (preview) => this.#show(preview), options };
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

  /** Starts a tool, canceling any gesture the previous tool had under way. The draw tool applies the defaults. */
  setTool(tool: ViewerTool, drawDefaults: DrawDefaults): void {
    this.#cancelGesture();
    const context = this.#context;
    this.#tool = tool === "select" ? new SelectTool(context)
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
    const target = this.#pageOf(event.target)?.objects.targetOf(event.target);
    if (target?.kind === "object") {
      this.#tool?.focus?.(target.id);
    }
  }

  /** Only handled keys stop propagating, so a host application's own shortcuts keep working. */
  #onKeyDown(event: KeyboardEvent): void {
    const page = this.#pageOf(event.target);
    const target = page?.objects.targetOf(event.target);
    if (target?.kind !== "object") {
      return;
    }
    const { key, shiftKey, ctrlKey } = event;
    if (this.#tool?.keyDown?.({ id: target.id, geometry: page!.objects.geometry, key, shiftKey, ctrlKey })) {
      event.preventDefault();
      event.stopPropagation();
    }
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
