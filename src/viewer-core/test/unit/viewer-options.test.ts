import { describe, expect, it } from "vitest";
import type { ResolvedOptions } from "../../src/viewer-options.js";
import { defaultOptions, mergeOptions, needsRepaint } from "../../src/viewer-options.js";

describe("merging", () => {
  it("mergeOptions_ShouldKeepEveryOption_WhenGivenNone", () => {
    const current: ResolvedOptions = { ...defaultOptions, keyboardEditing: false, initialZoom: 2 };

    expect(mergeOptions(current, {})).toEqual(current);
  });

  it("mergeOptions_ShouldChangeOnlyOptionsGiven_WhenGivenSome", () => {
    const given = { roundCoordinates: true, selectOnCreate: false, objectHitArea: "border" } as const;

    expect(mergeOptions(defaultOptions, given)).toEqual({ ...defaultOptions, ...given });
  });

  it("mergeOptions_ShouldKeepInitialZoom_WhenGivenZoomThatIsNotFinite", () => {
    const current: ResolvedOptions = { ...defaultOptions, initialZoom: 2 };

    expect(mergeOptions(current, { initialZoom: Number.NaN }).initialZoom).toBe(2);
  });

  it.each([[50, 10], [0.01, 0.1], ["fit-page", "fit-page"]] as const)(
    "mergeOptions_ShouldKeepInitialZoomInLimits_WhenGiven%s", (zoom, expected) => {
      expect(mergeOptions(defaultOptions, { initialZoom: zoom }).initialZoom).toBe(expected);
    });
});

describe("repainting", () => {
  it.each([
    ["hideFormFields", true, true], ["coordinates", "display", true],
    ["keyboardEditing", false, false], ["roundCoordinates", true, false], ["wheelZoom", false, false],
    ["objectHitArea", "border", false], ["initialZoom", 2, false],
  ] as const)("needsRepaint_ShouldBe%3$s_WhenOnly%1$sChanges", (option, value, expected) => {
    expect(needsRepaint(defaultOptions, { ...defaultOptions, [option]: value })).toBe(expected);
  });

  it("needsRepaint_ShouldBeFalse_WhenNothingChanges", () => {
    expect(needsRepaint(defaultOptions, { ...defaultOptions })).toBe(false);
  });
});
