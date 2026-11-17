import type { PageGeometry, Point, Rect, ResizeHandle } from "./geometry.js";
import { moveRect, pageToDisplay, resizeRectBy } from "./geometry.js";
import { rectAfterEdit } from "./keyboard-editing.js";
import type { ObjectStore } from "./object-store.js";
import type { ObjectKeyPress, PointerInput, PointerPress, Preview, PressResult, Tool, ToolContext, ToolPresentation }
  from "./tool.js";
import { commitRect, finalRect, respondsToUser } from "./tool.js";

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
 * Keys that moved or resized one object, shown on the page but not yet in the store. Like a drag, the run is one
 * change, so an application records it once, as one step to undo.
 */
interface KeyEdit {
  id: string;
  /** The object's page, or null for an object on every page, so the run ends if that changes. */
  page: number | null;
  gesture: "nudge" | "resize";
  geometry: PageGeometry;
  rect: Rect;
}

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
  #keyEdit: KeyEdit | undefined;

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

  /**
   * Focusing an object selects it only when the options ask for that, so moving focus through the objects changes
   * nothing. A press selects through pointerDown instead.
   */
  focus(id: string): void {
    const object = this.#store.get(id);
    if (this.#context.options.selectOnFocus && object !== undefined && respondsToUser(object, this.#readOnly)) {
      this.#store.select([id], "user");
    }
  }

  /**
   * A drag ends without a change once its object is removed, moved to another page or hidden, even if it comes back.
   */
  objectsChanged(): void {
    const drag = this.#drag;
    if (drag !== undefined && this.#isGone(drag)) {
      this.cancel();
    }
    const keyEdit = this.#keyEdit;
    if (keyEdit !== undefined && this.#isGone(keyEdit)) {
      this.#keyEdit = undefined;
      this.#show(undefined);
    }
  }

  /** Whether an edit's object was removed, hidden or moved to another page since the edit began. */
  #isGone({ id, page }: { id: string; page: number | null }): boolean {
    const object = this.#store.get(id);
    return object?.page !== page || object.hidden;
  }

  /**
   * Selects, clears, deletes or edits. A key that moves or resizes an object selects it first, unless it's selected
   * already, so the change is made to what the user is working on. A locked object can be selected, but not deleted
   * or edited. Moves and resizes are shown at once, and the store gets them when the run of keys ends. A key that
   * edits another object, or resizes during a run of moves or moves during a run of resizes, ends the run and starts
   * another.
   */
  keyDown({ id, geometry, action }: ObjectKeyPress): boolean {
    const object = this.#store.get(id);
    if (this.#drag !== undefined || object === undefined || object.hidden || !respondsToUser(object, this.#readOnly)) {
      return false;
    }
    if (action.kind === "select" || action.kind === "clear") {
      this.#store.select(action.kind === "select" ? [id] : [], "user");
      return true;
    }
    if (object.locked) {
      return false;
    }
    if (action.kind === "delete") {
      this.#context.requestDelete(id);
      return true;
    }
    if (!this.#store.isSelected(id)) {
      this.#store.select([id], "user");
    }
    const gesture = action.resize ? "resize" : "nudge";
    if (this.#keyEdit !== undefined && (this.#keyEdit.id !== id || this.#keyEdit.gesture !== gesture)) {
      this.endKeyEdit();
    }
    // Each step is rounded as the store would round it, so the run ends where the same keys one at a time would.
    const edited = rectAfterEdit(geometry, this.#keyEdit?.rect ?? object.rect, action, minimumResizeSize);
    const rect = finalRect(geometry, edited, this.#context.options.roundCoordinates);
    this.#keyEdit = { id, page: object.page, gesture, geometry, rect };
    this.#show({ kind: "object", id, rect });
    this.#context.announceEdit(id, rect, action.resize);
    return true;
  }

  endKeyEdit(): void {
    const keyEdit = this.#keyEdit;
    if (keyEdit === undefined) {
      return;
    }
    this.#keyEdit = undefined;
    // Cleared first, so listeners of the change see the object where the store has it.
    this.#show(undefined);
    const { id, rect, gesture, geometry } = keyEdit;
    commitRect(this.#store, id, rect, gesture, geometry, this.#context.options.roundCoordinates);
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
