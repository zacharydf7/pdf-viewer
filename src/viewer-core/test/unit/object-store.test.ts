import { beforeEach, describe, expect, it } from "vitest";
import type { SelectionChanged } from "../../src/object-store.js";
import { ObjectStore } from "../../src/object-store.js";

const rect = { x: 1, y: 2, width: 3, height: 4 };

describe("ObjectStore", () => {
  /** Every notification in order, as its kind and its detail. */
  let changes: [string, { sequence: number; origin: string } & Record<string, unknown>][];
  let selections: SelectionChanged[];
  let store: ObjectStore;

  beforeEach(() => {
    changes = [];
    selections = [];
    store = new ObjectStore({
      onAdded: (change) => changes.push(["added", { ...change }]),
      onUpdated: (change) => changes.push(["updated", { ...change }]),
      onRemoved: (change) => changes.push(["removed", { ...change }]),
      onReplaced: (change) => changes.push(["replaced", { ...change }]),
      onSelectionChanged: (change) => selections.push(change),
    });
  });

  it("add_ShouldApplyDefaults_WhenGivenOnlyRequiredFields", () => {
    const added = store.add({ id: "a", page: 1, rect }, "api");
    expect(added).toEqual({ id: "a", page: 1, rect, shape: "rect", locked: false, selectable: true, hidden: false });
  });

  it("add_ShouldKeepCopyOfAppData_WhenCallerChangesTheirsAfterward", () => {
    const appData: Record<string, string> = { section: "3" };

    const added = store.add({ id: "a", page: 1, rect, appData }, "api");
    appData.section = "4";

    expect(added.appData).toEqual({ section: "3" });
    expect(Object.isFrozen(added.appData)).toBe(true);
  });

  it.each(["Section", "2nd", "with space", "data_app", ""])("add_ShouldThrow_WhenAppDataKeyIs%j", (key) => {
    expect(() => store.add({ id: "a", page: 1, rect, appData: { [key]: "x" } }, "api")).toThrow(/App data key/);
    expect(store.get("a")).toBeUndefined();
  });

  it("add_ShouldAcceptAppDataKey_WhenItHasLettersDigitsAndHyphens", () => {
    expect(store.add({ id: "a", page: 1, rect, appData: { "review-step-2": "x" } }, "api").appData)
      .toEqual({ "review-step-2": "x" });
  });

  it("add_ShouldThrow_WhenIdAlreadyExists", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    expect(() => store.add({ id: "a", page: 2, rect }, "api")).toThrow(/already exists/);
  });

  it("add_ShouldKeepItsOwnCopy_WhenCallerChangesObjectAfterward", () => {
    const style = { color: "red" };
    const mine = { id: "a", page: 1, rect: { ...rect }, style };

    store.add(mine, "api");
    mine.rect.x = 99;
    style.color = "blue";

    expect(store.get("a")).toMatchObject({ rect, style: { color: "red" } });
  });

  it("get_ShouldReturnObjectThatCannotBeChanged_WhenCallerWritesToIt", () => {
    store.add({ id: "a", page: 1, rect, style: { color: "red" } }, "api");
    const stored = store.get("a") as { locked: boolean; rect: { x: number }; style: { color: string } };

    expect(() => { stored.locked = true; }).toThrow(TypeError);
    expect(() => { stored.rect.x = 99; }).toThrow(TypeError);
    expect(() => { stored.style.color = "blue"; }).toThrow(TypeError);
  });

  it("update_ShouldReportOrigin_WhenChangeComesFromUser", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.update("a", { locked: true }, "user");
    expect(changes.map(([kind, { origin }]) => [origin, kind])).toEqual([["api", "added"], ["user", "updated"]]);
    expect(store.get("a")?.locked).toBe(true);
  });

  it("update_ShouldReportPreviousStateAndGesture_WhenUserMovesObject", () => {
    store.add({ id: "a", page: 1, rect }, "api");

    store.update("a", { rect: { ...rect, x: 50 } }, "user", "move");

    expect(changes.at(-1)).toEqual(["updated", {
      sequence: 2,
      origin: "user",
      gesture: "move",
      object: { id: "a", page: 1, rect: { ...rect, x: 50 }, shape: "rect", locked: false, selectable: true,
        hidden: false },
      previous: { id: "a", page: 1, rect, shape: "rect", locked: false, selectable: true, hidden: false },
    }]);
  });

  it("update_ShouldThrow_WhenIdIsUnknown", () => {
    expect(() => store.update("missing", { locked: true }, "api")).toThrow(/No object/);
  });

  it("remove_ShouldReportObjectAsItWas_WhenRemoved", () => {
    store.add({ id: "a", page: 1, rect, kind: "note" }, "api");

    store.remove("a", "user");

    expect(changes.at(-1)).toEqual(["removed", {
      sequence: 2,
      origin: "user",
      object: { id: "a", page: 1, rect, shape: "rect", locked: false, selectable: true, hidden: false, kind: "note" },
    }]);
  });

  it("sequence_ShouldIncreaseAcrossChangesAndSelections_WhenStoreIsUsed", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select(["a"], "user");
    store.update("a", { locked: true }, "api");
    expect([changes[0]?.[1].sequence, selections[0]?.sequence, changes[1]?.[1].sequence]).toEqual([1, 2, 3]);
  });

  it("forPage_ShouldReturnOnlyThatPage_WhenObjectsSpanPages", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.add({ id: "b", page: 2, rect }, "api");
    expect(store.forPage(2).map(({ id }) => id)).toEqual(["b"]);
  });

  it("select_ShouldNotNotify_WhenAlreadySelected", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select(["a"], "user");
    store.select(["a"], "user");
    expect(selections).toHaveLength(1);
  });

  it("select_ShouldMakeLastObjectPrimary_WhenGivenSeveral", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.add({ id: "b", page: 1, rect }, "api");

    store.select(["a", "b"], "api");

    expect(selections.at(-1)).toEqual({ sequence: 3, origin: "api", ids: ["a", "b"], primaryId: "b" });
    expect(store.primarySelectedId).toBe("b");
    expect(store.isSelected("a")).toBe(true);
  });

  it("select_ShouldKeepSelection_WhenListenerChangesReportedIds", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.add({ id: "b", page: 1, rect }, "api");
    store.select(["a", "b"], "api");

    expect(() => (selections.at(-1)!.ids as string[]).pop()).toThrow(TypeError);
    expect(() => (store.selectedIds as string[]).reverse()).toThrow(TypeError);
    expect(store.selectedIds).toEqual(["a", "b"]);
  });

  it("selectedIds_ShouldRejectChanges_WhenNothingHasBeenSelectedYet", () => {
    store.add({ id: "a", page: 1, rect }, "api");

    expect(() => (store.selectedIds as string[]).push("a")).toThrow(TypeError);
    expect(store.primarySelectedId).toBeNull();
  });

  it("select_ShouldCountRepeatedIdOnce_WhenGivenDuplicates", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.add({ id: "b", page: 1, rect }, "api");

    store.select(["a", "b", "a"], "api");

    expect(store.selectedIds).toEqual(["a", "b"]);
  });

  it("select_ShouldThrowAndKeepSelection_WhenAnyIdIsUnknown", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select(["a"], "api");

    expect(() => store.select(["a", "missing"], "api")).toThrow(/No object/);
    expect(store.selectedIds).toEqual(["a"]);
  });

  it("remove_ShouldDeselectOnlyThatObject_WhenSeveralAreSelected", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.add({ id: "b", page: 1, rect }, "api");
    store.select(["a", "b"], "api");

    store.remove("b", "user");

    expect(selections.at(-1)).toMatchObject({ ids: ["a"], primaryId: "a", origin: "user" });
  });

  it("remove_ShouldClearSelection_WhenObjectIsSelected", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select(["a"], "api");
    store.remove("a", "user");
    expect(store.primarySelectedId).toBeNull();
    expect(selections.at(-1)).toMatchObject({ ids: [], primaryId: null, origin: "user" });
  });

  it("replaceAll_ShouldKeepSelection_WhenSelectedObjectSurvives", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select(["a"], "api");
    store.replaceAll([{ id: "a", page: 1, rect }, { id: "b", page: 1, rect }], "api");
    expect(store.selectedIds).toEqual(["a"]);
  });

  it("replaceAll_ShouldClearSelection_WhenSelectedObjectIsGone", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select(["a"], "api");
    store.replaceAll([{ id: "b", page: 1, rect }], "api");
    expect(store.selectedIds).toEqual([]);
  });

  it("replaceAll_ShouldThrowAndKeepObjects_WhenIdsRepeat", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    expect(() => store.replaceAll([{ id: "b", page: 1, rect }, { id: "b", page: 1, rect }], "api")).toThrow(/unique/);
    expect(store.get("a")).toBeDefined();
  });
});
