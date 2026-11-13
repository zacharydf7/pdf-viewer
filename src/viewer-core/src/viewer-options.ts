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
  roundCoordinates: false,
  selectOnCreate: true,
  wheelZoom: true,
  coordinates: "page",
  objectHitArea: "fill",
});

const minimumZoom = 0.1;
const maximumZoom = 10;

/** Applies options over the current ones. Any option left out keeps its value, and so does a zoom that isn't finite. */
export function mergeOptions(current: ResolvedOptions, options: ViewerOptions): ResolvedOptions {
  const zoom = options.initialZoom === undefined ? undefined : normalizeZoom(options.initialZoom);
  return {
    initialZoom: zoom ?? current.initialZoom,
    hideFormFields: options.hideFormFields ?? current.hideFormFields,
    keyboardEditing: options.keyboardEditing ?? current.keyboardEditing,
    roundCoordinates: options.roundCoordinates ?? current.roundCoordinates,
    selectOnCreate: options.selectOnCreate ?? current.selectOnCreate,
    wheelZoom: options.wheelZoom ?? current.wheelZoom,
    coordinates: options.coordinates ?? current.coordinates,
    objectHitArea: options.objectHitArea ?? current.objectHitArea,
  };
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
