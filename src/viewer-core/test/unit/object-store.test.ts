import { beforeEach, describe, expect, it } from "vitest";
import type { ObjectChange, SelectionChange } from "../../src/object-store.js";
import { ObjectStore } from "../../src/object-store.js";

const rect = { x: 1, y: 2, width: 3, height: 4 };

describe("ObjectStore", () => {
  let changes: ObjectChange[];
  let selections: SelectionChange[];
  let store: ObjectStore;

  beforeEach(() => {
    changes = [];
    selections = [];
    store = new ObjectStore({
      onChange: (change) => changes.push(change),
      onSelectionChange: (change) => selections.push(change),
    });
  });

  it("add_ShouldApplyDefaults_WhenGivenOnlyRequiredFields", () => {
    const added = store.add({ id: "a", page: 1, rect }, "api");
    expect(added).toEqual({ id: "a", page: 1, rect, kind: "rect", locked: false, selectable: true });
  });

  it("add_ShouldThrow_WhenIdAlreadyExists", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    expect(() => store.add({ id: "a", page: 2, rect }, "api")).toThrow(/already exists/);
  });

  it("update_ShouldReportOrigin_WhenChangeComesFromUser", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.update("a", { locked: true }, "user");
    expect(changes.map(({ origin, kind }) => [origin, kind])).toEqual([["api", "added"], ["user", "updated"]]);
    expect(store.get("a")?.locked).toBe(true);
  });

  it("update_ShouldThrow_WhenIdIsUnknown", () => {
    expect(() => store.update("missing", { locked: true }, "api")).toThrow(/No object/);
  });

  it("sequence_ShouldIncreaseAcrossChangesAndSelections_WhenStoreIsUsed", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select("a", "user");
    store.update("a", { locked: true }, "api");
    expect([changes[0]?.sequence, selections[0]?.sequence, changes[1]?.sequence]).toEqual([1, 2, 3]);
  });

  it("forPage_ShouldReturnOnlyThatPage_WhenObjectsSpanPages", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.add({ id: "b", page: 2, rect }, "api");
    expect(store.forPage(2).map(({ id }) => id)).toEqual(["b"]);
  });

  it("select_ShouldNotNotify_WhenAlreadySelected", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select("a", "user");
    store.select("a", "user");
    expect(selections).toHaveLength(1);
  });

  it("remove_ShouldClearSelection_WhenObjectIsSelected", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select("a", "api");
    store.remove("a", "user");
    expect(store.selectedId).toBeNull();
    expect(selections.at(-1)).toMatchObject({ id: null, origin: "user" });
  });

  it("replaceAll_ShouldKeepSelection_WhenSelectedObjectSurvives", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select("a", "api");
    store.replaceAll([{ id: "a", page: 1, rect }, { id: "b", page: 1, rect }], "api");
    expect(store.selectedId).toBe("a");
  });

  it("replaceAll_ShouldClearSelection_WhenSelectedObjectIsGone", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    store.select("a", "api");
    store.replaceAll([{ id: "b", page: 1, rect }], "api");
    expect(store.selectedId).toBeNull();
  });

  it("replaceAll_ShouldThrowAndKeepObjects_WhenIdsRepeat", () => {
    store.add({ id: "a", page: 1, rect }, "api");
    expect(() => store.replaceAll([{ id: "b", page: 1, rect }, { id: "b", page: 1, rect }], "api")).toThrow(/unique/);
    expect(store.get("a")).toBeDefined();
  });
});
