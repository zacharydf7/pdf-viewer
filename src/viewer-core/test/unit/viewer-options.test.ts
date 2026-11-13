import { describe, expect, it } from "vitest";
import type { ResolvedOptions } from "../../src/viewer-options.js";
import { defaultOptions, mergeOptions, needsRepaint } from "../../src/viewer-options.js";

describe("merging", () => {
  it("mergeOptions_ShouldKeepEveryOption_WhenGivenNone", () => {
    const current: ResolvedOptions = { ...defaultOptions, keyboardEditing: false, initialZoom: 2 };

    expect(mergeOptions(current, {})).toEqual(current);
  });

  it("mergeOptions_ShouldChangeOnlyOptionsGiven_WhenGivenSome", () => {
    const given = { roundCoordinates: true, selectOnCreate: true, objectHitArea: "border" } as const;

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

describe("keyboard steps", () => {
  it("mergeOptions_ShouldTakeStepsAndModifier_WhenGivenThem", () => {
    const given = { keyboardStep: 0.5, keyboardLargeStep: 25, keyboardLargeStepModifier: "alt" } as const;

    expect(mergeOptions(defaultOptions, given)).toEqual({ ...defaultOptions, ...given });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("mergeOptions_ShouldKeepSteps_WhenGivenStepOf%s", (step) => {
    const current: ResolvedOptions = { ...defaultOptions, keyboardStep: 2, keyboardLargeStep: 20 };

    expect(mergeOptions(current, { keyboardStep: step, keyboardLargeStep: step })).toEqual(current);
  });
});

describe("repainting", () => {
  it.each([
    ["hideFormFields", true, true], ["coordinates", "display", true],
    ["keyboardEditing", false, false], ["roundCoordinates", true, false], ["wheelZoom", false, false],
    ["objectHitArea", "border", false], ["initialZoom", 2, false], ["keyboardStep", 5, false],
  ] as const)("needsRepaint_ShouldBe%3$s_WhenOnly%1$sChanges", (option, value, expected) => {
    expect(needsRepaint(defaultOptions, { ...defaultOptions, [option]: value })).toBe(expected);
  });

  it("needsRepaint_ShouldBeFalse_WhenNothingChanges", () => {
    expect(needsRepaint(defaultOptions, { ...defaultOptions })).toBe(false);
  });
});
