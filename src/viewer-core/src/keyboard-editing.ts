import type { PageGeometry, Rect } from "./geometry.js";
import { moveRect, resizeRectBy } from "./geometry.js";

const step = 1;
const largeStep = 10;

/** The parts of a keyboard event that decide an edit. */
export interface ArrowKeyPress {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
}

/**
 * Where an arrow key leaves a page rectangle. An arrow key moves it one unit as displayed, so the direction on screen
 * is the same at every rotation. With Shift it moves the displayed bottom-right corner instead, which resizes the
 * rectangle. With Ctrl the step is ten units.
 */
export function rectAfterArrowKey(geometry: PageGeometry, rect: Rect, { key, shiftKey, ctrlKey }: ArrowKeyPress,
  minimumSize: number): Rect {
  const distance = ctrlKey ? largeStep : step;
  const deltaX = key === "ArrowLeft" ? -distance : key === "ArrowRight" ? distance : 0;
  const deltaY = key === "ArrowUp" ? -distance : key === "ArrowDown" ? distance : 0;
  return shiftKey
    ? resizeRectBy(geometry, rect, "se", deltaX, deltaY, minimumSize)
    : moveRect(geometry, rect, deltaX, deltaY);
}
