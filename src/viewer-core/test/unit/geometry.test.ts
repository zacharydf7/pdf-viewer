import { describe, expect, it } from "vitest";
import type { PageGeometry, Rect, Rotation } from "../../src/geometry.js";
import { displayRectToPage, displaySize, displayToPage, fitScale, fractionToPage, moveRect, normalizeRotation,
  pageRectToDisplay, pageRectToPercent, pageToDisplay, rectFromCorners, resizeRect, roundRect }
  from "../../src/geometry.js";

const rotations: readonly Rotation[] = [0, 90, 180, 270];
const page = (rotation: Rotation): PageGeometry => ({ width: 600, height: 800, rotation });
const rect: Rect = { x: 100, y: 150, width: 200, height: 100 };

describe("normalizeRotation", () => {
  it.each([[0, 0], [90, 90], [360, 0], [450, 90], [-90, 270], [-450, 270]])(
    "normalizeRotation_ShouldReturnEquivalentAngle_WhenGiven%i", (input, expected) => {
      expect(normalizeRotation(input)).toBe(expected);
    });

  it("normalizeRotation_ShouldThrow_WhenGivenNonRightAngle", () => {
    expect(() => normalizeRotation(45)).toThrow(RangeError);
  });
});

describe("displaySize", () => {
  it.each([[0, 600, 800], [90, 800, 600], [180, 600, 800], [270, 800, 600]] as const)(
    "displaySize_ShouldSwapOnlyForQuarterTurns_WhenRotatedBy%i", (rotation, width, height) => {
      expect(displaySize(page(rotation))).toEqual({ width, height });
    });
});

describe("pageToDisplay", () => {
  // The page's top-left corner moves clockwise around the displayed page as rotation increases.
  it.each([[0, 0, 0], [90, 800, 0], [180, 600, 800], [270, 0, 600]] as const)(
    "pageToDisplay_ShouldMoveTopLeftCornerClockwise_WhenRotatedBy%i", (rotation, x, y) => {
      expect(pageToDisplay(page(rotation), { x: 0, y: 0 })).toEqual({ x, y });
    });

  it.each(rotations)("displayToPage_ShouldInvertPageToDisplay_WhenRotatedBy%i", (rotation) => {
    const point = { x: 123, y: 456 };
    expect(displayToPage(page(rotation), pageToDisplay(page(rotation), point))).toEqual(point);
  });
});

describe("rectangle conversion", () => {
  it.each(rotations)("displayRectToPage_ShouldInvertPageRectToDisplay_WhenRotatedBy%i", (rotation) => {
    expect(displayRectToPage(page(rotation), pageRectToDisplay(page(rotation), rect))).toEqual(rect);
  });

  it("pageRectToDisplay_ShouldSwapSides_WhenRotatedByQuarterTurn", () => {
    expect(pageRectToDisplay(page(90), rect)).toEqual({ x: 550, y: 100, width: 100, height: 200 });
  });

  it("pageRectToPercent_ShouldBeRelativeToDisplayedPage_WhenRotatedByQuarterTurn", () => {
    const percent = pageRectToPercent(page(90), { x: 0, y: 0, width: 600, height: 400 });
    expect(percent).toEqual({ x: 50, y: 0, width: 50, height: 100 });
  });

  it("rectFromCorners_ShouldNormalize_WhenCornersAreReversed", () => {
    expect(rectFromCorners({ x: 30, y: 40 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 20, height: 20 });
  });

  it.each(rotations)("fractionToPage_ShouldMatchDisplayedPosition_WhenRotatedBy%i", (rotation) => {
    const geometry = page(rotation);
    const size = displaySize(geometry);
    const display = pageToDisplay(geometry, { x: 150, y: 200 });
    const point = fractionToPage(geometry, display.x / size.width, display.y / size.height);
    expect(point.x).toBeCloseTo(150);
    expect(point.y).toBeCloseTo(200);
  });
});

describe("moveRect", () => {
  it("moveRect_ShouldMoveInDisplayedDirection_WhenRotatedByQuarterTurn", () => {
    // Moving right on screen at 90 degrees means moving toward the top of the unrotated page.
    expect(moveRect(page(90), rect, 10, 0)).toEqual({ ...rect, y: 140 });
  });

  it.each(rotations)("moveRect_ShouldKeepSizeAndStayOnPage_WhenMovedPastEdgeAtRotation%i", (rotation) => {
    const moved = moveRect(page(rotation), rect, 5000, 5000);
    expect(moved.width).toBe(rect.width);
    expect(moved.height).toBe(rect.height);
    expect(moved.x).toBeGreaterThanOrEqual(0);
    expect(moved.y).toBeGreaterThanOrEqual(0);
    expect(moved.x + moved.width).toBeLessThanOrEqual(600);
    expect(moved.y + moved.height).toBeLessThanOrEqual(800);
  });
});

describe("resizeRect", () => {
  it("resizeRect_ShouldKeepOppositeCornerFixed_WhenDraggingBottomRightHandle", () => {
    expect(resizeRect(page(0), rect, "se", { x: 400, y: 300 })).toEqual({ x: 100, y: 150, width: 300, height: 150 });
  });

  it("resizeRect_ShouldChangeOneDimension_WhenDraggingEdgeHandle", () => {
    expect(resizeRect(page(0), rect, "e", { x: 400, y: 9999 })).toEqual({ ...rect, width: 300 });
  });

  it("resizeRect_ShouldStopAtMinimumSize_WhenDraggedPastOppositeEdge", () => {
    expect(resizeRect(page(0), rect, "e", { x: 0, y: 0 }, 5)).toEqual({ ...rect, width: 5 });
    expect(resizeRect(page(0), rect, "n", { x: 0, y: 999 }, 5)).toEqual({ ...rect, y: 245, height: 5 });
  });

  it("resizeRect_ShouldStopAtPageEdge_WhenDraggedOffPage", () => {
    expect(resizeRect(page(0), rect, "se", { x: 9999, y: 9999 })).toEqual({ x: 100, y: 150, width: 500, height: 650 });
  });

  it("resizeRect_ShouldUseDisplayedHandlePosition_WhenRotatedByQuarterTurn", () => {
    // Displayed at 90 degrees, the rectangle spans x 550 to 650 and y 100 to 300. Its displayed right edge is the
    // page rectangle's top edge, so dragging that edge further right grows the rectangle toward y 0.
    expect(resizeRect(page(90), rect, "e", { x: 700, y: 0 })).toEqual({ x: 100, y: 100, width: 200, height: 150 });
  });
});

describe("roundRect", () => {
  it("roundRect_ShouldRoundEveryValue_WhenRectangleIsInsidePage", () => {
    const rounded = roundRect(page(0), { x: 10.4, y: 20.6, width: 30.5, height: 40.2 });
    expect(rounded).toEqual({ x: 10, y: 21, width: 31, height: 40 });
  });

  it("roundRect_ShouldStayOnPage_WhenRoundingWouldPassEdge", () => {
    const rounded = roundRect(page(0), { x: 500.6, y: 700.6, width: 99.4, height: 99.4 });
    expect(rounded).toEqual({ x: 501, y: 701, width: 99, height: 99 });
  });

  it("roundRect_ShouldStayOnPage_WhenPageSizeIsFractional", () => {
    const fractional: PageGeometry = { width: 100.5, height: 100.5, rotation: 0 };
    const rounded = roundRect(fractional, { x: 0, y: 0, width: 100.5, height: 100.5 });
    expect(rounded).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe("fitScale", () => {
  it("fitScale_ShouldUseWidthOnly_WhenFittingWidth", () => {
    expect(fitScale("fit-width", { width: 500, height: 1000 }, { width: 1000, height: 100 })).toBe(2);
  });

  it("fitScale_ShouldUseTighterDimension_WhenFittingPage", () => {
    expect(fitScale("fit-page", { width: 500, height: 1000 }, { width: 1000, height: 100 })).toBe(0.1);
  });
});
