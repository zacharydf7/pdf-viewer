import type { Point, Rect, ResizeHandle } from "./geometry.js";
import { moveRect, pageToDisplay, resizeRectBy } from "./geometry.js";
import { rectAfterArrowKey } from "./keyboard-editing.js";
import type { ObjectStore } from "./object-store.js";
import type { ObjectKeyPress, PointerInput, PointerPress, Preview, PressResult, Tool, ToolContext, ToolPresentation }
  from "./tool.js";
import { commitRect, respondsToUser } from "./tool.js";

const minimumResizeSize = 1;

interface DragBase {
  id: string;
  /** The object's page, or null for an object on every page, so the drag ends if that changes. */
  page: number | null;
  /** Where the pointer was pressed, in display space. */
  start: Point;
  original: Rect;
  rect: Rect;
  moved: boolean;
}

type Drag = (DragBase & { kind: "move" }) | (DragBase & { kind: "resize"; handle: ResizeHandle });

/**
 * Selects objects, drags them to move them, drags their handles to resize them, and edits the focused object with the
 * keyboard. Pressing empty page area clears the selection. In a read-only viewer it does all that only for objects
 * marked editableWhenReadOnly, and an empty press leaves the selection alone.
 */
export class SelectTool implements Tool {
  readonly presentation: ToolPresentation;
  readonly #readOnly: boolean;
  readonly #store: ObjectStore;
  readonly #show: (preview: Preview | undefined) => void;
  /** Kept for its options, which are read at each use because they can change. */
  readonly #context: ToolContext;
  #drag: Drag | undefined;

  constructor(context: ToolContext, readOnly = false) {
    this.presentation = { pointer: "objects", focusable: true, handles: true, readOnly };
    this.#readOnly = readOnly;
    this.#store = context.store;
    this.#show = context.show;
    this.#context = context;
  }

  pointerDown({ geometry, point, target }: PointerPress): PressResult {
    if (target === undefined) {
      if (!this.#readOnly) {
        this.#store.select([], "user");
      }
      return { gesture: false };
    }
    const object = this.#store.get(target.id)!;
    if (!respondsToUser(object, this.#readOnly)) {
      return { gesture: false };
    }
    const { id, page, rect } = object;
    const start = pageToDisplay(geometry, point);
    if (target.kind === "handle") {
      this.#drag = { kind: "resize", handle: target.handle, id, page, start, original: rect, rect, moved: false };
      return { gesture: true, focus: id };
    }
    this.#store.select([id], "user");
    if (object.locked) {
      return { gesture: false, focus: id };
    }
    this.#drag = { kind: "move", id, page, start, original: rect, rect, moved: false };
    return { gesture: true, focus: id };
  }

  pointerMove(input: PointerInput): void {
    const drag = this.#drag;
    if (drag !== undefined) {
      this.#follow(drag, input);
      if (drag.moved) {
        this.#show({ kind: "object", id: drag.id, rect: drag.rect });
      }
    }
  }

  pointerUp(input: PointerInput): void {
    const drag = this.#drag;
    if (drag === undefined) {
      return;
    }
    this.#drag = undefined;
    this.#follow(drag, input);
    if (drag.moved) {
      // Cleared first, so listeners of the change see the object where the store has it.
      this.#show(undefined);
      commitRect(this.#store, drag.id, drag.rect, drag.kind, input.geometry, this.#context.options.roundCoordinates);
    }
  }

  cancel(): boolean {
    const drag = this.#drag;
    this.#drag = undefined;
    if (drag?.moved) {
      this.#show(undefined);
    }
    return drag !== undefined;
  }

  /** Focusing an object, whether by Tab or by a press, selects it. */
  focus(id: string): void {
    const object = this.#store.get(id);
    if (object !== undefined && respondsToUser(object, this.#readOnly)) {
      this.#store.select([id], "user");
    }
  }

  /**
   * A drag ends without a change once its object is removed, moved to another page or hidden, even if it comes back.
   */
  objectsChanged(): void {
    const drag = this.#drag;
    const object = drag === undefined ? undefined : this.#store.get(drag.id);
    if (drag !== undefined && (object?.page !== drag.page || object.hidden)) {
      this.cancel();
    }
  }

  keyDown(input: ObjectKeyPress): boolean {
    const object = this.#store.get(input.id);
    if (!this.#context.options.keyboardEditing || this.#drag !== undefined || object === undefined
      || !respondsToUser(object, this.#readOnly)) {
      return false;
    }
    if (input.key === "Escape") {
      this.#store.select([], "user");
    } else if (object.locked) {
      return false;
    } else if (input.key === "Delete") {
      this.#context.requestDelete(object.id);
    } else if (input.key.startsWith("Arrow")) {
      const { options } = this.#context;
      const rect = rectAfterArrowKey(input.geometry, object.rect, input, options, minimumResizeSize);
      if (rect === undefined) {
        return false;
      }
      commitRect(this.#store, object.id, rect, input.shiftKey ? "resize" : "nudge", input.geometry,
        options.roundCoordinates);
    } else {
      return false;
    }
    return true;
  }

  #follow(drag: Drag, { geometry, point }: PointerInput): void {
    const position = pageToDisplay(geometry, point);
    const deltaX = position.x - drag.start.x;
    const deltaY = position.y - drag.start.y;
    // Converting a rectangle to display space and back can change it by rounding error, so a click must not convert.
    if (deltaX === 0 && deltaY === 0 && !drag.moved) {
      return;
    }
    drag.moved = true;
    drag.rect = drag.kind === "move"
      ? moveRect(geometry, drag.original, deltaX, deltaY)
      : resizeRectBy(geometry, drag.original, drag.handle, deltaX, deltaY, minimumResizeSize);
  }
}
