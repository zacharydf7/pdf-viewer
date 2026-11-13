import { beforeEach, describe, expect, it } from "vitest";
import type { ObjectsChanged, SelectionChanged } from "../../src/object-store.js";
import { isOnPage, ObjectStore } from "../../src/object-store.js";

const rect = { x: 1, y: 2, width: 3, height: 4 };
const defaults = { shape: "rect", locked: false, selectable: true, hidden: false };

/** Which objects a change touched, by id. */
function ids({ added, updated, removed }: ObjectsChanged) {
  const idsOf = (objects: readonly { id: string }[]) => objects.map(({ id }) => id);
  return { added: idsOf(added), updated: idsOf(updated.map((update) => update.object)), removed: idsOf(removed) };
}

describe("ObjectStore", () => {
  let changes: ObjectsChanged[];
  let selections: SelectionChanged[];
  let store: ObjectStore;

  beforeEach(() => {
    changes = [];
    selections = [];
    store = new ObjectStore({
      onChanged: (change) => changes.push(change),
      onSelectionChanged: (change) => selections.push(change),
    });
  });

  it("add_ShouldApplyDefaults_WhenGivenOnlyRequiredFields", () => {
    const added = store.add({ id: "a", page: 1, rect }, "api");
    expect(added).toEqual({ id: "a", page: 1, rect, ...defaults });
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
    expect(changes.map((change) => [change.origin, ids(change)])).toEqual([
      ["api", { added: ["a"], updated: [], removed: [] }], ["user", { added: [], updated: ["a"], removed: [] }],
    ]);
    expect(store.get("a")?.locked).toBe(true);
  });

  it("update_ShouldReportPreviousStateAndGesture_WhenUserMovesObject", () => {
    store.add({ id: "a", page: 1, rect }, "api");

    store.update("a", { rect: { ...rect, x: 50 } }, "user", "move");

    expect(changes.at(-1)).toEqual({
      sequence: 2,
      origin: "user",
      added: [],
      removed: [],
      updated: [{
        gesture: "move",
        object: { id: "a", page: 1, rect: { ...rect, x: 50 }, ...defaults },
        previous: { id: "a", page: 1, rect, ...defaults },
      }],
    });
  });

  it("update_ShouldThrow_WhenIdIsUnknown", () => {
    expect(() => store.update("missing", { locked: true }, "api")).toThrow(/No object/);
  });

  it("remove_ShouldReportObjectAsItWas_WhenRemoved", () => {
    store.add({ id: "a", page: 1, rect, kind: "note" }, "api");

    const removed = store.remove("a", "user");

    expect(removed).toBe(true);
    const object = { id: "a", page: 1, rect, ...defaults, kind: "note" };
    expect(changes.at(-1)).toEqual({ sequence: 2, origin: "user", added: [], updated: [], removed: [object] });
  });

  it("remove_ShouldReturnFalseAndReportNothing_WhenIdIsUnknown", () => {
    expect(store.remove("missing", "api")).toBe(false);
    expect(changes).toEqual([]);
  });

  it("sequence_ShouldIncreaseAcrossChangesAndSelections_WhenStoreIsUsed", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select(["a"], "user");
    store.update("a", { locked: true }, "api");
    expect([changes[0]?.sequence, selections[0]?.sequence, changes[1]?.sequence]).toEqual([1, 2, 3]);
  });

  it("forPage_ShouldReturnOnlyThatPage_WhenObjectsSpanPages", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.add({ id: "b", page: 2, rect }, "api");
    expect(store.forPage(2).map(({ id }) => id)).toEqual(["b"]);
  });

  it("forPage_ShouldIncludeObjectOnEveryPage_WhenItsPageIsNull", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    const everywhere = store.add({ id: "b", page: null, rect }, "api");

    expect(store.forPage(1).map(({ id }) => id)).toEqual(["a", "b"]);
    expect(store.forPage(7).map(({ id }) => id)).toEqual(["b"]);
    expect([isOnPage(everywhere, 1), isOnPage(everywhere, 7)]).toEqual([true, true]);
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

  it("replaceAll_ShouldReportOnlyWhatDiffers_WhenSomeObjectsAreUnchanged", () => {
    store.replaceAll([{ id: "a", page: 1, rect }, { id: "b", page: 1, rect }, { id: "c", page: 1, rect }], "api");

    store.replaceAll([{ id: "a", page: 1, rect }, { id: "b", page: 1, rect, locked: true }, { id: "d", page: 1, rect }],
      "api");

    expect(changes).toHaveLength(2);
    expect(ids(changes[1]!)).toEqual({ added: ["d"], updated: ["b"], removed: ["c"] });
  });

  it("replaceAll_ShouldReportNothing_WhenEveryObjectIsUnchanged", () => {
    const objects = [{ id: "a", page: 1, rect, style: { color: "red" }, appData: { section: "3" } }];
    store.replaceAll(objects, "api");

    const reordered = { page: 1, appData: { section: "3" }, style: { color: "red" }, rect: { ...rect }, id: "a" };
    store.replaceAll([reordered], "api");

    expect(changes).toHaveLength(1);
  });
});

describe("batches", () => {
  let changes: ObjectsChanged[];
  let store: ObjectStore;

  beforeEach(() => {
    changes = [];
    store = new ObjectStore({ onChanged: (change) => changes.push(change), onSelectionChanged() {} });
    store.replaceAll([{ id: "a", page: 1, rect }, { id: "b", page: 1, rect }], "api");
    changes = [];
  });

  it("apply_ShouldReportEveryChangeOnce_WhenBatchAddsReplacesAndRemoves", () => {
    store.apply({ upsert: [{ id: "a", page: 2, rect }, { id: "c", page: 1, rect }], remove: ["b", "missing"] }, "api");

    expect(changes).toHaveLength(1);
    expect(ids(changes[0]!)).toEqual({ added: ["c"], updated: ["a"], removed: ["b"] });
    expect(changes[0]!.updated[0]!.previous.page).toBe(1);
    expect(store.all().map(({ id }) => id)).toEqual(["a", "c"]);
  });

  it("apply_ShouldReplaceWholeObject_WhenUpsertLeavesFieldsOut", () => {
    store.update("a", { kind: "heading", label: "Title", locked: true }, "api");

    store.apply({ upsert: [{ id: "a", page: 1, rect }] }, "api");

    expect(store.get("a")).toEqual({ id: "a", page: 1, rect, ...defaults });
  });

  it("apply_ShouldReportNothing_WhenBatchChangesNothing", () => {
    store.apply({ upsert: [{ id: "a", page: 1, rect }], remove: ["missing"] }, "api");

    expect(changes).toEqual([]);
  });

  it("apply_ShouldChangeNothing_WhenAnyObjectIsInvalid", () => {
    const upsert = [{ id: "c", page: 1, rect }, { id: "d", page: 1, rect, appData: { Bad: "x" } }];
    const batch = { upsert, remove: ["a"] };

    expect(() => store.apply(batch, "api")).toThrow(/App data key/);
    expect(store.all().map(({ id }) => id)).toEqual(["a", "b"]);
    expect(changes).toEqual([]);
  });

  it("apply_ShouldThrow_WhenIdIsBothUpsertedAndRemoved", () => {
    expect(() => store.apply({ upsert: [{ id: "a", page: 1, rect }], remove: ["a"] }, "api")).toThrow(/both/);
  });

  it("upsert_ShouldAddOrReplace_WhenIdIsNewOrTaken", () => {
    const added = store.upsert({ id: "c", page: 1, rect }, "api");
    const replaced = store.upsert({ id: "a", page: 3, rect }, "api");

    expect([added.id, replaced.page]).toEqual(["c", 3]);
    expect(changes.map(ids)).toEqual([
      { added: ["c"], updated: [], removed: [] }, { added: [], updated: ["a"], removed: [] },
    ]);
  });
});

describe("batches based on an earlier state", () => {
  let changes: ObjectsChanged[];
  let store: ObjectStore;
  const moved = { ...rect, x: 50 };
  const stale = { ...rect, x: 9 };

  beforeEach(() => {
    changes = [];
    store = new ObjectStore({ onChanged: (change) => changes.push(change), onSelectionChanged() {} });
    store.replaceAll([{ id: "a", page: 1, rect }, { id: "b", page: 1, rect }], "api");
  });

  it("apply_ShouldLeaveUserEditAlone_WhenBatchIsBasedOnStateBeforeIt", () => {
    const before = changes.at(-1)!.sequence;
    store.update("a", { rect: moved }, "user", "move");

    const upsert = [{ id: "a", page: 1, rect: stale }, { id: "b", page: 1, rect: stale }];
    store.apply({ upsert, basedOn: before }, "api");

    expect(store.get("a")!.rect).toEqual(moved);
    expect(store.get("b")!.rect).toEqual(stale);
    expect(ids(changes.at(-1)!)).toEqual({ added: [], updated: ["b"], removed: [] });
  });

  it("apply_ShouldOverwriteUserEdit_WhenBatchIsBasedOnStateAfterIt", () => {
    store.update("a", { rect: moved }, "user", "move");
    const after = changes.at(-1)!.sequence;

    store.apply({ upsert: [{ id: "a", page: 1, rect: stale }], basedOn: after }, "api");

    expect(store.get("a")!.rect).toEqual(stale);
  });

  it("apply_ShouldNotBringBackObjectUserRemoved_WhenBatchIsBasedOnStateBeforeRemoval", () => {
    const before = changes.at(-1)!.sequence;
    store.remove("a", "user");

    store.apply({ upsert: [{ id: "a", page: 1, rect: stale }], basedOn: before }, "api");

    expect(store.get("a")).toBeUndefined();
  });

  it("apply_ShouldNotRemoveObjectUserChanged_WhenBatchIsBasedOnStateBeforeChange", () => {
    const before = changes.at(-1)!.sequence;
    store.update("a", { rect: moved }, "user", "move");

    store.apply({ remove: ["a"], basedOn: before }, "api");

    expect(store.get("a")!.rect).toEqual(moved);
  });

  it("apply_ShouldApplyToReusedId_WhenStoreWasClearedAfterUserChangedThatId", () => {
    const before = changes.at(-1)!.sequence;
    store.update("a", { rect: moved }, "user", "move");

    store.clear("api");
    store.apply({ upsert: [{ id: "a", page: 1, rect: stale }], basedOn: before }, "api");

    expect(store.get("a")!.rect).toEqual(stale);
    expect(store.all()).toHaveLength(1);
  });

  it("apply_ShouldOverwriteUserEdit_WhenBatchGivesNoBase", () => {
    store.update("a", { rect: moved }, "user", "move");

    store.apply({ upsert: [{ id: "a", page: 1, rect: stale }] }, "api");

    expect(store.get("a")!.rect).toEqual(stale);
  });

  it("apply_ShouldOverwriteChangeMadeByCode_WhenBatchIsBasedOnStateBeforeIt", () => {
    const before = changes.at(-1)!.sequence;
    store.update("a", { rect: moved }, "api");

    store.apply({ upsert: [{ id: "a", page: 1, rect: stale }], basedOn: before }, "api");

    expect(store.get("a")!.rect).toEqual(stale);
  });
});
