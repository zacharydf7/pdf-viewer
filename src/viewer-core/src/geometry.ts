/**
 * Coordinate conversions between the public page space and the page as displayed.
 *
 * Page space is what public APIs use by default. Its origin is the top-left corner of the unrotated crop box, x grows
 * right, y grows down, and one unit is one PDF user-space unit. Rectangles stay attached to page content under any
 * rotation, whether it comes from the document's /Rotate or from the viewer.
 *
 * With the "display" coordinates option, the viewer passes in an upright geometry that includes UserUnit, so the
 * presented page acts as page space here.
 *
 * Display space has the same scale but is rotated to match what the user sees.
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A page's unrotated crop box size in page units, and its total clockwise rotation. */
export interface PageGeometry extends Size {
  rotation: Rotation;
}

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export function normalizeRotation(degrees: number): Rotation {
  const normalized = ((degrees % 360) + 360) % 360;
  if (normalized % 90 !== 0) {
    throw new RangeError(`Rotation must be a multiple of 90 degrees, but was ${degrees}.`);
  }
  return normalized as Rotation;
}

export function displaySize({ width, height, rotation }: PageGeometry): Size {
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

export function pageToDisplay({ width, height, rotation }: PageGeometry, { x, y }: Point): Point {
  switch (rotation) {
    case 0:
      return { x, y };
    case 90:
      return { x: height - y, y: x };
    case 180:
      return { x: width - x, y: height - y };
    case 270:
      return { x: y, y: width - x };
  }
}

export function displayToPage({ width, height, rotation }: PageGeometry, { x, y }: Point): Point {
  switch (rotation) {
    case 0:
      return { x, y };
    case 90:
      return { x: y, y: height - x };
    case 180:
      return { x: width - x, y: height - y };
    case 270:
      return { x: width - y, y: x };
  }
}

export function rectFromCorners(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function pageRectToDisplay(geometry: PageGeometry, rect: Rect): Rect {
  return rectFromCorners(
    pageToDisplay(geometry, { x: rect.x, y: rect.y }),
    pageToDisplay(geometry, { x: rect.x + rect.width, y: rect.y + rect.height }),
  );
}

export function displayRectToPage(geometry: PageGeometry, rect: Rect): Rect {
  return rectFromCorners(
    displayToPage(geometry, { x: rect.x, y: rect.y }),
    displayToPage(geometry, { x: rect.x + rect.width, y: rect.y + rect.height }),
  );
}

/** Converts a position given as a fraction of the displayed page into page space. */
export function fractionToPage(geometry: PageGeometry, fractionX: number, fractionY: number): Point {
  const size = displaySize(geometry);
  return displayToPage(geometry, { x: fractionX * size.width, y: fractionY * size.height });
}

/** Returns a page rectangle as percentages of the displayed page, ready for CSS. */
export function pageRectToPercent(geometry: PageGeometry, rect: Rect): Rect {
  const size = displaySize(geometry);
  const display = pageRectToDisplay(geometry, rect);
  return {
    x: (display.x / size.width) * 100,
    y: (display.y / size.height) * 100,
    width: (display.width / size.width) * 100,
    height: (display.height / size.height) * 100,
  };
}

export function clampPoint(geometry: PageGeometry, { x, y }: Point): Point {
  return { x: clamp(x, 0, geometry.width), y: clamp(y, 0, geometry.height) };
}

/** Moves a page rectangle by a displayed distance, keeping its size and keeping it on the page. */
export function moveRect(geometry: PageGeometry, rect: Rect, deltaX: number, deltaY: number): Rect {
  const size = displaySize(geometry);
  const display = pageRectToDisplay(geometry, rect);
  return displayRectToPage(geometry, {
    ...display,
    x: clamp(display.x + deltaX, 0, Math.max(0, size.width - display.width)),
    y: clamp(display.y + deltaY, 0, Math.max(0, size.height - display.height)),
  });
}

/**
 * Drags one handle of a page rectangle to a displayed position. Handles are named by where they appear on screen, so
 * they work the same at every rotation. The opposite edge stays fixed and the rectangle never gets smaller than
 * minimumSize, nor crosses over itself.
 */
export function resizeRect(geometry: PageGeometry, rect: Rect, handle: ResizeHandle, position: Point,
  minimumSize = 1): Rect {
  const size = displaySize(geometry);
  const display = pageRectToDisplay(geometry, rect);
  let left = display.x;
  let top = display.y;
  let right = display.x + display.width;
  let bottom = display.y + display.height;

  if (handle.includes("w")) {
    left = clamp(position.x, 0, Math.max(0, right - minimumSize));
  }
  if (handle.includes("e")) {
    right = clamp(position.x, Math.min(size.width, left + minimumSize), size.width);
  }
  if (handle.includes("n")) {
    top = clamp(position.y, 0, Math.max(0, bottom - minimumSize));
  }
  if (handle.includes("s")) {
    bottom = clamp(position.y, Math.min(size.height, top + minimumSize), size.height);
  }

  return displayRectToPage(geometry, { x: left, y: top, width: right - left, height: bottom - top });
}

/**
 * Rounds a page rectangle's edges to whole units without letting it extend past the page. Its size comes from the rounded
 * edges, because rounding the size separately could leave the far edge off by one.
 */
export function roundRect(geometry: PageGeometry, rect: Rect): Rect {
  const x = clamp(Math.round(rect.x), 0, geometry.width);
  const y = clamp(Math.round(rect.y), 0, geometry.height);
  const right = Math.min(Math.round(rect.x + rect.width), Math.floor(geometry.width));
  const bottom = Math.min(Math.round(rect.y + rect.height), Math.floor(geometry.height));
  return { x, y, width: Math.max(right - x, 0), height: Math.max(bottom - y, 0) };
}

/** Scale that fits a page into the available space, where pageSize is the displayed size at scale 1. */
export function fitScale(mode: "fit-width" | "fit-page", pageSize: Size, available: Size): number {
  const widthScale = available.width / pageSize.width;
  return mode === "fit-width" ? widthScale : Math.min(widthScale, available.height / pageSize.height);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
