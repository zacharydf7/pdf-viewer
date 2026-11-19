import type { Point } from "./geometry.js";
import { clampPoint, rectFromCorners } from "./geometry.js";
import { KeyEditor } from "./key-editor.js";
import type { ObjectStore } from "./object-store.js";
import { SelectTool } from "./select-tool.js";
import type { DrawDefaults, ObjectKeyPress, PointerInput, PointerPress, Preview, PressResult, Tool, ToolContext,
  ToolPresentation } from "./tool.js";
import { finalRect } from "./tool.js";

/** The smallest width and height a drawn rectangle can have, in page units, so a click doesn't make one. */
const minimumDrawSize = 2;

/**
 * Draws a rectangle from where the pointer is pressed to where it's released, and leaves it with the store as a draft.
 * Unless the drawOverObjects option is on, a press on an object selects it and a drag moves or resizes it, as with the
 * select tool, so only a press elsewhere on the page draws. A click there, too small to draw anything, clears the
 * selection. Keys still move and resize objects while it's active, so the user can adjust what they just drew, but the
 * keys that select, clear the selection or delete are left alone.
 */
export class DrawRectTool implements Tool {
  readonly #store: ObjectStore;
  readonly #show: (preview: Preview | undefined) => void;
  /** Kept for its options, which are read at each use because they can change. */
  readonly #context: ToolContext;
  readonly #defaults: DrawDefaults;
  readonly #keys: KeyEditor;
  /** Handles presses on objects. */
  readonly #select: SelectTool;
  #draw: { page: number; start: Point; current: Point } | undefined;

  /** The defaults are applied to every rectangle drawn. */
  constructor(context: ToolContext, defaults: DrawDefaults) {
    this.#store = context.store;
    this.#show = context.show;
    this.#context = context;
    this.#defaults = defaults;
    this.#keys = new KeyEditor(context, false);
    this.#select = new SelectTool(context);
  }

  get presentation(): ToolPresentation {
    const { drawOverObjects } = this.#context.options;
    return { pointer: drawOverObjects ? "page" : "objects-and-page", focusable: true, handles: !drawOverObjects,
      readOnly: false };
  }

  pointerDown(input: PointerPress): PressResult {
    if (input.target !== undefined && !this.#context.options.drawOverObjects) {
      return this.#select.pointerDown(input);
    }
    const { page, geometry, point } = input;
    const start = clampPoint(geometry, point);
    this.#draw = { page, start, current: start };
    this.#showDraft();
    return { gesture: true };
  }

  pointerMove(input: PointerInput): void {
    if (this.#draw === undefined) {
      this.#select.pointerMove(input);
      return;
    }
    this.#draw.current = clampPoint(input.geometry, input.point);
    this.#showDraft();
  }

  pointerUp(input: PointerInput): void {
    const draw = this.#draw;
    if (draw === undefined) {
      this.#select.pointerUp(input);
      return;
    }
    const { geometry, point } = input;
    this.#draw = undefined;
    this.#show(undefined);
    const rect = rectFromCorners(draw.start, clampPoint(geometry, point));
    if (rect.width < minimumDrawSize || rect.height < minimumDrawSize) {
      this.#store.select([], "user");
      return;
    }
    const final = finalRect(geometry, rect, this.#context.options.roundCoordinates);
    this.#store.addDraft({ id: newObjectId(), page: draw.page, rect: final, ...this.#defaults });
  }

  cancel(): boolean {
    const dragging = this.#select.cancel();
    const drawing = this.#draw !== undefined;
    this.#draw = undefined;
    if (drawing) {
      this.#show(undefined);
    }
    return dragging || drawing;
  }

  keyDown({ id, geometry, action }: ObjectKeyPress): boolean {
    return this.#draw === undefined && !this.#select.dragging && action.kind === "edit"
      && this.#keys.edit(id, geometry, action);
  }

  endKeyEdit(): void {
    this.#keys.end();
  }

  objectsChanged(): void {
    this.#select.objectsChanged();
    this.#keys.objectsChanged();
  }

  #showDraft(): void {
    const { page, start, current } = this.#draw!;
    this.#show({ kind: "draft", page, rect: rectFromCorners(start, current), defaults: this.#defaults });
  }
}

/** A version 4 UUID, built by hand because crypto.randomUUID only exists on secure origins. */
function newObjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
