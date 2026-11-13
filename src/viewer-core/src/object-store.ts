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
  /** The object's page, or null to show it on whichever page is displayed. */
  readonly page: number | null;
  readonly rect: Readonly<Rect>;
  /** The object's shape. Rectangles are the only one so far. */
  readonly shape: "rect";
  /** The application's own category for this object, such as "heading", shown as data-object-kind. */
  readonly kind?: string;
  /** A locked object can be selected, but not moved, resized or deleted by the user. */
  readonly locked: boolean;
  /** An unselectable object is displayed, but ignores pointer and keyboard input. */
  readonly selectable: boolean;
  /** A hidden object is neither visible nor reachable by pointer or keyboard, and keeps the rest of its state. */
  readonly hidden: boolean;
  /** The accessible name. Without one, it's "Object 3 on page 2" or similar, with a number unique on its page. */
  readonly label?: string;
  /** Classes from the application's own CSS, separated by spaces, so it can style states such as emphasis. */
  readonly cssClass?: string;
  /**
   * The application's own values, shown as data-app-* attributes so tests can find objects by them. Keys start with a
   * lowercase letter and contain only lowercase letters, digits and hyphens.
   */
  readonly appData?: Readonly<Record<string, string>>;
  readonly style?: Readonly<ObjectStyle>;
}

export type NewPageObject = Pick<PageObject, "id" | "page" | "rect"> & Partial<PageObject>;

export type ObjectPatch = Partial<Omit<PageObject, "id">>;

/** Whether a change came from the person using the viewer or from the host application's code. */
export type ChangeOrigin = "user" | "api";

/**
 * How the user changed an object's rectangle: "move" by dragging it, "resize" by dragging a handle or pressing Shift
 * with an arrow key, and "nudge" by pressing an arrow key without Shift, or through moveObjectBy on the element.
 */
export type EditGesture = "move" | "resize" | "nudge";

interface Change {
  /** Counts every change to objects and selection, so a listener can tell which of two is newer. */
  sequence: number;
  origin: ChangeOrigin;
}

export interface ObjectUpdate {
  object: PageObject;
  /** The object as it was before this change. */
  previous: PageObject;
  /** Present when the user changed the rectangle. */
  gesture?: EditGesture;
}

/** One change to the store's objects, however many objects it touched. Removed objects are as they were. */
export interface ObjectsChanged extends Change {
  added: readonly PageObject[];
  updated: readonly ObjectUpdate[];
  removed: readonly PageObject[];
}

/** Several changes applied as one, so listeners hear of them once. */
export interface ObjectBatch {
  /** Objects to add, or to replace whole where the id exists. One that equals the stored object changes nothing. */
  upsert?: readonly NewPageObject[];
  /** Ids to remove. Ids that don't exist are ignored. */
  remove?: readonly string[];
  /**
   * The sequence of the latest change the sender had heard of. When it's set, the batch leaves alone any object the
   * user changed after that, so a batch sent before the sender heard of a user's edit can't undo it.
   */
  basedOn?: number;
}

export interface SelectionChanged extends Change {
  /** Every selected object, in the order selected. */
  ids: readonly string[];
  /** The object selected last, or null when nothing is selected. */
  primaryId: string | null;
}

export interface ObjectStoreListener {
  onChanged(change: ObjectsChanged): void;
  onSelectionChanged(change: SelectionChanged): void;
  /** The user finished drawing an object, which the store now holds as a draft. */
  onDraftAdded(draft: PageObject): void;
  /** A draft became an object, or was discarded. */
  onDraftResolved(id: string, committed: boolean): void;
}

/** Whether an object shows on a page: its own, or any page for an object that isn't tied to one. */
export function isOnPage(object: PageObject, page: number): boolean {
  return object.page === null || object.page === page;
}

/** Holds every object in the document, including those on pages that are not currently displayed. */
export class ObjectStore {
  readonly #objects = new Map<string, PageObject>();
  /** What the user has drawn that isn't an object yet. A draft can't be read, changed or selected as an object. */
  readonly #drafts = new Map<string, PageObject>();
  readonly #listener: ObjectStoreListener;
  /** The sequence of the user's latest change to each object, removals included, for batches that give basedOn. */
  readonly #userChanges = new Map<string, number>();
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
    return this.all().filter((object) => isOnPage(object, page));
  }

  add(object: NewPageObject, origin: ChangeOrigin): PageObject {
    if (this.#objects.has(object.id)) {
      throw new Error(`An object with id "${object.id}" already exists.`);
    }
    const added = frozenObject(object);
    this.#commit([added], [], [], origin);
    return added;
  }

  update(id: string, patch: ObjectPatch, origin: ChangeOrigin, gesture?: EditGesture): PageObject {
    const previous = this.#require(id);
    const object = frozenObject({ ...previous, ...patch });
    this.#commit([], [{ object, previous, gesture }], [], origin);
    return object;
  }

  /** Adds an object, or replaces the one with its id. */
  upsert(object: NewPageObject, origin: ChangeOrigin): PageObject {
    this.apply({ upsert: [object] }, origin);
    return this.#objects.get(object.id)!;
  }

  /** Removes an object if it exists, and returns whether it did. */
  remove(id: string, origin: ChangeOrigin): boolean {
    const existing = this.#objects.get(id);
    if (existing !== undefined) {
      this.#commit([], [], [existing], origin);
    }
    return existing !== undefined;
  }

  /** Applies a batch as one change. Nothing changes if any object in it is invalid. */
  apply({ upsert = [], remove = [], basedOn }: ObjectBatch, origin: ChangeOrigin): void {
    const incoming = upsert.map(frozenObject);
    const ids = new Set(incoming.map((object) => object.id));
    if (ids.size !== incoming.length) {
      throw new Error("Object ids must be unique.");
    }
    const both = remove.find((id) => ids.has(id));
    if (both !== undefined) {
      throw new Error(`Object "${both}" can't be both upserted and removed.`);
    }
    const changedSince = (id: string) => basedOn !== undefined && (this.#userChanges.get(id) ?? 0) > basedOn;

    const added: PageObject[] = [];
    const updated: ObjectUpdate[] = [];
    for (const object of incoming) {
      const previous = this.#objects.get(object.id);
      if (changedSince(object.id)) {
        continue;
      }
      if (previous === undefined) {
        added.push(object);
      } else if (!sameValue(previous, object)) {
        updated.push({ object, previous });
      }
    }
    const removed = [...new Set(remove)].filter((id) => !changedSince(id))
      .flatMap((id) => this.#objects.get(id) ?? []);
    if (basedOn !== undefined) {
      this.#forgetUserChangesUpTo(basedOn);
    }
    this.#commit(added, updated, removed, origin);
  }

  /** Makes these the only objects, as one change. Selected objects that still exist stay selected. */
  replaceAll(objects: readonly NewPageObject[], origin: ChangeOrigin): void {
    const kept = new Set(objects.map((object) => object.id));
    this.apply({ upsert: objects, remove: [...this.#objects.keys()].filter((id) => !kept.has(id)) }, origin);
  }

  /**
   * Removes every object, discards every draft and forgets which objects the user changed, for when their document
   * closes. A batch for the next document must not skip an id just because the user edited an object with that id in
   * the last one.
   */
  clear(origin: ChangeOrigin): void {
    this.replaceAll([], origin);
    this.#userChanges.clear();
    for (const id of [...this.#drafts.keys()]) {
      this.discardDraft(id);
    }
  }

  draftsForPage(page: number): PageObject[] {
    return [...this.#drafts.values()].filter((draft) => draft.page === page);
  }

  /**
   * Holds an object the user drew as a draft. It becomes an object when it's committed, or when an object with its id
   * is added, which is how an application keeps it under values of its own.
   */
  addDraft(object: NewPageObject): void {
    const draft = frozenObject(object);
    this.#drafts.set(draft.id, draft);
    this.#listener.onDraftAdded(draft);
  }

  /** Adds a draft as an object, reported as a change the user made. Returns whether there was such a draft. */
  commitDraft(id: string): boolean {
    const draft = this.#drafts.get(id);
    if (draft !== undefined) {
      this.#commit([draft], [], [], "user");
    }
    return draft !== undefined;
  }

  /** Drops a draft without adding anything. Returns whether there was such a draft. */
  discardDraft(id: string): boolean {
    const existed = this.#drafts.delete(id);
    if (existed) {
      this.#listener.onDraftResolved(id, false);
    }
    return existed;
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

  /**
   * Stores a change and reports it once. Removed objects leave the selection first, as a change of its own, and
   * drafts the change committed are reported after it.
   */
  #commit(added: PageObject[], updated: ObjectUpdate[], removed: PageObject[], origin: ChangeOrigin): void {
    if (added.length + updated.length + removed.length === 0) {
      return;
    }
    if (removed.some(({ id }) => this.#selectedSet.has(id))) {
      const gone = new Set(removed.map(({ id }) => id));
      this.select(this.#selectedIds.filter((id) => !gone.has(id)), origin);
    }
    // An added object with a draft's id is that draft, committed.
    const committed = this.#drafts.size === 0 ? [] : added.filter(({ id }) => this.#drafts.delete(id));
    const sequence = ++this.#sequence;
    // Most changes touch one object, so this avoids building lists just to walk them.
    const noteUserChange = origin === "user" ? (id: string) => this.#userChanges.set(id, sequence) : undefined;
    for (const { id } of removed) {
      this.#objects.delete(id);
      noteUserChange?.(id);
    }
    for (const object of added) {
      this.#objects.set(object.id, object);
      noteUserChange?.(object.id);
    }
    for (const { object } of updated) {
      this.#objects.set(object.id, object);
      noteUserChange?.(object.id);
    }
    this.#listener.onChanged({ sequence, origin, added, updated, removed });
    for (const { id } of committed) {
      this.#listener.onDraftResolved(id, true);
    }
  }

  /** A sender that has heard of a change won't send a batch based on anything older, so it needn't be kept. */
  #forgetUserChangesUpTo(sequence: number): void {
    for (const [id, changed] of this.#userChanges) {
      if (changed <= sequence) {
        this.#userChanges.delete(id);
      }
    }
  }

  #require(id: string): PageObject {
    const object = this.#objects.get(id);
    if (object === undefined) {
      throw new Error(`No object with id "${id}" exists.`);
    }
    return object;
  }
}

/** Whether two values hold the same plain data, treating a missing property like an undefined one. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const first = a as Record<string, unknown>;
  const second = b as Record<string, unknown>;
  return [...new Set([...Object.keys(first), ...Object.keys(second)])]
    .every((key) => sameValue(first[key], second[key]));
}

const appDataKey = /^[a-z][a-z0-9-]*$/;

/** A frozen copy with defaults filled in, so neither the caller's object nor a listener can change what's stored. */
function frozenObject(object: NewPageObject): PageObject {
  return Object.freeze({
    shape: "rect",
    locked: false,
    selectable: true,
    hidden: false,
    ...object,
    rect: Object.freeze({ ...object.rect }),
    ...(object.style !== undefined && { style: Object.freeze({ ...object.style }) }),
    ...(object.appData !== undefined && { appData: frozenAppData(object.appData) }),
  });
}

/** Keys become attribute names, so they're checked when given, rather than failing when the object is displayed. */
export function checkAppDataKeys(appData: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(appData)) {
    if (!appDataKey.test(key)) {
      throw new Error(`App data key "${key}" must start with a lowercase letter and contain only lowercase letters, `
        + "digits and hyphens.");
    }
  }
}

function frozenAppData(appData: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  checkAppDataKeys(appData);
  return Object.freeze({ ...appData });
}
