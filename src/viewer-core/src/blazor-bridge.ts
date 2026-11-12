import type { DocumentSource } from "./engine.js";
import type { PageInfo, PvEventMap } from "./events.js";
import type { DrawDefaults, ViewerTool } from "./object-layer.js";
import type { NewPageObject, PageObject } from "./object-store.js";
import type { PdfViewerElement, ViewerOptions, ZoomSetting } from "./viewer-element.js";
import { errorMessage } from "./viewer-element.js";

/** The part of Blazor's DotNetObjectReference this module needs. */
interface DotNetReference {
  invokeMethodAsync(method: string, ...args: unknown[]): Promise<unknown>;
}

type BlazorSource = DocumentSource | { kind: "file-input"; input: HTMLInputElement };

/**
 * Which frequent notifications .NET has handlers for. Each object change is one message, so an application that replaces
 * its objects one at a time, for example on every page turn, would otherwise fill the circuit with messages nothing reads.
 */
export interface ViewerSubscriptions {
  objects: boolean;
  selection: boolean;
}

/** The .NET side of a viewer. Only state and commands pass through, except when .NET asks for the document's bytes. */
export class ViewerBridge {
  readonly #host: PdfViewerElement;
  readonly #dotNet: DotNetReference;
  readonly #abort = new AbortController();

  constructor(host: PdfViewerElement, dotNet: DotNetReference, subscriptions: ViewerSubscriptions) {
    this.#host = host;
    this.#dotNet = dotNet;
    const { signal } = this.#abort;
    // Each event's detail goes to .NET unchanged, as the one argument of the method named here.
    const forward = (type: keyof PvEventMap, method: string) =>
      host.addEventListener(type, (event) => this.#notify(method, event.detail), { signal });

    // This one goes without its page labels, which in a long document could exceed the hub's message size limit. .NET
    // asks for a page's label with getPageInfo.
    host.addEventListener("pv-document-loaded", ({ detail }) =>
      this.#notify("NotifyDocumentLoaded", { pageCount: detail.pageCount }), { signal });
    forward("pv-page-change", "NotifyPageChanged");
    forward("pv-error", "NotifyError");
    if (subscriptions.objects) {
      forward("pv-object-added", "NotifyObjectAdded");
      forward("pv-object-updated", "NotifyObjectUpdated");
      forward("pv-object-removed", "NotifyObjectRemoved");
      forward("pv-objects-replaced", "NotifyObjectsReplaced");
    }
    if (subscriptions.selection) {
      // The ids are left out for the same reason as the page labels: any number of objects can be selected. .NET
      // gets their count, and asks for the ids with getSelectedObjectIds.
      host.addEventListener("pv-selection-change", ({ detail: { sequence, origin, primaryId, ids } }) =>
        this.#notify("NotifySelectionChanged", { sequence, origin, primaryId, count: ids.length }), { signal });
    }
  }

  /**
   * Commands return as soon as they are accepted, because a large document can outlast the interop call timeout.
   * Results and failures arrive as events. A local file is read in the browser, so opening it sends no bytes over the
   * circuit.
   */
  open(source: BlazorSource, initialPage: number): void {
    if (source.kind !== "file-input") {
      this.#run(this.#host.open(source, initialPage));
      return;
    }
    const file = source.input.files?.[0];
    if (file === undefined) {
      this.#run(this.#host.close());
      return;
    }
    // Clearing the input lets the user pick the same file again and still get a change event.
    source.input.value = "";
    this.#run(this.#host.open({ kind: "file", file }, initialPage));
  }

  /** Returned to .NET as a stream, which arrives in chunks and so isn't limited by the hub's message size. */
  getDocumentData = (): Promise<Uint8Array> => this.#host.getDocumentData();

  close = (): void => this.#run(this.#host.close());
  goToPage = (page: number): void => this.#run(this.#host.goToPage(page));
  setZoom = (zoom: ZoomSetting): void => this.#run(this.#host.setZoom(zoom));
  /** Does nothing until a page has been sized, because until then there's no zoom to multiply. */
  zoomBy = (factor: number): void => this.#run(this.#host.setZoom(Number(this.#host.dataset.zoom) * factor));
  setRotation = (degrees: number): void => this.#run(this.#host.setRotation(degrees));
  setPageRotation = (page: number, degrees: number | null): void => this.#run(this.#host.setPageRotation(page, degrees));
  setTool = (tool: ViewerTool, defaults: DrawDefaults | null): void => this.#host.setTool(tool, defaults ?? {});
  addObject = (object: NewPageObject): PageObject => this.#host.addObject(object);
  /** .NET sends the whole object and leaves out empty values, so anything it left out has to be cleared here. */
  updateObject = (object: PageObject): PageObject =>
    this.#host.updateObject(object.id, { label: undefined, tag: undefined, style: undefined, ...object });
  removeObject = (id: string): void => this.#host.removeObject(id);
  setObjects = (objects: NewPageObject[]): void => this.#host.setObjects(objects);
  selectObjects = (ids: string[]): void => this.#host.selectObjects(ids);
  /** The selected ids as UTF-8 JSON, which .NET reads as a stream, so their number isn't limited by the hub. */
  getSelectedObjectIds = (): Uint8Array => new TextEncoder().encode(JSON.stringify(this.#host.selectedObjectIds));
  getPageInfo = (page: number): Promise<PageInfo> => this.#host.getPageInfo(page);

  dispose(): void {
    this.#abort.abort();
  }

  /** Commands aren't awaited by .NET, so a command that fails has to report itself. */
  #run(command: Promise<unknown>): void {
    command.catch((error: unknown) => {
      const detail: PvEventMap["pv-error"] = { code: "command", message: errorMessage(error), documentFailed: false };
      this.#host.dispatchEvent(new CustomEvent("pv-error", { detail, bubbles: true }));
    });
  }

  #notify(method: string, ...args: unknown[]): void {
    // Warn rather than rethrow: a lost circuit also ends up here and the element keeps working without it. Staying silent
    // would hide a failing handler.
    this.#dotNet.invokeMethodAsync(method, ...args).catch((error: unknown) => {
      console.warn(`The viewer's ${method} notification failed.`, error);
    });
  }
}

export function attach(host: PdfViewerElement, dotNet: DotNetReference, options: ViewerOptions,
  subscriptions: ViewerSubscriptions): ViewerBridge {
  host.configure(options);
  return new ViewerBridge(host, dotNet, subscriptions);
}
