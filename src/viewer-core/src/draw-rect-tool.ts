import type { Point } from "./geometry.js";
import { clampPoint, rectFromCorners } from "./geometry.js";
import type { ObjectStore } from "./object-store.js";
import type { PointerInput, PointerPress, Preview, PressResult, Tool, ToolContext, ToolOptions, ToolPresentation }
  from "./tool.js";
import { finalRect } from "./tool.js";

/** The smallest width and height a drawn rectangle can have, in page units, so a click doesn't make one. */
const minimumDrawSize = 2;

export type DrawRectOptions = Pick<ToolOptions, "drawDefaults" | "roundCoordinates">;

/** Draws a rectangle from where the pointer is pressed to where it's released, then selects it. */
export class DrawRectTool implements Tool {
  readonly presentation: ToolPresentation = { focusable: true, handles: false };
  readonly #store: ObjectStore;
  readonly #show: (preview: Preview | undefined) => void;
  readonly #options: DrawRectOptions;
  #draw: { page: number; start: Point; current: Point } | undefined;

  constructor({ store, show }: ToolContext, options: DrawRectOptions) {
    this.#store = store;
    this.#show = show;
    this.#options = options;
  }

  pointerDown({ page, geometry, point }: PointerPress): PressResult {
    const start = clampPoint(geometry, point);
    this.#draw = { page, start, current: start };
    this.#showDraft();
    return { gesture: true };
  }

  pointerMove({ geometry, point }: PointerInput): void {
    if (this.#draw !== undefined) {
      this.#draw.current = clampPoint(geometry, point);
      this.#showDraft();
    }
  }

  pointerUp({ geometry, point }: PointerInput): void {
    const draw = this.#draw;
    if (draw === undefined) {
      return;
    }
    this.#draw = undefined;
    this.#show(undefined);
    const rect = rectFromCorners(draw.start, clampPoint(geometry, point));
    if (rect.width < minimumDrawSize || rect.height < minimumDrawSize) {
      return;
    }
    const { drawDefaults, roundCoordinates } = this.#options;
    const object = { id: newObjectId(), page: draw.page, rect: finalRect(geometry, rect, roundCoordinates) };
    const added = this.#store.add({ ...object, ...drawDefaults }, "user");
    this.#store.select([added.id], "user");
  }

  cancel(): boolean {
    const drawing = this.#draw !== undefined;
    this.#draw = undefined;
    if (drawing) {
      this.#show(undefined);
    }
    return drawing;
  }

  #showDraft(): void {
    const { page, start, current } = this.#draw!;
    this.#show({ kind: "draft", page, rect: rectFromCorners(start, current) });
  }
}

/** A version 4 UUID, built by hand because crypto.randomUUID only exists on secure origins. */
function newObjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
