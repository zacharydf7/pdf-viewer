import type { DocumentSource } from "./engine.js";
import type { DrawDefaults, ViewerTool } from "./object-layer.js";
import type { NewPageObject, ObjectChange, PageObject, SelectionChange } from "./object-store.js";
import type { PdfViewerElement, ViewerOptions, ZoomSetting } from "./viewer-element.js";

/** The part of Blazor's DotNetObjectReference this module needs. */
interface DotNetReference {
  invokeMethodAsync(method: string, ...args: unknown[]): Promise<unknown>;
}

type BlazorSource = DocumentSource | { kind: "file-input"; input: HTMLInputElement };

/** The .NET side of a viewer. Bytes never pass through here, only state and commands. */
export class ViewerBridge {
  readonly #host: PdfViewerElement;
  readonly #dotNet: DotNetReference;
  readonly #abort = new AbortController();

  constructor(host: PdfViewerElement, dotNet: DotNetReference) {
    this.#host = host;
    this.#dotNet = dotNet;
    const { signal } = this.#abort;
    const on = <T>(type: string, listener: (detail: T) => void) =>
      host.addEventListener(type, (event) => listener((event as CustomEvent<T>).detail), { signal });

    on<{ pageCount: number }>("pv-document-loaded", ({ pageCount }) => this.#notify("NotifyDocumentLoaded", pageCount));
    on<{ page: number }>("pv-page-change", ({ page }) => this.#notify("NotifyPageChanged", page));
    on<{ code: string; message: string }>("pv-error", ({ code, message }) =>
      this.#notify("NotifyError", code, message));
    on<ObjectChange>("pv-object-change", (change) => this.#notify("NotifyObjectChanged", change));
    on<SelectionChange>("pv-selection-change", (change) => this.#notify("NotifySelectionChanged", change));
  }

  /**
   * Commands return as soon as they are accepted, because a large document can outlast the interop call timeout.
   * Results arrive as events. A local file is read here, in the browser, so its bytes never cross the circuit.
   */
  open(source: BlazorSource, initialPage: number): void {
    if (source.kind !== "file-input") {
      void this.#host.open(source, initialPage);
      return;
    }
    const file = source.input.files?.[0];
    if (file !== undefined) {
      // Clearing the input lets the user pick the same file again and still get a change event.
      source.input.value = "";
      void file.arrayBuffer().then((data) =>
        this.#host.open({ kind: "data", data: new Uint8Array(data) }, initialPage));
    }
  }

  /** Returned to .NET as a stream, which arrives in chunks and so isn't limited by the hub's message size. */
  getDocumentData = (): Promise<Uint8Array> => this.#host.getDocumentData();

  goToPage = (page: number): void => void this.#host.goToPage(page);
  setZoom = (zoom: ZoomSetting): void => void this.#host.setZoom(zoom);
  zoomBy = (factor: number): void => void this.#host.setZoom(Number(this.#host.dataset.zoom) * factor);
  setRotation = (degrees: number): void => void this.#host.setRotation(degrees);
  setPageRotation = (page: number, degrees: number | null): void => void this.#host.setPageRotation(page, degrees);
  setTool = (tool: ViewerTool, defaults: DrawDefaults | null): void => this.#host.setTool(tool, defaults ?? {});
  addObject = (object: NewPageObject): PageObject => this.#host.addObject(object);
  updateObject = (object: PageObject): PageObject => this.#host.updateObject(object.id, object);
  removeObject = (id: string): void => this.#host.removeObject(id);
  setObjects = (objects: NewPageObject[]): void => this.#host.setObjects(objects);
  selectObject = (id: string | null): void => this.#host.selectObject(id);

  dispose(): void {
    this.#abort.abort();
  }

  #notify(method: string, ...args: unknown[]): void {
    // Rejections only mean the circuit is gone, and the element keeps working without it.
    this.#dotNet.invokeMethodAsync(method, ...args).catch(() => {});
  }
}

export function attach(host: PdfViewerElement, dotNet: DotNetReference, options: ViewerOptions): ViewerBridge {
  host.configure(options);
  return new ViewerBridge(host, dotNet);
}
