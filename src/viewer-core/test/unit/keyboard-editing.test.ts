import { describe, expect, it } from "vitest";
import type { PageGeometry, Rect, Rotation } from "../../src/geometry.js";
import type { KeyOptions, KeyPress } from "../../src/keyboard-editing.js";
import { keyAction, rectAfterEdit } from "../../src/keyboard-editing.js";

const page = (rotation: Rotation): PageGeometry => ({ width: 600, height: 800, rotation });
const rect: Rect = { x: 100, y: 150, width: 200, height: 100 };

const defaults: KeyOptions = {
  keyboardEditing: true, keyboardStep: 1, keyboardLargeStep: 10, keyboardMoveModifier: "alt",
  keyboardLargeStepModifier: "ctrl",
};
type Modifiers = Partial<Omit<KeyPress, "key">>;

function keyPress(key: string, modifiers: Modifiers = {}): KeyPress {
  return { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers };
}

/** Where an edit key leaves the rectangle, holding the default move modifier unless told otherwise. */
function edit(key: string, rotation: Rotation = 0, modifiers: Modifiers = {}, from = rect, options = defaults):
  Rect | undefined {
  const action = keyAction(keyPress(key, { altKey: true, ...modifiers }), options);
  return action?.kind === "edit" ? rectAfterEdit(page(rotation), from, action, 1) : undefined;
}

describe("listbox keys", () => {
  it.each([
    ["ArrowUp", "previous"], ["ArrowLeft", "previous"], ["ArrowDown", "next"], ["ArrowRight", "next"],
    ["Home", "first"], ["End", "last"],
  ] as const)("keyAction_ShouldMoveFocus_WhenGiven%sAlone", (key, to) => {
    expect(keyAction(keyPress(key), defaults)).toEqual({ kind: "focus", to });
  });

  it.each([" ", "Enter"])("keyAction_ShouldSelect_WhenGiven%j", (key) => {
    expect(keyAction(keyPress(key), defaults)).toEqual({ kind: "select" });
  });

  it("keyAction_ShouldStillMoveFocusAndSelect_WhenKeyboardEditingIsOff", () => {
    const off = { ...defaults, keyboardEditing: false };

    expect([keyAction(keyPress("ArrowDown"), off), keyAction(keyPress("Enter"), off)])
      .toEqual([{ kind: "focus", to: "next" }, { kind: "select" }]);
  });

  it.each([["Escape", "clear"], ["Delete", "delete"]] as const)("keyAction_ShouldGive%s_WhenKeyboardEditingIsOn",
    (key, kind) => {
      expect(keyAction(keyPress(key), defaults)).toEqual({ kind });
    });

  it.each(["Escape", "Delete", "ArrowRight"])("keyAction_ShouldLeaveEditKeyToHost_WhenKeyboardEditingIsOffAndGiven%s",
    (key) => {
      const modifiers = key.startsWith("Arrow") ? { altKey: true } : {};

      expect(keyAction(keyPress(key, modifiers), { ...defaults, keyboardEditing: false })).toBeUndefined();
    });

  it.each([
    ["a", {}], ["ArrowRight", { shiftKey: true }], ["ArrowRight", { ctrlKey: true }], ["Home", { altKey: true }],
    ["Enter", { ctrlKey: true }],
  ] as const)("keyAction_ShouldLeaveKeyToHost_WhenGiven%sWith%j", (key, modifiers) => {
    expect(keyAction(keyPress(key, modifiers), defaults)).toBeUndefined();
  });
});

describe("moving", () => {
  // Each row is the page-space change that moves the rectangle one unit in the key's direction on screen.
  it.each([
    [0, "ArrowRight", 1, 0], [0, "ArrowLeft", -1, 0], [0, "ArrowDown", 0, 1], [0, "ArrowUp", 0, -1],
    [90, "ArrowRight", 0, -1], [90, "ArrowLeft", 0, 1], [90, "ArrowDown", 1, 0], [90, "ArrowUp", -1, 0],
    [180, "ArrowRight", -1, 0], [180, "ArrowLeft", 1, 0], [180, "ArrowDown", 0, -1], [180, "ArrowUp", 0, 1],
    [270, "ArrowRight", 0, 1], [270, "ArrowLeft", 0, -1], [270, "ArrowDown", -1, 0], [270, "ArrowUp", 1, 0],
  ] as const)("rectAfterEdit_ShouldMoveOneUnitOnScreen_WhenRotatedBy%iAndGivenAltWith%s", (rotation, key, x, y) => {
    expect(edit(key, rotation)).toEqual({ ...rect, x: rect.x + x, y: rect.y + y });
  });

  it.each([["ArrowRight", 10, 0], ["ArrowLeft", -10, 0], ["ArrowDown", 0, 10], ["ArrowUp", 0, -10]] as const)(
    "rectAfterEdit_ShouldMoveTenUnits_WhenGivenAltAndCtrlWith%s", (key, x, y) => {
      expect(edit(key, 0, { ctrlKey: true })).toEqual({ ...rect, x: rect.x + x, y: rect.y + y });
    });

  it.each([
    ["ArrowLeft", { ...rect, x: 0 }], ["ArrowUp", { ...rect, y: 0 }],
    ["ArrowRight", { ...rect, x: 400 }], ["ArrowDown", { ...rect, y: 700 }],
  ] as const)("rectAfterEdit_ShouldStayOnPage_WhenGiven%sAtThatEdge", (key, atEdge) => {
    expect(edit(key, 0, { ctrlKey: true }, atEdge)).toEqual(atEdge);
  });
});

describe("resizing", () => {
  it.each([
    ["ArrowRight", 1, 0], ["ArrowLeft", -1, 0], ["ArrowDown", 0, 1], ["ArrowUp", 0, -1],
  ] as const)("rectAfterEdit_ShouldMoveBottomRightCorner_WhenGivenAltAndShiftWith%s", (key, width, height) => {
    expect(edit(key, 0, { shiftKey: true }))
      .toEqual({ ...rect, width: rect.width + width, height: rect.height + height });
  });

  it("rectAfterEdit_ShouldResizeByTenUnits_WhenGivenAltShiftAndCtrl", () => {
    expect(edit("ArrowRight", 0, { shiftKey: true, ctrlKey: true })).toEqual({ ...rect, width: 210 });
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
  ] as const)("rectAfterEdit_ShouldMoveCornerShownAtBottomRight_WhenRotatedBy%iAndGivenAltShiftWith%s",
    (rotation, key, change) => {
      expect(edit(key, rotation, { shiftKey: true })).toEqual({ ...rect, ...change });
    });

  it("rectAfterEdit_ShouldStopAtMinimumSize_WhenShrinkingPastIt", () => {
    const small = { ...rect, width: 5 };

    expect(edit("ArrowLeft", 0, { shiftKey: true, ctrlKey: true }, small)).toEqual({ ...rect, width: 1 });
  });
});

describe("configured keys and steps", () => {
  const options: KeyOptions = { ...defaults, keyboardStep: 5, keyboardLargeStep: 25, keyboardMoveModifier: "ctrl",
    keyboardLargeStepModifier: "alt" };

  it("keyAction_ShouldMoveByConfiguredStep_WhenGivenConfiguredMoveModifier", () => {
    expect(edit("ArrowRight", 0, { altKey: false, ctrlKey: true }, rect, options)).toEqual({ ...rect, x: 105 });
  });

  it("keyAction_ShouldMoveByLargeStep_WhenGivenBothConfiguredModifiers", () => {
    expect(edit("ArrowDown", 0, { altKey: true, ctrlKey: true }, rect, options)).toEqual({ ...rect, y: 175 });
  });

  it("keyAction_ShouldStopAtPageEdge_WhenLargeStepWouldPassIt", () => {
    const nearEdge = { ...rect, x: 390 };

    expect(edit("ArrowRight", 0, { ctrlKey: true }, nearEdge, options)).toEqual({ ...rect, x: 400 });
  });

  it("keyAction_ShouldLeaveKeyToHost_WhenOnlyLargeStepModifierIsHeld", () => {
    expect(keyAction(keyPress("ArrowRight", { altKey: true }), options)).toBeUndefined();
  });

  it.each([
    ["alt", { metaKey: true }], ["meta", { ctrlKey: true }], ["alt", { altKey: true, metaKey: true }],
  ] as const)("keyAction_ShouldLeaveKeyToHost_WhenMoveModifierIs%sAndGiven%j", (modifier, held) => {
    const configured = { ...defaults, keyboardMoveModifier: modifier };

    expect(keyAction(keyPress("ArrowRight", held), configured)).toBeUndefined();
  });

  it("keyAction_ShouldMoveByLargeStep_WhenLargeStepModifierIsMeta", () => {
    const withMeta: KeyOptions = { ...defaults, keyboardLargeStepModifier: "meta" };

    expect(edit("ArrowLeft", 0, { metaKey: true }, rect, withMeta)).toEqual({ ...rect, x: 90 });
  });
});
