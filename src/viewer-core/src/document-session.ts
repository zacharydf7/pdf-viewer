import type { EngineDocument, EnginePage } from "./engine.js";
import type { Rotation } from "./geometry.js";
import { normalizeRotation } from "./geometry.js";

/** One open document and what the viewer remembers about it, all of which is discarded when the document closes. */
export class DocumentSession {
  readonly #document: EngineDocument;
  readonly #pageRotations = new Map<number, Rotation>();

  constructor(document: EngineDocument) {
    this.#document = document;
  }

  get pageCount(): number {
    return this.#document.pageCount;
  }

  /** Each page's label in page order, or null if the document defines none. */
  get pageLabels(): readonly string[] | null {
    return this.#document.pageLabels;
  }

  getPage(pageNumber: number): Promise<EnginePage> {
    return this.#document.getPage(pageNumber);
  }

  /** The original document's bytes. For a URL source, this fetches whatever hasn't been fetched yet. */
  getData(): Promise<Uint8Array> {
    return this.#document.getData();
  }

  /** Sets the rotation one page ends up with. Null returns the page to its own rotation plus the viewing rotation. */
  setPageRotation(pageNumber: number, rotation: Rotation | null): void {
    if (rotation === null) {
      this.#pageRotations.delete(pageNumber);
    } else {
      this.#pageRotations.set(pageNumber, rotation);
    }
  }

  /**
   * The rotation to add to a page's own: the viewing rotation, or whatever reaches the rotation set for that page
   * alone.
   */
  viewRotation(page: EnginePage, pageNumber: number, viewingRotation: Rotation): Rotation {
    const final = this.#pageRotations.get(pageNumber);
    return final === undefined ? viewingRotation : normalizeRotation(final - page.geometry(0).rotation);
  }

  destroy(): Promise<void> {
    return this.#document.destroy();
  }
}
