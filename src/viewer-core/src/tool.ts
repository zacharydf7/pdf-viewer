import type { PageGeometry, Point, Rect, ResizeHandle } from "./geometry.js";
import { roundRect } from "./geometry.js";
import type { ArrowKeyPress } from "./keyboard-editing.js";
import type { ObjectStore, ObjectStyle } from "./object-store.js";

export type ViewerTool = "select" | "draw-rect" | "none";

export interface DrawDefaults {
  style?: ObjectStyle;
  label?: string;
  tag?: string;
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

/** A key pressed while an object has focus. */
export interface ObjectKeyPress extends ArrowKeyPress {
  id: string;
  /** The geometry of the object's page. */
  geometry: PageGeometry;
}

/** What a gesture shows before it finishes: a draft rectangle, or an object away from where the store has it. */
export type Preview =
  | { kind: "draft"; page: number; rect: Rect }
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
  /** Whether selectable objects are tab stops. */
  focusable: boolean;
  /** Whether the selected object shows resize handles. */
  handles: boolean;
}

/** The viewer options that tools use. */
export interface ToolOptions {
  /** Whether arrow keys and Delete edit the focused object and Escape clears the selection. */
  keyboardEditing: boolean;
  roundCoordinates: boolean;
  /** Applied to every rectangle drawn. */
  drawDefaults: DrawDefaults;
}

/** What a tool works with. It reads and changes objects only through the store, and never touches the DOM. */
export interface ToolContext {
  store: ObjectStore;
  /** Shows a gesture's preview, or clears it when given undefined, which puts objects back where the store has them. */
  show(preview: Preview | undefined): void;
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
}

/** A rectangle the user made, rounded to whole page units when coordinate rounding is on. */
export function finalRect(geometry: PageGeometry, rect: Rect, roundCoordinates: boolean): Rect {
  return roundCoordinates ? roundRect(geometry, rect) : rect;
}
