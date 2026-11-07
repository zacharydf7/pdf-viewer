import type { Rect } from "./geometry.js";

export interface ObjectStyle {
  /** Border color, as any CSS color. */
  color?: string;
  /** Fill color, as any CSS color. */
  fill?: string;
  /** Border width, as any CSS length. */
  borderWidth?: string;
}

/** An app-defined object on a page. Its rectangle is in page space, as described in geometry.ts. */
export interface PageObject {
  id: string;
  page: number;
  rect: Rect;
  kind: "rect";
  /** A locked object can be selected, but not moved, resized or deleted by the user. */
  locked: boolean;
  /** An unselectable object is displayed, but ignores pointer and keyboard input. */
  selectable: boolean;
  label?: string;
  /** The application's own category for this object, carried unchanged through events and shown as data-object-tag. */
  tag?: string;
  style?: ObjectStyle;
}

export type NewPageObject = Pick<PageObject, "id" | "page" | "rect"> & Partial<PageObject>;

/** Whether a change came from the person using the viewer or from the host application's code. */
export type ChangeOrigin = "user" | "api";

export type ObjectChange =
  | { sequence: number; origin: ChangeOrigin; kind: "added" | "updated" | "removed"; object: PageObject }
  | { sequence: number; origin: ChangeOrigin; kind: "replaced" };

export interface SelectionChange {
  sequence: number;
  origin: ChangeOrigin;
  id: string | null;
}

export interface ObjectStoreListener {
  onChange(change: ObjectChange): void;
  onSelectionChange(change: SelectionChange): void;
}

/** Holds every object in the document, including those on pages that are not currently displayed. */
export class ObjectStore {
  readonly #objects = new Map<string, PageObject>();
  readonly #listener: ObjectStoreListener;
  #selectedId: string | null = null;
  #sequence = 0;

  constructor(listener: ObjectStoreListener) {
    this.#listener = listener;
  }

  get selectedId(): string | null {
    return this.#selectedId;
  }

  get sequence(): number {
    return this.#sequence;
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
    const added = withDefaults(object);
    this.#objects.set(added.id, added);
    this.#listener.onChange({ sequence: ++this.#sequence, origin, kind: "added", object: added });
    return added;
  }

  update(id: string, patch: Partial<Omit<PageObject, "id">>, origin: ChangeOrigin): PageObject {
    const existing = this.#require(id);
    const updated = { ...existing, ...patch };
    this.#objects.set(id, updated);
    this.#listener.onChange({ sequence: ++this.#sequence, origin, kind: "updated", object: updated });
    return updated;
  }

  remove(id: string, origin: ChangeOrigin): void {
    const existing = this.#require(id);
    if (this.#selectedId === id) {
      this.select(null, origin);
    }
    this.#objects.delete(id);
    this.#listener.onChange({ sequence: ++this.#sequence, origin, kind: "removed", object: existing });
  }

  /** Replaces every object in one step. The selection is kept if the selected object still exists. */
  replaceAll(objects: readonly NewPageObject[], origin: ChangeOrigin): void {
    const replacement = objects.map(withDefaults);
    const ids = new Set(replacement.map((object) => object.id));
    if (ids.size !== replacement.length) {
      throw new Error("Object ids must be unique.");
    }
    if (this.#selectedId !== null && !ids.has(this.#selectedId)) {
      this.select(null, origin);
    }
    this.#objects.clear();
    for (const object of replacement) {
      this.#objects.set(object.id, object);
    }
    this.#listener.onChange({ sequence: ++this.#sequence, origin, kind: "replaced" });
  }

  select(id: string | null, origin: ChangeOrigin): void {
    if (id !== null) {
      this.#require(id);
    }
    if (this.#selectedId === id) {
      return;
    }
    this.#selectedId = id;
    this.#listener.onSelectionChange({ sequence: ++this.#sequence, origin, id });
  }

  #require(id: string): PageObject {
    const object = this.#objects.get(id);
    if (object === undefined) {
      throw new Error(`No object with id "${id}" exists.`);
    }
    return object;
  }
}

function withDefaults(object: NewPageObject): PageObject {
  return { kind: "rect", locked: false, selectable: true, ...object };
}
