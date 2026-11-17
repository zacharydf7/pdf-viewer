import type { PageGeometry, Rect } from "./geometry.js";
import { moveRect, resizeRectBy } from "./geometry.js";

/** A key held with an arrow key to move an object or take the large step. Shift isn't one, because it resizes. */
export type KeyModifier = "ctrl" | "alt" | "meta";

/** The parts of a keyboard event that decide what a key does. */
export interface KeyPress {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The viewer options that decide what keys do. */
export interface KeyOptions {
  keyboardEditing: boolean;
  keyboardStep: number;
  keyboardLargeStep: number;
  keyboardMoveModifier: KeyModifier;
  keyboardLargeStepModifier: KeyModifier;
}

/**
 * What a key does to the object list or the focused object:
 * - "focus" moves focus to another object, in focus order, without selecting it.
 * - "select" selects the focused object and "clear" clears the selection.
 * - "delete" asks for the focused object to be deleted.
 * - "edit" moves the object by a distance as displayed, or with resize, moves its bottom-right corner.
 */
export type KeyAction =
  | { kind: "focus"; to: "previous" | "next" | "first" | "last" }
  | { kind: "select" }
  | { kind: "clear" }
  | { kind: "delete" }
  | { kind: "edit"; resize: boolean; deltaX: number; deltaY: number };

const modifiers: readonly KeyModifier[] = ["ctrl", "alt", "meta"];

const focusKeys: Readonly<Record<string, "previous" | "next" | "first" | "last">> = {
  ArrowUp: "previous",
  ArrowLeft: "previous",
  ArrowDown: "next",
  ArrowRight: "next",
  Home: "first",
  End: "last",
};

/**
 * What a key does, following the listbox pattern. Arrow keys, Home and End move focus between objects, and Space or
 * Enter selects the focused one. With keyboard editing on, Escape clears the selection, Delete asks to delete, and an
 * arrow key held with the move modifier moves the object one step as displayed, so the direction on screen is the same
 * at every rotation. Adding Shift resizes it instead, and adding the large-step modifier takes the large step. Returns
 * undefined for anything else, which belongs to the browser or the host application.
 */
export function keyAction(press: KeyPress, options: KeyOptions): KeyAction | undefined {
  const held = modifiers.filter((modifier) => press[`${modifier}Key`]);
  if (held.length === 0 && !press.shiftKey) {
    const to = focusKeys[press.key];
    if (to !== undefined) {
      return { kind: "focus", to };
    }
    if (press.key === " " || press.key === "Enter") {
      return { kind: "select" };
    }
    if (options.keyboardEditing && press.key === "Escape") {
      return { kind: "clear" };
    }
    if (options.keyboardEditing && press.key === "Delete") {
      return { kind: "delete" };
    }
    return undefined;
  }
  if (!options.keyboardEditing || !press.key.startsWith("Arrow") || !held.includes(options.keyboardMoveModifier)
    || held.some((modifier) => modifier !== options.keyboardMoveModifier
      && modifier !== options.keyboardLargeStepModifier)) {
    return undefined;
  }
  const distance = held.includes(options.keyboardLargeStepModifier) ? options.keyboardLargeStep
    : options.keyboardStep;
  const deltaX = press.key === "ArrowLeft" ? -distance : press.key === "ArrowRight" ? distance : 0;
  const deltaY = press.key === "ArrowUp" ? -distance : press.key === "ArrowDown" ? distance : 0;
  return { kind: "edit", resize: press.shiftKey, deltaX, deltaY };
}

/** Where an edit key leaves a page rectangle. */
export function rectAfterEdit(geometry: PageGeometry, rect: Rect, edit: Extract<KeyAction, { kind: "edit" }>,
  minimumSize: number): Rect {
  return edit.resize
    ? resizeRectBy(geometry, rect, "se", edit.deltaX, edit.deltaY, minimumSize)
    : moveRect(geometry, rect, edit.deltaX, edit.deltaY);
}
