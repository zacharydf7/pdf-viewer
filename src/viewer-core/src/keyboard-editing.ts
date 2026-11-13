import type { PageGeometry, Rect } from "./geometry.js";
import { moveRect, resizeRectBy } from "./geometry.js";

/** A key that can be held with an arrow key to take the large step. Shift isn't one, because it resizes. */
export type StepModifier = "ctrl" | "alt" | "meta";

/** The parts of a keyboard event that decide an edit. */
export interface ArrowKeyPress {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The viewer options that set how far an arrow key goes. */
export interface ArrowKeySteps {
  keyboardStep: number;
  keyboardLargeStep: number;
  keyboardLargeStepModifier: StepModifier;
}

const stepModifiers: readonly StepModifier[] = ["ctrl", "alt", "meta"];

/**
 * Where an arrow key leaves a page rectangle. An arrow key moves it one step as displayed, so the direction on screen
 * is the same at every rotation. With Shift it moves the displayed bottom-right corner instead, which resizes the
 * rectangle. With the large-step modifier it goes the large step. Returns undefined when Ctrl, Alt or Meta is held
 * and isn't the large-step modifier, because that combination belongs to the browser or the host application.
 */
export function rectAfterArrowKey(geometry: PageGeometry, rect: Rect, press: ArrowKeyPress, steps: ArrowKeySteps,
  minimumSize: number): Rect | undefined {
  const { key, shiftKey } = press;
  const held = stepModifiers.filter((modifier) => press[`${modifier}Key`]);
  if (held.some((modifier) => modifier !== steps.keyboardLargeStepModifier)) {
    return undefined;
  }
  const distance = held.length > 0 ? steps.keyboardLargeStep : steps.keyboardStep;
  const deltaX = key === "ArrowLeft" ? -distance : key === "ArrowRight" ? distance : 0;
  const deltaY = key === "ArrowUp" ? -distance : key === "ArrowDown" ? distance : 0;
  return shiftKey
    ? resizeRectBy(geometry, rect, "se", deltaX, deltaY, minimumSize)
    : moveRect(geometry, rect, deltaX, deltaY);
}
