import type { Point } from "./geometry.js";
import { clampPoint, rectFromCorners } from "./geometry.js";
import type { ObjectStore } from "./object-store.js";
import type { DrawDefaults, PointerInput, PointerPress, Preview, PressResult, Tool, ToolContext, ToolPresentation }
  from "./tool.js";
import { finalRect } from "./tool.js";

/** The smallest width and height a drawn rectangle can have, in page units, so a click doesn't make one. */
const minimumDrawSize = 2;

/**
 * Draws a rectangle from where the pointer is pressed to where it's released, and leaves it with the store as a draft.
 */
export class DrawRectTool implements Tool {
  readonly presentation: ToolPresentation = { pointer: "page", focusable: true, handles: false, readOnly: false };
  readonly #store: ObjectStore;
  readonly #show: (preview: Preview | undefined) => void;
  /** Kept for its options, which are read at each use because they can change. */
  readonly #context: ToolContext;
  readonly #defaults: DrawDefaults;
  #draw: { page: number; start: Point; current: Point } | undefined;

  /** The defaults are applied to every rectangle drawn. */
  constructor(context: ToolContext, defaults: DrawDefaults) {
    this.#store = context.store;
    this.#show = context.show;
    this.#context = context;
    this.#defaults = defaults;
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
    const final = finalRect(geometry, rect, this.#context.options.roundCoordinates);
    this.#store.addDraft({ id: newObjectId(), page: draw.page, rect: final, ...this.#defaults });
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
    this.#show({ kind: "draft", page, rect: rectFromCorners(start, current), defaults: this.#defaults });
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
