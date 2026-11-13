import type { DocumentErrorCode } from "./engine.js";
import type { Rotation } from "./geometry.js";
import type { ObjectsChanged, SelectionChanged } from "./object-store.js";

/**
 * Why the viewer failed. The document codes mean the document couldn't open and is now closed. "page" and "render"
 * mean one page failed while the document stays open, and "command" means a command from .NET was rejected.
 */
export type ViewerErrorCode = DocumentErrorCode | "page" | "render" | "command";

export interface DocumentLoaded {
  pageCount: number;
  /** Each page's label, such as "iv" or "A-3", in page order, or null if the document defines none. */
  pageLabels: readonly string[] | null;
}

export interface PageRendered {
  page: number;
  scale: number;
}

export interface PageChanged {
  page: number;
}

export interface ViewerErrorDetail {
  code: ViewerErrorCode;
  message: string;
  /** Whether the document failed to open and is now closed. */
  documentFailed: boolean;
}

/** A page's label, and its size and total clockwise rotation in the coordinates objects use. */
export interface PageInfo {
  page: number;
  /** The page's label, such as "iv" or "A-3", or null if the document defines none. */
  label: string | null;
  width: number;
  height: number;
  rotation: Rotation;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every event the viewer raises, with its detail. All are bubbling CustomEvents on the element. */
export interface PvEventMap {
  "pv-document-loaded": DocumentLoaded;
  "pv-page-rendered": PageRendered;
  "pv-page-change": PageChanged;
  "pv-objects-changed": ObjectsChanged;
  "pv-selection-change": SelectionChanged;
  "pv-error": ViewerErrorDetail;
}

type PvEvents = { [Type in keyof PvEventMap]: CustomEvent<PvEventMap[Type]> };

declare global {
  // Gives addEventListener("pv-...") a typed event on any element, since the events bubble.
  interface HTMLElementEventMap extends PvEvents {}
}
