import type { PageGeometry, Point, Rect, ResizeHandle } from "./geometry.js";
import { moveRect, pageToDisplay, resizeRectBy } from "./geometry.js";
import { rectAfterArrowKey } from "./keyboard-editing.js";
import type { EditGesture, ObjectStore } from "./object-store.js";
import type { ObjectKeyPress, PointerInput, PointerPress, Preview, PressResult, Tool, ToolContext, ToolPresentation }
  from "./tool.js";
import { finalRect } from "./tool.js";

const minimumResizeSize = 1;

interface DragBase {
  id: string;
  /** The object's page, so the drag ends if the object leaves it. */
  page: number;
  /** Where the pointer was pressed, in display space. */
  start: Point;
  original: Rect;
  rect: Rect;
  moved: boolean;
}

type Drag = (DragBase & { kind: "move" }) | (DragBase & { kind: "resize"; handle: ResizeHandle });

/**
 * Selects objects, drags them to move them, drags their handles to resize them, and edits the focused object with the
 * keyboard. Pressing empty page area clears the selection.
 */
export class SelectTool implements Tool {
  readonly presentation: ToolPresentation = { pointer: "objects", focusable: true, handles: true };
  readonly #store: ObjectStore;
  readonly #show: (preview: Preview | undefined) => void;
  /** Kept for its options, which are read at each use because they can change. */
  readonly #context: ToolContext;
  #drag: Drag | undefined;

  constructor(context: ToolContext) {
    this.#store = context.store;
    this.#show = context.show;
    this.#context = context;
  }

  pointerDown({ geometry, point, target }: PointerPress): PressResult {
    if (target === undefined) {
      this.#store.select([], "user");
      return { gesture: false };
    }
    const object = this.#store.get(target.id)!;
    const { id, page, rect } = object;
    const start = pageToDisplay(geometry, point);
    if (target.kind === "handle") {
      this.#drag = { kind: "resize", handle: target.handle, id, page, start, original: rect, rect, moved: false };
      return { gesture: true, focus: id };
    }
    if (!object.selectable) {
      return { gesture: false };
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
      this.#commit(drag.id, drag.original, drag.rect, drag.kind, input.geometry);
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
    if (this.#store.get(id)?.selectable) {
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
      || !object.selectable) {
      return false;
    }
    if (input.key === "Escape") {
      this.#store.select([], "user");
    } else if (object.locked) {
      return false;
    } else if (input.key === "Delete") {
      this.#store.remove(object.id, "user");
    } else if (input.key.startsWith("Arrow")) {
      const rect = rectAfterArrowKey(input.geometry, object.rect, input, minimumResizeSize);
      this.#commit(object.id, object.rect, rect, input.shiftKey ? "resize" : "nudge", input.geometry);
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

  /** A change that rounds back to the original isn't a change, so it doesn't reach the store. */
  #commit(id: string, original: Rect, rect: Rect, gesture: EditGesture, geometry: PageGeometry): void {
    const final = finalRect(geometry, rect, this.#context.options.roundCoordinates);
    if (!rectsEqual(final, original)) {
      this.#store.update(id, { rect: final }, "user", gesture);
    }
  }
}

function rectsEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
