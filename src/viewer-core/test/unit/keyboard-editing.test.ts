import { describe, expect, it } from "vitest";
import type { PageGeometry, Rect, Rotation } from "../../src/geometry.js";
import type { ArrowKeySteps } from "../../src/keyboard-editing.js";
import { rectAfterArrowKey } from "../../src/keyboard-editing.js";

const page = (rotation: Rotation): PageGeometry => ({ width: 600, height: 800, rotation });
const rect: Rect = { x: 100, y: 150, width: 200, height: 100 };

const defaultSteps: ArrowKeySteps = { keyboardStep: 1, keyboardLargeStep: 10, keyboardLargeStepModifier: "ctrl" };
type Modifiers = { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean };

function press(key: string, rotation: Rotation = 0, modifiers: Modifiers = {}, from = rect, steps = defaultSteps):
  Rect | undefined {
  const keys = { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers };
  return rectAfterArrowKey(page(rotation), from, keys, steps, 1);
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

describe("configured steps", () => {
  const steps: ArrowKeySteps = { keyboardStep: 5, keyboardLargeStep: 25, keyboardLargeStepModifier: "alt" };

  it("rectAfterArrowKey_ShouldMoveByConfiguredStep_WhenGivenArrowKeyAlone", () => {
    expect(press("ArrowRight", 0, {}, rect, steps)).toEqual({ ...rect, x: 105 });
  });

  it("rectAfterArrowKey_ShouldMoveByLargeStep_WhenGivenConfiguredModifier", () => {
    expect(press("ArrowDown", 0, { altKey: true }, rect, steps)).toEqual({ ...rect, y: 175 });
  });

  it("rectAfterArrowKey_ShouldResizeByLargeStep_WhenGivenShiftAndConfiguredModifier", () => {
    expect(press("ArrowRight", 0, { shiftKey: true, altKey: true }, rect, steps)).toEqual({ ...rect, width: 225 });
  });

  it("rectAfterArrowKey_ShouldStopAtPageEdge_WhenLargeStepWouldPassIt", () => {
    const nearEdge = { ...rect, x: 390 };

    expect(press("ArrowRight", 0, { altKey: true }, nearEdge, steps)).toEqual({ ...rect, x: 400 });
  });

  it.each([
    ["alt", { ctrlKey: true }], ["alt", { metaKey: true }], ["ctrl", { altKey: true }], ["meta", { ctrlKey: true }],
    ["ctrl", { ctrlKey: true, altKey: true }],
  ] as const)("rectAfterArrowKey_ShouldReturnUndefined_WhenModifierIs%sAndGiven%j", (modifier, held) => {
    expect(press("ArrowRight", 0, held, rect, { ...steps, keyboardLargeStepModifier: modifier })).toBeUndefined();
  });

  it("rectAfterArrowKey_ShouldMoveByLargeStep_WhenModifierIsMeta", () => {
    const withMeta: ArrowKeySteps = { ...steps, keyboardLargeStepModifier: "meta" };

    expect(press("ArrowLeft", 0, { metaKey: true }, rect, withMeta)).toEqual({ ...rect, x: 75 });
  });
});
