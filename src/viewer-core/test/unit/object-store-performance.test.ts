import { expect, test } from "vitest";
import type { NewPageObject } from "../../src/object-store.js";
import { ObjectStore } from "../../src/object-store.js";

// Budgets are about ten times what each action took when written. That absorbs a slow or busy machine, while a change
// in how the cost grows, such as visiting every object inside a per-object operation, still fails by a wide margin.
const count = 50_000;
const pageCount = 50;
const listener = { onChanged() {}, onSelectionChanged() {} };

function manyObjects(): NewPageObject[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `object-${index}`,
    page: (index % pageCount) + 1,
    rect: { x: index % 600, y: index % 780, width: 10, height: 10 },
  }));
}

function filledStore(): ObjectStore {
  const store = new ObjectStore(listener);
  store.replaceAll(manyObjects(), "api");
  return store;
}

function elapsed(action: () => void): number {
  const start = performance.now();
  action();
  return performance.now() - start;
}

test("add_ShouldStayWithinBudget_WhenAdding50000ObjectsOneAtATime", () => {
  const store = new ObjectStore(listener);
  const objects = manyObjects();

  const time = elapsed(() => objects.forEach((object) => store.add(object, "api")));

  expect(time).toBeLessThan(150);
});

test("replaceAll_ShouldStayWithinBudget_WhenGiven50000Objects", () => {
  const store = new ObjectStore(listener);
  const objects = manyObjects();

  const time = elapsed(() => store.replaceAll(objects, "api"));

  expect(time).toBeLessThan(150);
});

test("replaceAll_ShouldStayWithinBudget_WhenEachOf50000ObjectsHasAppData", () => {
  const store = new ObjectStore(listener);
  const objects = manyObjects().map((object, index) =>
    ({ ...object, appData: { section: String(index % 7), step: "1", owner: "a" } }));

  const time = elapsed(() => store.replaceAll(objects, "api"));

  expect(time).toBeLessThan(250);
});

test("replaceAll_ShouldStayWithinBudget_WhenAll50000ObjectsAreUnchanged", () => {
  const store = filledStore();
  const objects = manyObjects();

  const time = elapsed(() => store.replaceAll(objects, "api"));

  expect(time).toBeLessThan(300);
});

test("apply_ShouldStayWithinBudget_WhenBatchChanges1000Of50000Objects", () => {
  const store = filledStore();
  const upsert = manyObjects().slice(0, 1_000).map((object) => ({ ...object, locked: true }));
  const remove = Array.from({ length: 1_000 }, (_, index) => `object-${count - 1 - index}`);

  const time = elapsed(() => store.apply({ upsert, remove, basedOn: 0 }, "api"));

  expect(time).toBeLessThan(15);
});

test("update_ShouldStayWithinBudget_WhenUpdatingEachOf50000Objects", () => {
  const store = filledStore();

  const time = elapsed(() => {
    for (let index = 0; index < count; index++) {
      store.update(`object-${index}`, { rect: { x: 1, y: 2, width: 3, height: 4 } }, "api");
    }
  });

  expect(time).toBeLessThan(100);
});

test("select_ShouldStayWithinBudget_WhenSelectingEachOf50000Objects", () => {
  const store = filledStore();

  const time = elapsed(() => {
    for (let index = 0; index < count; index++) {
      store.select([`object-${index}`], "api");
    }
  });

  expect(time).toBeLessThan(50);
});

test("isSelected_ShouldStayWithinBudget_WhenAll50000ObjectsAreSelected", () => {
  const store = filledStore();
  store.select(store.all().map(({ id }) => id), "api");

  const time = elapsed(() => {
    for (let index = 0; index < count; index++) {
      store.isSelected(`object-${index}`);
    }
  });

  expect(time).toBeLessThan(50);
});

test("remove_ShouldStayWithinBudget_WhenRemovingEachOf50000SelectedObjects", () => {
  const store = filledStore();

  const time = elapsed(() => {
    for (let index = 0; index < count; index++) {
      store.select([`object-${index}`], "api");
      store.remove(`object-${index}`, "api");
    }
  });

  expect(time).toBeLessThan(100);
});

test("remove_ShouldStayWithinBudget_WhenRemovingUnselectedObjectsWhileHalfAreSelected", () => {
  const store = filledStore();
  const half = count / 2;
  store.select(Array.from({ length: half }, (_, index) => `object-${index}`), "api");

  const time = elapsed(() => {
    for (let index = half; index < count; index++) {
      store.remove(`object-${index}`, "api");
    }
  });

  expect(time).toBeLessThan(100);
});

test("forPage_ShouldStayWithinBudget_WhenReadingEveryPageOf50000Objects", () => {
  const store = filledStore();

  const time = elapsed(() => {
    for (let page = 1; page <= pageCount; page++) {
      store.forPage(page);
    }
  });

  expect(time).toBeLessThan(200);
});
