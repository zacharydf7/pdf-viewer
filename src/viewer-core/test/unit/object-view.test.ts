import { describe, expect, it } from "vitest";
import type { PageGeometry, Rect, Rotation } from "../../src/geometry.js";
import type { PageObject } from "../../src/object-store.js";
import { borderWidthCss, compareFocusOrder, inFocusOrder } from "../../src/object-view.js";

describe("borderWidthCss", () => {
  it("borderWidthCss_ShouldScaleByPageUnit_WhenGivenNumber", () => {
    expect(borderWidthCss(1.5)).toBe("calc(var(--pv-unit) * 1.5)");
  });

  it("borderWidthCss_ShouldKeepLength_WhenGivenCssLength", () => {
    expect(borderWidthCss("3px")).toBe("3px");
  });

  it("borderWidthCss_ShouldBeEmpty_WhenGivenNothing", () => {
    expect(borderWidthCss(undefined)).toBe("");
  });
});

describe("compareFocusOrder", () => {
  const top = { x: 10, y: 10 };
  const bottom = { x: 10, y: 600 };

  it("compareFocusOrder_ShouldPutLowerFocusOrderFirst_WhenItComesLaterInReadingOrder", () => {
    expect(compareFocusOrder({ focusOrder: 0, position: bottom }, { focusOrder: 1, position: top })).toBeLessThan(0);
  });

  it("compareFocusOrder_ShouldFollowReadingOrder_WhenFocusOrdersTie", () => {
    expect(compareFocusOrder({ focusOrder: 2, position: bottom }, { focusOrder: 2, position: top })).toBeGreaterThan(0);
  });
});

describe("inFocusOrder", () => {
  const page = (rotation: Rotation): PageGeometry => ({ width: 600, height: 800, rotation });
  const object = (id: string, rect: Rect, focusOrder = 0): PageObject => ({ id, page: 1, rect, shape: "rect",
    locked: false, selectable: true, hidden: false, editableWhenReadOnly: false, focusOrder });
  const topLeft = object("top-left", { x: 10, y: 10, width: 50, height: 20 });
  const topRight = object("top-right", { x: 400, y: 10, width: 50, height: 20 });
  const bottomLeft = object("bottom-left", { x: 10, y: 600, width: 50, height: 20 });
  const objects = [bottomLeft, topRight, topLeft];

  it("inFocusOrder_ShouldGoTopToBottomThenLeftToRight_WhenPageIsUpright", () => {
    expect(inFocusOrder(objects, page(0))).toEqual([topLeft, topRight, bottomLeft]);
  });

  // At 90 degrees the page's left edge is shown at the top, so its left-most objects come first, bottom to top.
  it("inFocusOrder_ShouldFollowPageAsShown_WhenPageIsRotatedBy90", () => {
    expect(inFocusOrder(objects, page(90))).toEqual([bottomLeft, topLeft, topRight]);
  });

  it("inFocusOrder_ShouldPutLowerFocusOrderFirst_WhenObjectsHaveOne", () => {
    const last = { ...topLeft, focusOrder: 1 };

    expect(inFocusOrder([last, topRight, bottomLeft], page(0))).toEqual([topRight, bottomLeft, last]);
  });

  it("inFocusOrder_ShouldLeaveItsInputAlone_WhenSorting", () => {
    const input = [...objects];

    inFocusOrder(input, page(0));

    expect(input).toEqual(objects);
  });
});
