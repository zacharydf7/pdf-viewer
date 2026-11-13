import type { PageGeometry, Rotation } from "../../src/geometry.js";
import type { ChangeOrigin, ObjectUpdate, PageObject, SelectionChanged } from "../../src/object-store.js";
import { ObjectStore } from "../../src/object-store.js";
import type { PointerInput, Preview, ToolContext, ToolOptions } from "../../src/tool.js";

/**
 * What a tool did, in order: "show:draft", "show:object" or "show:none" for previews, "draft" for a drawn object left
 * as a draft, "request-delete" for an object it asked to have deleted, and the store changes.
 */
export interface ToolRecord {
  log: string[];
  shown: (Preview | undefined)[];
  drafts: PageObject[];
  deleteRequests: string[];
  added: { origin: ChangeOrigin; object: PageObject }[];
  updated: (ObjectUpdate & { origin: ChangeOrigin })[];
  selections: SelectionChanged[];
}

const defaultToolOptions: ToolOptions = { keyboardEditing: true, keyboardStep: 1, keyboardLargeStep: 10,
  keyboardLargeStepModifier: "ctrl", roundCoordinates: false };

/** A tool context whose options a test can change, as the viewer does, while a tool is active. */
export type TestContext = ToolContext & { options: ToolOptions };

export function recordingContext(options: Partial<ToolOptions> = {}):
  { context: TestContext; store: ObjectStore; record: ToolRecord } {
  const record: ToolRecord =
    { log: [], shown: [], drafts: [], deleteRequests: [], added: [], updated: [], selections: [] };
  const store = new ObjectStore({
    onChanged: ({ origin, added, updated, removed }) => {
      for (const object of added) {
        record.log.push("add");
        record.added.push({ origin, object });
      }
      for (const update of updated) {
        record.log.push("update");
        record.updated.push({ origin, ...update });
      }
      removed.forEach(() => record.log.push("remove"));
    },
    onSelectionChanged: (change) => { record.log.push("select"); record.selections.push(change); },
    onDraftAdded: (draft) => { record.log.push("draft"); record.drafts.push(draft); },
    onDraftResolved() {},
  });
  const show = (preview: Preview | undefined) => {
    record.log.push(`show:${preview?.kind ?? "none"}`);
    record.shown.push(preview);
  };
  const requestDelete = (id: string) => { record.log.push("request-delete"); record.deleteRequests.push(id); };
  const context = { store, show, requestDelete, options: { ...defaultToolOptions, ...options } };
  return { context, store, record };
}

export function geometry(rotation: Rotation = 0): PageGeometry {
  return { width: 600, height: 800, rotation };
}

/** A pointer at a page-space point on page 1. */
export function at(x: number, y: number, rotation: Rotation = 0): PointerInput {
  return { page: 1, geometry: geometry(rotation), point: { x, y } };
}
