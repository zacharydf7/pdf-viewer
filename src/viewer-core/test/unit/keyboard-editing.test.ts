import { describe, expect, it } from "vitest";
import type { PageGeometry, Rect, Rotation } from "../../src/geometry.js";
import { rectAfterArrowKey } from "../../src/keyboard-editing.js";

const page = (rotation: Rotation): PageGeometry => ({ width: 600, height: 800, rotation });
const rect: Rect = { x: 100, y: 150, width: 200, height: 100 };

function press(key: string, rotation: Rotation = 0, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {},
  from = rect): Rect {
  return rectAfterArrowKey(page(rotation), from, { key, shiftKey: false, ctrlKey: false, ...modifiers }, 1);
}

describe("moving", () => {
  // Each row is the page-space change that moves the rectangle one unit in the key's direction on screen.
  it.each([
    [0, "ArrowRight", 1, 0], [0, "ArrowLeft", -1, 0], [0, "ArrowDown", 0, 1], [0, "ArrowUp", 0, -1],
    [90, "ArrowRight", 0, -1], [90, "ArrowLeft", 0, 1], [90, "ArrowDown", 1, 0], [90, "ArrowUp", -1, 0],
    [180, "ArrowRight", -1, 0], [180, "ArrowLeft", 1, 0], [180, "ArrowDown", 0, -1], [180, "ArrowUp", 0, 1],
    [270, "ArrowRight", 0, 1], [270, "ArrowLeft", 0, -1], [270, "ArrowDown", -1, 0], [270, "ArrowUp", 1, 0],
  ] as const)("rectAfterArrowKey_ShouldMoveOneUnitOnScreen_WhenRotatedBy%iAndGiven%s", (rotation, key, x, y) => {
    expect(press(key, rotation)).toEqual({ ...rect, x: rect.x + x, y: rect.y + y });
  });

  it.each([["ArrowRight", 10, 0], ["ArrowLeft", -10, 0], ["ArrowDown", 0, 10], ["ArrowUp", 0, -10]] as const)(
    "rectAfterArrowKey_ShouldMoveTenUnits_WhenGivenCtrlWith%s", (key, x, y) => {
      expect(press(key, 0, { ctrlKey: true })).toEqual({ ...rect, x: rect.x + x, y: rect.y + y });
    });

  it.each([
    ["ArrowLeft", { ...rect, x: 0 }], ["ArrowUp", { ...rect, y: 0 }],
    ["ArrowRight", { ...rect, x: 400 }], ["ArrowDown", { ...rect, y: 700 }],
  ] as const)("rectAfterArrowKey_ShouldStayOnPage_WhenGiven%sAtThatEdge", (key, atEdge) => {
    expect(press(key, 0, { ctrlKey: true }, atEdge)).toEqual(atEdge);
  });
});

describe("resizing", () => {
  it.each([
    ["ArrowRight", 1, 0], ["ArrowLeft", -1, 0], ["ArrowDown", 0, 1], ["ArrowUp", 0, -1],
  ] as const)("rectAfterArrowKey_ShouldMoveBottomRightCorner_WhenGivenShiftWith%s", (key, width, height) => {
    expect(press(key, 0, { shiftKey: true }))
      .toEqual({ ...rect, width: rect.width + width, height: rect.height + height });
  });

  it("rectAfterArrowKey_ShouldResizeByTenUnits_WhenGivenShiftAndCtrl", () => {
    expect(press("ArrowRight", 0, { shiftKey: true, ctrlKey: true })).toEqual({ ...rect, width: 210 });
  });

  // The corner shown at the bottom right is a different corner of the page rectangle at each rotation: its top-right
  // corner at 90 degrees, top-left at 180 and bottom-left at 270.
  it.each([
    [90, "ArrowRight", { y: 149, height: 101 }], [90, "ArrowLeft", { y: 151, height: 99 }],
    [90, "ArrowDown", { width: 201 }], [90, "ArrowUp", { width: 199 }],
    [180, "ArrowRight", { x: 99, width: 201 }], [180, "ArrowLeft", { x: 101, width: 199 }],
    [180, "ArrowDown", { y: 149, height: 101 }], [180, "ArrowUp", { y: 151, height: 99 }],
    [270, "ArrowRight", { height: 101 }], [270, "ArrowLeft", { height: 99 }],
    [270, "ArrowDown", { x: 99, width: 201 }], [270, "ArrowUp", { x: 101, width: 199 }],
  ] as const)("rectAfterArrowKey_ShouldMoveCornerShownAtBottomRight_WhenRotatedBy%iAndGivenShiftWith%s",
    (rotation, key, change) => {
      expect(press(key, rotation, { shiftKey: true })).toEqual({ ...rect, ...change });
    });

  it("rectAfterArrowKey_ShouldStopAtMinimumSize_WhenShrinkingPastIt", () => {
    const small = { ...rect, width: 5 };

    expect(press("ArrowLeft", 0, { shiftKey: true, ctrlKey: true }, small)).toEqual({ ...rect, width: 1 });
  });
});
