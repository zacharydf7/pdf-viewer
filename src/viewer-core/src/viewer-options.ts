import type { StepModifier } from "./keyboard-editing.js";

export type ZoomSetting = number | "fit-width" | "fit-page";

export interface ViewerOptions {
  /**
   * The zoom to start with. Defaults to fit-width. Only a change made while no document is open takes effect, because
   * the zoom carries over from one document to the next.
   */
  initialZoom?: ZoomSetting;
  /** Leaves form fields unpainted, while other annotations still appear. Defaults to false. */
  hideFormFields?: boolean;
  /**
   * Whether arrow keys and Delete edit the focused object and Escape clears the selection. Turn off if the application
   * handles them. Defaults to true.
   */
  keyboardEditing?: boolean;
  /** How far an arrow key moves or resizes the focused object, in page units. Defaults to 1. */
  keyboardStep?: number;
  /** How far an arrow key goes while the large-step modifier is held, in page units. Defaults to 10. */
  keyboardLargeStep?: number;
  /**
   * The key that, held with an arrow key, takes the large step. Shift can't be it, because it resizes. Defaults to
   * "ctrl".
   */
  keyboardLargeStepModifier?: StepModifier;
  /** Rounds rectangles the user creates or changes to whole page units. Defaults to false. */
  roundCoordinates?: boolean;
  /** Whether an object the user draws is selected once it's one of the viewer's objects. Defaults to true. */
  selectOnCreate?: boolean;
  /** Whether Ctrl+wheel and pinch gestures zoom. Defaults to true. */
  wheelZoom?: boolean;
  /**
   * What object rectangles are measured against. "page" stays attached to the page's content at any rotation. "display"
   * is the page as presented after rotation, including its UserUnit, so a rectangle keeps its numbers when a page
   * rotates. Defaults to "page".
   */
  coordinates?: "page" | "display";
  /**
   * Where an object catches the pointer. "fill" is its whole area. "border" is a band along its edges, so objects inside
   * or behind it stay reachable, while a selected or very small object still catches the pointer everywhere. Defaults
   * to "fill".
   */
  objectHitArea?: "fill" | "border";
}

/** Every option, with defaults for those never set. */
export type ResolvedOptions = Required<ViewerOptions>;

export const defaultOptions: ResolvedOptions = Object.freeze({
  initialZoom: "fit-width",
  hideFormFields: false,
  keyboardEditing: true,
  keyboardStep: 1,
  keyboardLargeStep: 10,
  keyboardLargeStepModifier: "ctrl",
  roundCoordinates: false,
  selectOnCreate: true,
  wheelZoom: true,
  coordinates: "page",
  objectHitArea: "fill",
});

const minimumZoom = 0.1;
const maximumZoom = 10;

/**
 * Applies options over the current ones. Any option left out keeps its value. So does a zoom that isn't finite, and a
 * keyboard step that isn't a positive number.
 */
export function mergeOptions(current: ResolvedOptions, options: ViewerOptions): ResolvedOptions {
  const zoom = options.initialZoom === undefined ? undefined : normalizeZoom(options.initialZoom);
  return {
    initialZoom: zoom ?? current.initialZoom,
    hideFormFields: options.hideFormFields ?? current.hideFormFields,
    keyboardEditing: options.keyboardEditing ?? current.keyboardEditing,
    keyboardStep: positive(options.keyboardStep) ?? current.keyboardStep,
    keyboardLargeStep: positive(options.keyboardLargeStep) ?? current.keyboardLargeStep,
    keyboardLargeStepModifier: options.keyboardLargeStepModifier ?? current.keyboardLargeStepModifier,
    roundCoordinates: options.roundCoordinates ?? current.roundCoordinates,
    selectOnCreate: options.selectOnCreate ?? current.selectOnCreate,
    wheelZoom: options.wheelZoom ?? current.wheelZoom,
    coordinates: options.coordinates ?? current.coordinates,
    objectHitArea: options.objectHitArea ?? current.objectHitArea,
  };
}

/** The value, if it's a number an arrow key can step by. */
function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Whether a change of options alters how the displayed page is painted or measured, so it has to repaint. */
export function needsRepaint(before: ResolvedOptions, after: ResolvedOptions): boolean {
  return before.hideFormFields !== after.hideFormFields || before.coordinates !== after.coordinates;
}

/** Keeps a zoom within limits, or returns undefined for a number that isn't finite. */
export function normalizeZoom(zoom: ZoomSetting): ZoomSetting | undefined {
  if (typeof zoom !== "number") {
    return zoom;
  }
  return Number.isFinite(zoom) ? Math.min(Math.max(zoom, minimumZoom), maximumZoom) : undefined;
}
