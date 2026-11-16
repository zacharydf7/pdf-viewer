import { expect, test } from "@playwright/test";
import type { PdfViewerElement } from "../../src/viewer-element.js";
import { openViewer } from "./support.js";

// Runs only in the forced-colors project, which emulates a high contrast mode.

const rect = { x: 100, y: 100, width: 150, height: 60 };

test("objects_ShouldStayDistinguishable_WhenHighContrastModeIsOn", async ({ page }) => {
  const viewer = await openViewer(page, { initialZoom: 1 });
  await viewer.host.evaluate((element: PdfViewerElement, value) => {
    element.setObjects([
      { id: "normal", page: 1, rect: value },
      { id: "selected", page: 1, rect: { ...value, y: 200 } },
      { id: "focused", page: 1, rect: { ...value, y: 300 } },
      { id: "both", page: 1, rect: { ...value, y: 400 } },
      { id: "hidden", page: 1, rect: { ...value, y: 500 }, hidden: true },
    ]);
    element.selectObjects(["selected", "both"]);
  }, rect);

  const cue = async (id: string) => {
    // A key press makes the focus that follows count as keyboard focus, as Tab would.
    if (id === "focused" || id === "both") {
      await page.keyboard.press("Shift");
      await viewer.object(id).focus();
    }
    return viewer.object(id).evaluate((element) => {
      const { outlineStyle, outlineColor } = getComputedStyle(element);
      return { style: outlineStyle, color: outlineColor };
    });
  };
  const cues = [await cue("normal"), await cue("selected"), await cue("focused"), await cue("both")];
  const highlight = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.color = "Highlight";
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });

  // Each state has its own ring shape, so none of them depends on color alone.
  expect(new Set(cues.map(({ style }) => style)).size).toBe(4);
  // The selection also takes the highlight color, which sets it apart from focus by color.
  const [, selected, focused, both] = cues.map(({ color }) => color);
  expect([selected, both]).toEqual([highlight, highlight]);
  expect(focused).not.toBe(highlight);
  // A hidden object isn't displayed at all, so there's no border for high contrast to recolor.
  await expect(viewer.object("hidden")).toBeHidden();
});
