import { describe, expect, it } from "vitest";
import { DrawRectTool } from "../../src/draw-rect-tool.js";
import type { DrawDefaults, ObjectKeyPress, PointerPress, ToolOptions } from "../../src/tool.js";
import { at, geometry, recordingContext } from "./tool-support.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setup({ drawDefaults = {}, roundCoordinates = false }: { drawDefaults?: DrawDefaults;
  roundCoordinates?: boolean } = {}) {
  const { context, store, record } = recordingContext({ roundCoordinates });
  const tool = new DrawRectTool(context, drawDefaults);
  return { tool, store, record, context };
}

function press(x: number, y: number): PointerPress {
  return { ...at(x, y), target: undefined };
}

describe("drawing", () => {
  it("pointerDown_ShouldStartGestureAndShowEmptyDraft_WhenCalled", () => {
    const { tool, record } = setup();

    const result = tool.pointerDown(press(100, 200));

    expect(result).toEqual({ gesture: true });
    expect(record.shown)
      .toEqual([{ kind: "draft", page: 1, rect: { x: 100, y: 200, width: 0, height: 0 }, defaults: {} }]);
  });

  it("pointerMove_ShouldShowDraftBetweenPressAndPointer_WhenDragged", () => {
    const { tool, record } = setup();

    tool.pointerDown(press(100, 200));
    tool.pointerMove(at(50, 260));

    expect(record.shown.at(-1))
      .toMatchObject({ kind: "draft", page: 1, rect: { x: 50, y: 200, width: 50, height: 60 } });
  });

  it("pointerUp_ShouldLeaveDraftWithNewIdAndNoObject_WhenDraggedFarEnough", () => {
    const { tool, store, record } = setup();

    tool.pointerDown(press(100, 200));
    tool.pointerMove(at(150, 250));
    tool.pointerUp(at(200, 260));

    const draft = record.drafts[0]!;
    expect(record.drafts).toHaveLength(1);
    expect(draft).toMatchObject({ page: 1, rect: { x: 100, y: 200, width: 100, height: 60 } });
    expect(draft.id).toMatch(uuid);
    expect(store.all()).toEqual([]);
    expect(store.selectedIds).toEqual([]);
  });

  it("pointerUp_ShouldCountReleasePosition_WhenNoMoveCameFirst", () => {
    const { tool, record } = setup();

    tool.pointerDown(press(100, 200));
    tool.pointerUp(at(130, 240));

    expect(record.drafts[0]!.rect).toEqual({ x: 100, y: 200, width: 30, height: 40 });
  });

  it("pointerUp_ShouldGiveEachDraftItsOwnId_WhenDrawingTwice", () => {
    const { tool, record } = setup();

    for (let index = 0; index < 2; index++) {
      tool.pointerDown(press(100, 200));
      tool.pointerUp(at(130, 240));
    }

    expect(record.drafts[0]!.id).not.toBe(record.drafts[1]!.id);
  });

  it.each([["Wide", 1.9, 50], ["High", 50, 1.9]] as const)(
    "pointerUp_ShouldLeaveNoDraft_WhenRectangleIsUnderTwoUnits%s", (_, width, height) => {
      const { tool, record } = setup();

      tool.pointerDown(press(100, 200));
      tool.pointerUp(at(100 + width, 200 + height));

      expect(record.drafts).toEqual([]);
      expect(record.shown.at(-1)).toBeUndefined();
    });

  it("pointerUp_ShouldLeaveDraft_WhenRectangleIsExactlyTwoUnitsWideAndHigh", () => {
    const { tool, record } = setup();

    tool.pointerDown(press(100, 200));
    tool.pointerUp(at(102, 202));

    expect(record.drafts).toHaveLength(1);
  });

  it("pointerUp_ShouldKeepRectOnPage_WhenPointerLeavesPage", () => {
    const { tool, record } = setup();

    tool.pointerDown(press(500, 700));
    tool.pointerUp(at(900, 1_000));

    expect(record.drafts[0]!.rect).toEqual({ x: 500, y: 700, width: 100, height: 100 });
  });

  it("pointerUp_ShouldDrawOnPressedPage_WhenPressedOnPage2", () => {
    const { tool, record } = setup();

    tool.pointerDown({ ...press(100, 200), page: 2 });
    tool.pointerUp({ ...at(130, 240), page: 2 });

    expect(record.drafts[0]!.page).toBe(2);
  });

  it("pointerUp_ShouldApplyDefaults_WhenToolHasThem", () => {
    const drawDefaults = { style: { color: "red" }, label: "Heading", kind: "heading", cssClass: "draft",
      appData: { step: "1" } };
    const { tool, record } = setup({ drawDefaults });

    tool.pointerDown(press(100, 200));
    tool.pointerUp(at(130, 240));

    expect(record.drafts[0]).toMatchObject(drawDefaults);
  });

  it("pointerMove_ShouldShowDraftWithToolDefaults_WhenToolHasThem", () => {
    const drawDefaults = { kind: "heading", cssClass: "emphasized", style: { color: "red", borderWidth: "4px" } };
    const { tool, record } = setup({ drawDefaults });

    tool.pointerDown(press(100, 200));
    tool.pointerMove(at(150, 250));

    expect(record.shown.at(-1)).toMatchObject({ kind: "draft", defaults: drawDefaults });
  });

  it("pointerUp_ShouldRoundToWholeUnits_WhenRoundingIsOn", () => {
    const { tool, record } = setup({ roundCoordinates: true });

    tool.pointerDown(press(100.4, 200.6));
    tool.pointerUp(at(130.2, 240.7));

    expect(record.drafts[0]!.rect).toEqual({ x: 100, y: 201, width: 30, height: 40 });
  });

  it("pointerUp_ShouldRoundToWholeUnits_WhenRoundingIsTurnedOnDuringDraw", () => {
    const { tool, record, context } = setup();
    tool.pointerDown(press(100.4, 200.6));

    context.options = { ...context.options, roundCoordinates: true };
    tool.pointerUp(at(130.2, 240.7));

    expect(record.drafts[0]!.rect).toEqual({ x: 100, y: 201, width: 30, height: 40 });
  });

  it("pointerUp_ShouldClearPreviewBeforeLeavingDraft_WhenFinished", () => {
    const { tool, record } = setup();

    tool.pointerDown(press(100, 200));
    tool.pointerUp(at(130, 240));

    expect(record.log).toEqual(["show:draft", "show:none", "draft"]);
  });

  it("pointerMove_ShouldShowNothing_WhenNotDrawing", () => {
    const { tool, record } = setup();

    tool.pointerMove(at(130, 240));
    tool.pointerUp(at(130, 240));

    expect(record.log).toEqual([]);
  });
});

describe("pressing objects", () => {
  const rect = { x: 100, y: 150, width: 200, height: 100 };

  /** A draw tool with the options given, and a page with object "a" on it. */
  function setupWithObject(options: Partial<ToolOptions> = {}) {
    const { context, store, record } = recordingContext(options);
    store.add({ id: "a", page: 1, rect }, "api");
    return { tool: new DrawRectTool(context, {}), store, record, context };
  }

  function onObject(x: number, y: number): PointerPress {
    return { ...at(x, y), target: { kind: "object", id: "a" } };
  }

  it("pointerDown_ShouldSelectObjectAndDrawNothing_WhenPressedOnObject", () => {
    const { tool, store, record } = setupWithObject();

    const result = tool.pointerDown(onObject(150, 200));

    expect(result).toEqual({ gesture: true, focus: "a" });
    expect(store.selectedIds).toEqual(["a"]);
    expect(record.shown).toEqual([]);
  });

  it("pointerUp_ShouldMoveObjectAndLeaveNoDraft_WhenObjectIsDragged", () => {
    const { tool, record } = setupWithObject();

    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(160, 215));
    tool.pointerUp(at(170, 230));

    expect(record.updated).toHaveLength(1);
    expect(record.updated[0]).toMatchObject({ gesture: "move", object: { rect: { ...rect, x: 120, y: 180 } } });
    expect(record.drafts).toEqual([]);
  });

  it("pointerUp_ShouldResizeObject_WhenHandleIsDragged", () => {
    const { tool, store, record } = setupWithObject();
    store.select(["a"], "api");

    tool.pointerDown({ ...at(300, 250), target: { kind: "handle", id: "a", handle: "se" } });
    tool.pointerUp(at(320, 260));

    expect(record.updated[0])
      .toMatchObject({ gesture: "resize", object: { rect: { ...rect, width: 220, height: 110 } } });
  });

  it("pointerUp_ShouldDrawOverObject_WhenDrawOverObjectsIsOn", () => {
    const { tool, store, record } = setupWithObject({ drawOverObjects: true });

    const result = tool.pointerDown(onObject(150, 200));
    tool.pointerUp(at(170, 230));

    expect(result).toEqual({ gesture: true });
    expect(store.selectedIds).toEqual([]);
    expect(record.drafts[0]!.rect).toEqual({ x: 150, y: 200, width: 20, height: 30 });
  });

  it("presentation_ShouldLetObjectsCatchPointerAndShowHandles_WhenDrawOverObjectsIsOff", () => {
    const { tool } = setupWithObject();

    expect(tool.presentation).toEqual({ pointer: "objects-and-page", focusable: true, handles: true, readOnly: false });
  });

  it("presentation_ShouldLeavePointerToPage_WhenDrawOverObjectsIsTurnedOn", () => {
    const { tool, context } = setupWithObject();

    context.options = { ...context.options, drawOverObjects: true };

    expect(tool.presentation).toEqual({ pointer: "page", focusable: true, handles: false, readOnly: false });
  });

  it("cancel_ShouldPutObjectBack_WhenObjectDragIsUnderWay", () => {
    const { tool, record } = setupWithObject();
    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(170, 230));

    const canceled = tool.cancel();
    tool.pointerUp(at(170, 230));

    expect(canceled).toBe(true);
    expect(record.shown.at(-1)).toBeUndefined();
    expect(record.updated).toEqual([]);
  });

  it("keyDown_ShouldLeaveKeyAlone_WhenObjectDragIsUnderWay", () => {
    const { tool } = setupWithObject();
    tool.pointerDown(onObject(150, 200));

    const handled = tool.keyDown({ id: "a", geometry: geometry(), action: { kind: "edit", resize: false, deltaX: 1,
      deltaY: 0 } });

    expect(handled).toBe(false);
  });

  it("pointerUp_ShouldClearSelection_WhenClickIsTooSmallToDraw", () => {
    const { tool, store, record } = setupWithObject();
    store.select(["a"], "api");

    tool.pointerDown(press(10, 10));
    tool.pointerUp(at(10, 10));

    expect(store.selectedIds).toEqual([]);
    expect(record.selections.at(-1)!.origin).toBe("user");
    expect(record.drafts).toEqual([]);
  });

  it("objectsChanged_ShouldEndObjectDrag_WhenObjectIsRemoved", () => {
    const { tool, store, record } = setupWithObject();
    tool.pointerDown(onObject(150, 200));
    tool.pointerMove(at(170, 230));

    store.remove("a", "api");
    tool.objectsChanged();
    tool.pointerUp(at(190, 250));

    expect(record.updated).toEqual([]);
  });
});

describe("canceling", () => {
  it("cancel_ShouldClearPreviewAndLeaveNoDraft_WhenDrawing", () => {
    const { tool, record } = setup();
    tool.pointerDown(press(100, 200));
    tool.pointerMove(at(150, 250));

    const canceled = tool.cancel();
    tool.pointerUp(at(150, 250));

    expect(canceled).toBe(true);
    expect(record.shown.at(-1)).toBeUndefined();
    expect(record.drafts).toEqual([]);
  });

  it("cancel_ShouldReturnFalse_WhenNotDrawing", () => {
    const { tool, record } = setup();

    expect(tool.cancel()).toBe(false);
    expect(record.log).toEqual([]);
  });
});

describe("keyboard", () => {
  const rect = { x: 100, y: 150, width: 200, height: 100 };

  /** A draw tool, and a page with object "a" on it. */
  function setupWithObject() {
    const setupResult = setup();
    setupResult.store.add({ id: "a", page: 1, rect }, "api");
    return setupResult;
  }

  function key(action: ObjectKeyPress["action"]): ObjectKeyPress {
    return { id: "a", geometry: geometry(), action };
  }

  const stepRight = key({ kind: "edit", resize: false, deltaX: 1, deltaY: 0 });

  it("endKeyEdit_ShouldReportOneNudge_WhenRunMovedObjectWhileToolIsActive", () => {
    const { tool, record } = setupWithObject();

    const handled = tool.keyDown(stepRight);
    tool.keyDown(stepRight);
    tool.endKeyEdit();

    expect(handled).toBe(true);
    expect(record.updated).toHaveLength(1);
    expect(record.updated[0]).toMatchObject({ gesture: "nudge", object: { rect: { ...rect, x: 102 } } });
  });

  it("keyDown_ShouldLeaveKeyAlone_WhenDrawIsUnderWay", () => {
    const { tool } = setupWithObject();
    tool.pointerDown(press(10, 10));

    expect(tool.keyDown(stepRight)).toBe(false);
  });

  it("keyDown_ShouldLeaveKeyAlone_WhenKeySelectsOrDeletes", () => {
    const { tool, record } = setupWithObject();

    expect(tool.keyDown(key({ kind: "select" }))).toBe(false);
    expect(tool.keyDown(key({ kind: "delete" }))).toBe(false);
    expect(record.selections).toEqual([]);
    expect(record.deleteRequests).toEqual([]);
  });

  it("objectsChanged_ShouldDropRun_WhenObjectIsRemoved", () => {
    const { tool, store, record } = setupWithObject();

    tool.keyDown(stepRight);
    store.remove("a", "api");
    tool.objectsChanged();
    tool.endKeyEdit();

    expect(record.updated).toEqual([]);
  });
});
