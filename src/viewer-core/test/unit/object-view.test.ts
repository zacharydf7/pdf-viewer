import { describe, expect, it } from "vitest";
import { borderWidthCss } from "../../src/object-view.js";

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
