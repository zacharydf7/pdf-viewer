import type { PageGeometry, Rect } from "./geometry.js";
import type { KeyAction } from "./keyboard-editing.js";
import { rectAfterEdit } from "./keyboard-editing.js";
import type { ToolContext } from "./tool.js";
import { commitRect, finalRect, isGone, minimumResizeSize, respondsToUser } from "./tool.js";

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
 * Moves and resizes objects with keys, for whichever tool is active. Each step is shown at once, and the store gets the
 * run of keys as one change when it ends.
 */
export class KeyEditor {
  readonly #context: ToolContext;
  readonly #readOnly: boolean;
  #edit: KeyEdit | undefined;

  constructor(context: ToolContext, readOnly: boolean) {
    this.#context = context;
    this.#readOnly = readOnly;
  }

  /**
   * Moves or resizes an object by one step, and returns whether the key was handled. A hidden or locked object, or one
   * that doesn't respond to the user, isn't edited. An edit selects its object first, unless it's selected already, so
   * the change is made to what the user is working on. A key that edits another object, or resizes during a run of
   * moves or moves during a run of resizes, ends the run and starts another.
   */
  edit(id: string, geometry: PageGeometry, action: Extract<KeyAction, { kind: "edit" }>): boolean {
    const { store } = this.#context;
    const object = store.get(id);
    if (object === undefined || object.hidden || object.locked || !respondsToUser(object, this.#readOnly)) {
      return false;
    }
    if (!store.isSelected(id)) {
      store.select([id], "user");
    }
    const gesture = action.resize ? "resize" : "nudge";
    if (this.#edit !== undefined && (this.#edit.id !== id || this.#edit.gesture !== gesture)) {
      this.end();
    }
    // Each step is rounded as the store would round it, so the run ends where the same keys one at a time would.
    const edited = rectAfterEdit(geometry, this.#edit?.rect ?? object.rect, action, minimumResizeSize);
    const rect = finalRect(geometry, edited, this.#context.options.roundCoordinates);
    this.#edit = { id, page: object.page, gesture, geometry, rect };
    this.#context.show({ kind: "object", id, rect });
    this.#context.announceEdit(id, rect, action.resize);
    return true;
  }

  /** Ends the run of keys, and gives the store the rectangle it ended with as one change. */
  end(): void {
    const edit = this.#edit;
    if (edit === undefined) {
      return;
    }
    this.#edit = undefined;
    // Cleared first, so listeners of the change see the object where the store has it.
    this.#context.show(undefined);
    const { id, rect, gesture, geometry } = edit;
    commitRect(this.#context.store, id, rect, gesture, geometry, this.#context.options.roundCoordinates);
  }

  /** A run ends without a change once its object is removed, moved to another page or hidden. */
  objectsChanged(): void {
    if (this.#edit !== undefined && isGone(this.#context.store, this.#edit)) {
      this.#edit = undefined;
      this.#context.show(undefined);
    }
  }
}
