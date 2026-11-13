import type { PageGeometry, Rotation } from "../../src/geometry.js";
import type { ObjectAdded, ObjectUpdated, SelectionChanged } from "../../src/object-store.js";
import { ObjectStore } from "../../src/object-store.js";
import type { PointerInput, Preview, ToolContext } from "../../src/tool.js";

/** What a tool did, in order: "show:draft", "show:object" or "show:none" for previews, and the store changes. */
export interface ToolRecord {
  log: string[];
  shown: (Preview | undefined)[];
  added: ObjectAdded[];
  updated: ObjectUpdated[];
  selections: SelectionChanged[];
}

export function recordingContext(): { context: ToolContext; store: ObjectStore; record: ToolRecord } {
  const record: ToolRecord = { log: [], shown: [], added: [], updated: [], selections: [] };
  const store = new ObjectStore({
    onAdded: (change) => { record.log.push("add"); record.added.push(change); },
    onUpdated: (change) => { record.log.push("update"); record.updated.push(change); },
    onRemoved: () => record.log.push("remove"),
    onReplaced: () => record.log.push("replace"),
    onSelectionChanged: (change) => { record.log.push("select"); record.selections.push(change); },
  });
  const show = (preview: Preview | undefined) => {
    record.log.push(`show:${preview?.kind ?? "none"}`);
    record.shown.push(preview);
  };
  return { context: { store, show }, store, record };
}

export function geometry(rotation: Rotation = 0): PageGeometry {
  return { width: 600, height: 800, rotation };
}

/** A pointer at a page-space point on page 1. */
export function at(x: number, y: number, rotation: Rotation = 0): PointerInput {
  return { page: 1, geometry: geometry(rotation), point: { x, y } };
}
