import { PdfViewerElement } from "./viewer-element.js";

if (customElements.get("pdf-viewer") === undefined) {
  customElements.define("pdf-viewer", PdfViewerElement);
}

export { attach } from "./blazor-bridge.js";
export { PdfViewerElement };
export type { DocumentErrorCode, DocumentSource } from "./engine.js";
export type { DocumentLoaded, PageChanged, PageInfo, PageRendered, PvEventMap, ViewerErrorCode, ViewerErrorDetail }
  from "./events.js";
export type { Point, Rect, Rotation } from "./geometry.js";
export type { ChangeOrigin, EditGesture, NewPageObject, ObjectAdded, ObjectPatch, ObjectRemoved, ObjectsReplaced,
  ObjectStyle, ObjectUpdated, PageObject, SelectionChanged } from "./object-store.js";
export type { DrawDefaults, ViewerTool } from "./tool.js";
export type { ViewerOptions, ZoomSetting } from "./viewer-element.js";
