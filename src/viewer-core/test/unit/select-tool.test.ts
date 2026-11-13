import { describe, expect, it } from "vitest";
import type { ResizeHandle, Rotation } from "../../src/geometry.js";
import type { NewPageObject } from "../../src/object-store.js";
import type { SelectOptions } from "../../src/select-tool.js";
import { SelectTool } from "../../src/select-tool.js";
import type { PointerPress } from "../../src/tool.js";
import { at, geometry, recordingContext } from "./tool-support.js";

const rect = { x: 100, y: 150, width: 200, height: 100 };

/** A select tool, and a page with object "a" on it. */
function setup(options: Partial<SelectOptions> = {}, object: Partial<NewPageObject> = {}) {
  const { context, store, record } = recordingContext();
  store.add({ id: "a", page: 1, rect, ...object }, "api");
  const tool = new SelectTool(context, { keyboardEditing: true, roundCoordinates: false, ...options });
  return { tool, store, record };
}

function onObject(x: number, y: number, rotation: Rotation = 0): PointerPress {
  return { ...at(x, y, rotation), target: { kind: "object", id: "a" } };
}

function onHandle(handle: ResizeHandle, x: number, y: number): PointerPress {
  return { ...at(x, y), target: { kind: "handle", id: "a", handle } };
}

function key(key: string, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  return { id: "a", geometry: geometry(), key, shiftKey: false, ctrlKey: false, ...modifiers };
}

describe("pressing", () => {
  it("pointerDown_ShouldClearSelectionWithoutGesture_WhenGivenNoTarget", () => {
    const { tool, store } = setup();
    store.select(["a"], "api");

    const result = tool.pointerDown({ ...at(10, 10), target: undefined });

    expect(result).toEqual({ gesture: false });
    expect(store.selectedIds).toEqual([]);
  });

  it("pointerDown_ShouldSelectFocusAndStartGesture_WhenGivenObject", () => {
    const { tool, store, record } = setup();

    const result = tool.pointerDown(onObject(150, 200));

    expect(result).toEqual({ gesture: true, focus: "a" });
    expect(store.selectedIds).toEqual(["a"]);
    expect(record.selections.at(-1)!.origin).toBe("user");
  });

  it("pointerDown_ShouldSelectAndFocusWithoutGesture_WhenObjectIsLocked", () => {
    const { tool, store } = setup({}, { locked: true });

    const result = tool.pointerDown(onObject(150, 200));

    expect(result).toEqual({ gesture: false, focus: "a" });
    expect(store.selectedIds).toEqual(["a"]);
  });

  it("pointerDown_ShouldDoNothing_WhenObjectIsNotSelectable", () => {
    const { tool, store } = setup({}, { selectable: false });

    const result = tool.pointerDown(onObject(150, 200));

    expect(result).toEqual({ gesture: false });
    expect(store.selectedIds).toEqual([]);
  });

  it("pointerDown_ShouldStartGestureWithoutSelecting_WhenGivenHandle", () => {
    const { tool, store, record } = setup();
    store.select(["a"], "api");

    const result = tool.pointerDown(onHandle("se", 300, 250));

    expect(result).toEqual({ gesture: true, focus: "a" });
    expect(record.selections).toHaveLength(1);
  });
});

describe("moving", () => {
  it("pointerUp_ShouldReportMoveByDraggedDistance_WhenObjectIsDragged", () => {
    const { tool, record } = setup();

    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(160, 210));
    tool.pointerUp(at(170, 220));

    expect(record.updated).toHaveLength(1);
    expect(record.updated[0]).toMatchObject({ origin: "user", gesture: "move" });
    expect(record.updated[0]!.object.rect).toEqual({ ...rect, x: 120, y: 170 });
  });

  it("pointerUp_ShouldCountReleasePosition_WhenNoMoveCameFirst", () => {
    const { tool, record } = setup();

    tool.pointerDown(onObject(150, 200));
    tool.pointerUp(at(155, 200));

    expect(record.updated[0]!.object.rect).toEqual({ ...rect, x: 105 });
  });

  it("pointerMove_ShouldShowObjectAtDraggedRect_WhenMoved", () => {
    const { tool, store, record } = setup();

    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(160, 200));

    expect(record.shown).toEqual([{ kind: "object", id: "a", rect: { ...rect, x: 110 } }]);
    expect(store.get("a")!.rect).toEqual(rect);
  });

  // An exact page rectangle can come back from display space with rounding error, so a click mustn't convert it.
  it.each([0, 90, 180, 270] as const)("pointerUp_ShouldChangeNothing_WhenClickedWithoutMovingAtRotation%i",
    (rotation) => {
      const { tool, record } = setup({}, { rect: { x: 100.1, y: 150.7, width: 200.3, height: 100.9 } });

      tool.pointerDown(onObject(150.3, 200.1, rotation));
      tool.pointerMove(at(150.3, 200.1, rotation));
      tool.pointerUp(at(150.3, 200.1, rotation));

      expect(record.updated).toEqual([]);
      expect(record.shown).toEqual([]);
    });

  it("pointerUp_ShouldMoveAsDisplayed_WhenRotatedBy90", () => {
    const { tool, record } = setup();

    // At 90 degrees, moving right on screen lowers the page y coordinate.
    tool.pointerDown(onObject(200, 200, 90));
    tool.pointerUp(at(200, 190, 90));

    expect(record.updated[0]!.object.rect).toEqual({ ...rect, y: 140 });
  });

  it("pointerUp_ShouldKeepObjectOnPage_WhenDraggedPastEdge", () => {
    const { tool, record } = setup();

    tool.pointerDown(onObject(150, 200));
    tool.pointerUp(at(1_000, 200));

    expect(record.updated[0]!.object.rect).toEqual({ ...rect, x: 400 });
  });

  it("pointerUp_ShouldClearPreviewBeforeReporting_WhenMoved", () => {
    const { tool, record } = setup();

    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(160, 200));
    tool.pointerUp(at(170, 200));

    expect(record.log.slice(-2)).toEqual(["show:none", "update"]);
  });

  it("pointerUp_ShouldRoundToWholeUnits_WhenRoundingIsOn", () => {
    const { tool, record } = setup({ roundCoordinates: true });

    tool.pointerDown(onObject(150, 200));
    tool.pointerUp(at(160.4, 200.6));

    expect(record.updated[0]!.object.rect).toEqual({ ...rect, x: 110, y: 151 });
  });

  it("pointerUp_ShouldReportNothingAndClearPreview_WhenMoveRoundsBackToOriginal", () => {
    const { tool, record } = setup({ roundCoordinates: true });

    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(150.3, 200));
    tool.pointerUp(at(150.3, 200));

    expect(record.updated).toEqual([]);
    expect(record.shown.at(-1)).toBeUndefined();
  });

  it("cancel_ShouldClearPreviewAndReportNothing_WhenMoving", () => {
    const { tool, record } = setup();
    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(160, 200));

    const canceled = tool.cancel();
    tool.pointerUp(at(170, 200));

    expect(canceled).toBe(true);
    expect(record.shown.at(-1)).toBeUndefined();
    expect(record.updated).toEqual([]);
  });

  it("cancel_ShouldReturnFalse_WhenNoGestureIsUnderWay", () => {
    const { tool } = setup();

    expect(tool.cancel()).toBe(false);
  });

  it("pointerUp_ShouldChangeNothing_WhenObjectIsRemovedDuringDrag", () => {
    const { tool, store, record } = setup();
    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(160, 200));

    store.remove("a", "api");
    tool.objectsChanged();
    tool.pointerMove(at(170, 200));
    tool.pointerUp(at(180, 200));

    expect(record.updated).toEqual([]);
    expect(record.shown.at(-1)).toBeUndefined();
    expect(tool.cancel()).toBe(false);
  });

  it("pointerUp_ShouldChangeNothing_WhenObjectIsRemovedAndAddedAgainDuringDrag", () => {
    const { tool, store, record } = setup();
    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(160, 200));

    store.remove("a", "api");
    tool.objectsChanged();
    store.add({ id: "a", page: 1, rect: { x: 0, y: 0, width: 50, height: 50 } }, "api");
    tool.objectsChanged();
    tool.pointerUp(at(180, 200));

    expect(record.updated).toEqual([]);
    expect(store.get("a")!.rect).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it("pointerUp_ShouldChangeNothing_WhenObjectMovesToAnotherPageDuringDrag", () => {
    const { tool, store, record } = setup();
    tool.pointerDown(onObject(150, 200));

    store.update("a", { page: 2 }, "api");
    tool.objectsChanged();
    tool.pointerUp(at(180, 200));

    expect(record.updated.map((change) => change.origin)).toEqual(["api"]);
    expect(tool.cancel()).toBe(false);
  });

  it("pointerUp_ShouldStillReportMove_WhenObjectChangesOnItsPageDuringDrag", () => {
    const { tool, store, record } = setup();
    tool.pointerDown(onObject(150, 200));

    store.update("a", { label: "Renamed" }, "api");
    tool.objectsChanged();
    tool.pointerUp(at(160, 200));

    expect(record.updated.map((change) => change.gesture)).toEqual([undefined, "move"]);
  });
});

describe("resizing", () => {
  it("pointerUp_ShouldReportResize_WhenHandleIsDragged", () => {
    const { tool, record } = setup();

    tool.pointerDown(onHandle("se", 300, 250));
    tool.pointerUp(at(310, 255));

    expect(record.updated[0]!.gesture).toBe("resize");
    expect(record.updated[0]!.object.rect).toEqual({ ...rect, width: 210, height: 105 });
  });

  it("pointerUp_ShouldNotJump_WhenHandleIsGrabbedOffCenter", () => {
    const { tool, record } = setup();

    tool.pointerDown(onHandle("e", 305, 210));
    tool.pointerUp(at(315, 210));

    expect(record.updated[0]!.object.rect).toEqual({ ...rect, width: 210 });
  });

  it("pointerUp_ShouldStopAtMinimumSize_WhenHandleIsDraggedPastOppositeEdge", () => {
    const { tool, record } = setup();

    tool.pointerDown(onHandle("e", 300, 200));
    tool.pointerUp(at(0, 200));

    expect(record.updated[0]!.object.rect).toEqual({ ...rect, width: 1 });
  });
});

describe("keyboard", () => {
  it("keyDown_ShouldReportNudge_WhenGivenArrowKey", () => {
    const { tool, record } = setup();

    const handled = tool.keyDown(key("ArrowRight"));

    expect(handled).toBe(true);
    expect(record.updated[0]).toMatchObject({ origin: "user", gesture: "nudge" });
    expect(record.updated[0]!.object.rect).toEqual({ ...rect, x: 101 });
  });

  it("keyDown_ShouldReportResize_WhenGivenShiftWithArrowKey", () => {
    const { tool, record } = setup();

    tool.keyDown(key("ArrowRight", { shiftKey: true }));

    expect(record.updated[0]!.gesture).toBe("resize");
    expect(record.updated[0]!.object.rect).toEqual({ ...rect, width: 201 });
  });

  it("keyDown_ShouldHandleKeyAndReportNothing_WhenArrowKeyMeetsPageEdge", () => {
    const { tool, record } = setup({}, { rect: { ...rect, x: 0 } });

    const handled = tool.keyDown(key("ArrowLeft"));

    expect(handled).toBe(true);
    expect(record.updated).toEqual([]);
  });

  it("keyDown_ShouldStayOnWholeUnits_WhenRoundingIsOn", () => {
    const { tool, record } = setup({ roundCoordinates: true }, { rect: { ...rect, x: 100.4 } });

    tool.keyDown(key("ArrowRight"));

    expect(record.updated[0]!.object.rect).toEqual({ ...rect, x: 101 });
  });

  it("keyDown_ShouldRemoveObject_WhenGivenDelete", () => {
    const { tool, store } = setup();

    const handled = tool.keyDown(key("Delete"));

    expect(handled).toBe(true);
    expect(store.get("a")).toBeUndefined();
  });

  it("keyDown_ShouldClearSelection_WhenGivenEscapeOnLockedObject", () => {
    const { tool, store } = setup({}, { locked: true });
    store.select(["a"], "api");

    const handled = tool.keyDown(key("Escape"));

    expect(handled).toBe(true);
    expect(store.selectedIds).toEqual([]);
  });

  it.each(["Delete", "ArrowRight"])("keyDown_ShouldLeaveKeyToHost_WhenObjectIsLockedAndGiven%s", (name) => {
    const { tool, store, record } = setup({}, { locked: true });

    expect(tool.keyDown(key(name))).toBe(false);
    expect(store.get("a")!.rect).toEqual(rect);
    expect(record.updated).toEqual([]);
  });

  it.each(["Escape", "Delete", "ArrowRight"])("keyDown_ShouldLeaveKeyToHost_WhenKeyboardEditingIsOffAndGiven%s",
    (name) => {
      const { tool, store } = setup({ keyboardEditing: false });
      store.select(["a"], "api");

      expect(tool.keyDown(key(name))).toBe(false);
      expect(store.get("a")!.rect).toEqual(rect);
      expect(store.selectedIds).toEqual(["a"]);
    });

  it("keyDown_ShouldLeaveKeyToHost_WhenObjectIsNotSelectable", () => {
    const { tool, store } = setup({}, { selectable: false });

    expect(tool.keyDown(key("Delete"))).toBe(false);
    expect(store.get("a")).toBeDefined();
  });

  it("keyDown_ShouldLeaveKeyToHost_WhenGivenKeyItDoesNotUse", () => {
    const { tool } = setup();

    expect(tool.keyDown(key("a"))).toBe(false);
  });

  it("keyDown_ShouldLeaveKeyToHost_WhenDragIsUnderWay", () => {
    const { tool, store } = setup();
    tool.pointerDown(onObject(150, 200));

    expect(tool.keyDown(key("Delete"))).toBe(false);
    expect(store.get("a")).toBeDefined();
  });
});

describe("focus", () => {
  it("focus_ShouldSelectObject_WhenObjectIsSelectable", () => {
    const { tool, store, record } = setup();

    tool.focus("a");

    expect(store.selectedIds).toEqual(["a"]);
    expect(record.selections[0]!.origin).toBe("user");
  });

  it("focus_ShouldNotSelect_WhenObjectIsNotSelectable", () => {
    const { tool, store } = setup({}, { selectable: false });

    tool.focus("a");

    expect(store.selectedIds).toEqual([]);
  });
});
