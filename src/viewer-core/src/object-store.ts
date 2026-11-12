import type { Rect } from "./geometry.js";

export interface ObjectStyle {
  /** Border color, as any CSS color. */
  color?: string;
  /** Fill color, as any CSS color. */
  fill?: string;
  /** Border width, as any CSS length. */
  borderWidth?: string;
}

/**
 * An app-defined object on a page. Its rectangle is in the viewer's coordinates, which are page space by default, as
 * described in geometry.ts. The store's objects are frozen, so a change always goes through the store.
 */
export interface PageObject {
  readonly id: string;
  readonly page: number;
  readonly rect: Readonly<Rect>;
  readonly kind: "rect";
  /** A locked object can be selected, but not moved, resized or deleted by the user. */
  readonly locked: boolean;
  /** An unselectable object is displayed, but ignores pointer and keyboard input. */
  readonly selectable: boolean;
  readonly label?: string;
  /** The application's own category for this object, carried unchanged through events and shown as data-object-tag. */
  readonly tag?: string;
  readonly style?: Readonly<ObjectStyle>;
}

export type NewPageObject = Pick<PageObject, "id" | "page" | "rect"> & Partial<PageObject>;

export type ObjectPatch = Partial<Omit<PageObject, "id">>;

/** Whether a change came from the person using the viewer or from the host application's code. */
export type ChangeOrigin = "user" | "api";

/**
 * How the user changed an object's rectangle: "move" by dragging it, "resize" by dragging a handle or pressing Shift
 * with an arrow key, and "nudge" by pressing an arrow key without Shift.
 */
export type EditGesture = "move" | "resize" | "nudge";

interface Change {
  /** Counts every change to objects and selection, so a listener can tell which of two is newer. */
  sequence: number;
  origin: ChangeOrigin;
}

export interface ObjectAdded extends Change {
  object: PageObject;
}

export interface ObjectUpdated extends Change {
  object: PageObject;
  /** The object as it was before this change. */
  previous: PageObject;
  /** Present when the user changed the rectangle. */
  gesture?: EditGesture;
}

export interface ObjectRemoved extends Change {
  /** The object as it was when removed. */
  object: PageObject;
}

export type ObjectsReplaced = Change;

export interface SelectionChanged extends Change {
  /** Every selected object, in the order selected. */
  ids: readonly string[];
  /** The object selected last, or null when nothing is selected. */
  primaryId: string | null;
}

export interface ObjectStoreListener {
  onAdded(change: ObjectAdded): void;
  onUpdated(change: ObjectUpdated): void;
  onRemoved(change: ObjectRemoved): void;
  onReplaced(change: ObjectsReplaced): void;
  onSelectionChanged(change: SelectionChanged): void;
}

/** Holds every object in the document, including those on pages that are not currently displayed. */
export class ObjectStore {
  readonly #objects = new Map<string, PageObject>();
  readonly #listener: ObjectStoreListener;
  #selectedIds: readonly string[] = Object.freeze([]);
  /** The same ids, for looking one up without scanning the list. */
  #selectedSet: ReadonlySet<string> = new Set();
  #sequence = 0;

  constructor(listener: ObjectStoreListener) {
    this.#listener = listener;
  }

  get selectedIds(): readonly string[] {
    return this.#selectedIds;
  }

  get primarySelectedId(): string | null {
    return this.#selectedIds.at(-1) ?? null;
  }

  isSelected(id: string): boolean {
    return this.#selectedSet.has(id);
  }

  get(id: string): PageObject | undefined {
    return this.#objects.get(id);
  }

  all(): PageObject[] {
    return [...this.#objects.values()];
  }

  forPage(page: number): PageObject[] {
    return this.all().filter((object) => object.page === page);
  }

  add(object: NewPageObject, origin: ChangeOrigin): PageObject {
    if (this.#objects.has(object.id)) {
      throw new Error(`An object with id "${object.id}" already exists.`);
    }
    const added = frozenObject(object);
    this.#objects.set(added.id, added);
    this.#listener.onAdded({ sequence: ++this.#sequence, origin, object: added });
    return added;
  }

  update(id: string, patch: ObjectPatch, origin: ChangeOrigin, gesture?: EditGesture): PageObject {
    const previous = this.#require(id);
    const updated = frozenObject({ ...previous, ...patch });
    this.#objects.set(id, updated);
    this.#listener.onUpdated({ sequence: ++this.#sequence, origin, object: updated, previous, gesture });
    return updated;
  }

  remove(id: string, origin: ChangeOrigin): void {
    const existing = this.#require(id);
    if (this.#selectedSet.has(id)) {
      this.select(this.#selectedIds.filter((selected) => selected !== id), origin);
    }
    this.#objects.delete(id);
    this.#listener.onRemoved({ sequence: ++this.#sequence, origin, object: existing });
  }

  /** Replaces every object in one step. Selected objects that still exist stay selected. */
  replaceAll(objects: readonly NewPageObject[], origin: ChangeOrigin): void {
    const replacement = objects.map(frozenObject);
    const ids = new Set(replacement.map((object) => object.id));
    if (ids.size !== replacement.length) {
      throw new Error("Object ids must be unique.");
    }
    this.select(this.#selectedIds.filter((selected) => ids.has(selected)), origin);
    this.#objects.clear();
    for (const object of replacement) {
      this.#objects.set(object.id, object);
    }
    this.#listener.onReplaced({ sequence: ++this.#sequence, origin });
  }

  /** Selects exactly these objects. A repeated id counts once, at its first position. */
  select(ids: readonly string[], origin: ChangeOrigin): void {
    const unique = new Set(ids);
    // Frozen, because listeners and callers get this same array.
    const selected = Object.freeze([...unique]);
    selected.forEach((id) => this.#require(id));
    const current = this.#selectedIds;
    if (selected.length === current.length && selected.every((id, index) => id === current[index])) {
      return;
    }
    this.#selectedIds = selected;
    this.#selectedSet = unique;
    this.#listener.onSelectionChanged({
      sequence: ++this.#sequence, origin, ids: selected, primaryId: this.primarySelectedId,
    });
  }

  #require(id: string): PageObject {
    const object = this.#objects.get(id);
    if (object === undefined) {
      throw new Error(`No object with id "${id}" exists.`);
    }
    return object;
  }
}

/** A frozen copy with defaults filled in, so neither the caller's object nor a listener can change what's stored. */
function frozenObject(object: NewPageObject): PageObject {
  return Object.freeze({
    kind: "rect",
    locked: false,
    selectable: true,
    ...object,
    rect: Object.freeze({ ...object.rect }),
    ...(object.style !== undefined && { style: Object.freeze({ ...object.style }) }),
  });
}
