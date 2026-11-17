import type { PageGeometry, Point, Rect, ResizeHandle } from "./geometry.js";
import { roundRect } from "./geometry.js";
import type { KeyAction, KeyOptions } from "./keyboard-editing.js";
import type { EditGesture, ObjectStore, ObjectStyle, PageObject } from "./object-store.js";

export type ViewerTool = "select" | "draw-rect" | "none";

export interface DrawDefaults {
  style?: ObjectStyle;
  label?: string;
  kind?: string;
  cssClass?: string;
  appData?: Readonly<Record<string, string>>;
}

/** What the pointer was pressed on: an object, or one of the selected object's resize handles. */
export type PointerTarget =
  | { kind: "object"; id: string }
  | { kind: "handle"; id: string; handle: ResizeHandle };

/** A pointer position, measured against one page. */
export interface PointerInput {
  page: number;
  /** The page's geometry when the input arrived. */
  geometry: PageGeometry;
  /** The position in page space. It isn't clamped, so during a drag it can be off the page. */
  point: Point;
}

export interface PointerPress extends PointerInput {
  target: PointerTarget | undefined;
}

/**
 * What a key does to an object: the focused one, or for a key pressed in the keyboard scope outside the viewer, the
 * selected one. Moving focus between objects isn't a tool's job, so it never arrives here.
 */
export interface ObjectKeyPress {
  id: string;
  /** The geometry of the object's page. */
  geometry: PageGeometry;
  action: Exclude<KeyAction, { kind: "focus" }>;
}

/**
 * What a gesture shows before it finishes: a draft rectangle, styled with the defaults the drawn object will get, or
 * an object away from where the store has it.
 */
export type Preview =
  | { kind: "draft"; page: number; rect: Rect; defaults: DrawDefaults }
  | { kind: "object"; id: string; rect: Rect };

export interface PressResult {
  /** Whether a gesture started. The pointer's moves and release then go to the tool. */
  gesture: boolean;
  /** An object to focus. Starting a gesture stops the browser from moving focus, so the tool asks for it here. */
  focus?: string;
}

/** How objects and the page respond while a tool is active. */
export interface ToolPresentation {
  /** What catches the pointer: objects and their handles, the whole page, or nothing. */
  pointer: "objects" | "page" | "none";
  /**
   * Whether selectable objects can take focus. Tab reaches one of them at a time, the object list's single tab stop.
   */
  focusable: boolean;
  /** Whether the selected object shows resize handles. */
  handles: boolean;
  /** Whether the viewer is read-only, so that only objects marked editableWhenReadOnly respond. */
  readOnly: boolean;
}

/**
 * Whether an object responds to the user: it's selectable, and while the viewer is read-only it's marked to stay
 * editable.
 */
export function respondsToUser(object: PageObject, readOnly: boolean): boolean {
  return object.selectable && (!readOnly || object.editableWhenReadOnly);
}

/** The viewer options that tools use. */
export interface ToolOptions extends KeyOptions {
  /** Whether an object that takes focus is selected too. */
  selectOnFocus: boolean;
  roundCoordinates: boolean;
}

/** What a tool works with. It reads and changes objects only through the store, and never touches the DOM. */
export interface ToolContext {
  store: ObjectStore;
  /** The viewer's options as they are now. They can change while a tool is active, even during a gesture. */
  readonly options: ToolOptions;
  /** Shows a gesture's preview, or clears it when given undefined, which puts objects back where the store has them. */
  show(preview: Preview | undefined): void;
  /** Asks for an object to be deleted, which the application may decide on itself. */
  requestDelete(id: string): void;
  /**
   * Tells screen reader users where a key moved an object or what size it made it, which they otherwise can't
   * perceive. The rectangle is the one shown, which the store gets when the run of keys ends.
   */
  announceEdit(id: string, rect: Rect, resized: boolean): void;
}

/**
 * A way of working with objects, such as selecting or drawing. A tool owns its gesture's state and commits through the
 * store. It gets input in page space, so it can be tested without a browser.
 */
export interface Tool {
  readonly presentation: ToolPresentation;
  pointerDown(input: PointerPress): PressResult;
  pointerMove(input: PointerInput): void;
  /** Finishes the gesture. The release position counts, even if no move came before it. */
  pointerUp(input: PointerInput): void;
  /** Ends any gesture without changing anything. Returns whether one was under way. */
  cancel(): boolean;
  /** Called when an object takes focus. */
  focus?(id: string): void;
  /**
   * Called after every change to the store's objects, so a gesture can end right away if its object was removed or
   * left the page.
   */
  objectsChanged?(): void;
  /** Returns whether the tool handled the key. A key it doesn't handle goes on to the host application. */
  keyDown?(input: ObjectKeyPress): boolean;
  /** Ends a run of keys that moved or resized an object, which the store then gets as one change. */
  endKeyEdit?(): void;
}

/** The smallest width and height a resize leaves, in page units. */
export const minimumResizeSize = 1;

/** Whether an edit's object was removed, hidden or moved to another page since the edit began. */
export function isGone(store: ObjectStore, { id, page }: { id: string; page: number | null }): boolean {
  const object = store.get(id);
  return object?.page !== page || object.hidden;
}

/** A rectangle the user made, rounded to whole page units when coordinate rounding is on. */
export function finalRect(geometry: PageGeometry, rect: Rect, roundCoordinates: boolean): Rect {
  return roundCoordinates ? roundRect(geometry, rect) : rect;
}

/**
 * Stores the rectangle the user gave an object. One that rounds back to the rectangle the object has isn't a change,
 * so it doesn't reach the store.
 */
export function commitRect(store: ObjectStore, id: string, rect: Rect, gesture: EditGesture, geometry: PageGeometry,
  roundCoordinates: boolean): void {
  const final = finalRect(geometry, rect, roundCoordinates);
  const current = store.get(id)!.rect;
  if (final.x !== current.x || final.y !== current.y || final.width !== current.width
    || final.height !== current.height) {
    store.update(id, { rect: final }, "user", gesture);
  }
}
