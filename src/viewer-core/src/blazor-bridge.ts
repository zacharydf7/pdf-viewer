import type { DocumentSource } from "./engine.js";
import type { PageInfo, PvEventMap } from "./events.js";
import { errorMessage } from "./events.js";
import type { NewPageObject, PageObject } from "./object-store.js";
import type { DrawDefaults, ViewerTool } from "./tool.js";
import type { PdfViewerElement } from "./viewer-element.js";
import type { ViewerOptions, ZoomSetting } from "./viewer-options.js";

/** The part of Blazor's DotNetObjectReference this module needs. */
interface DotNetReference {
  invokeMethodAsync(method: string, ...args: unknown[]): Promise<unknown>;
}

type BlazorSource = DocumentSource | { kind: "file-input"; input: HTMLInputElement };

/**
 * Which frequent notifications .NET has handlers for. Each object change is one message, so an application that replaces
 * its objects one at a time, for example on every page turn, would otherwise fill the circuit with messages nothing reads.
 * .NET sends them again whenever its handlers change.
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
  #subscriptions: ViewerSubscriptions;

  constructor(host: PdfViewerElement, dotNet: DotNetReference, subscriptions: ViewerSubscriptions) {
    this.#host = host;
    this.#dotNet = dotNet;
    this.#subscriptions = subscriptions;
    const { signal } = this.#abort;
    // Each event's detail goes to .NET unchanged, as the one argument of the method named here, unless the event
    // belongs to a kind .NET hasn't subscribed to.
    const forward = (type: keyof PvEventMap, method: string, kind?: keyof ViewerSubscriptions) =>
      host.addEventListener(type, (event) => {
        if (kind === undefined || this.#subscriptions[kind]) {
          this.#notify(method, event.detail);
        }
      }, { signal });

    // This one goes without its page labels, which in a long document could exceed the hub's message size limit. .NET
    // asks for a page's label with getPageInfo. It carries the page shown first, so .NET needn't work it out.
    host.addEventListener("pv-document-loaded", ({ detail }) =>
      this.#notify("NotifyDocumentLoaded", { pageCount: detail.pageCount, page: host.currentPage }), { signal });
    forward("pv-page-change", "NotifyPageChanged");
    forward("pv-error", "NotifyError");
    forward("pv-object-added", "NotifyObjectAdded", "objects");
    forward("pv-object-updated", "NotifyObjectUpdated", "objects");
    forward("pv-object-removed", "NotifyObjectRemoved", "objects");
    forward("pv-objects-replaced", "NotifyObjectsReplaced", "objects");
    // The ids are left out for the same reason as the page labels: any number of objects can be selected. .NET gets
    // their count, and asks for the ids with getSelectedObjectIds.
    host.addEventListener("pv-selection-change", ({ detail: { sequence, origin, primaryId, ids } }) => {
      if (this.#subscriptions.selection) {
        this.#notify("NotifySelectionChanged", { sequence, origin, primaryId, count: ids.length });
      }
    }, { signal });
  }

  subscribe = (subscriptions: ViewerSubscriptions): void => {
    this.#subscriptions = subscriptions;
  };

  /** Applies options at once, without ending a gesture in progress. */
  configure = (options: ViewerOptions): void => this.#host.configure(options);

  /**
   * Most commands return as soon as they are accepted, because a large document can outlast the interop call timeout.
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
  /** Resolves once the page is shown, or the turn has failed or been replaced by another, so .NET can await it. */
  goToPage = (page: number): Promise<void> => this.#host.goToPage(page);
  /** Resolves once the object is in view, turning to its page first if it isn't displayed. */
  scrollObjectIntoView = (id: string): Promise<void> => this.#host.scrollObjectIntoView(id);
  setZoom = (zoom: ZoomSetting): void => this.#run(this.#host.setZoom(zoom));
  /** Does nothing until a page has been sized, because until then there's no zoom to multiply. */
  zoomBy = (factor: number): void => {
    if (this.#host.zoom !== undefined) {
      this.#run(this.#host.setZoom(this.#host.zoom * factor));
    }
  };
  setRotation = (degrees: number): void => this.#run(this.#host.setRotation(degrees));
  /** Adds to the viewing rotation the element has now, so .NET needn't keep its own copy. */
  rotateBy = (degrees: number): void => this.#run(this.#host.setRotation(this.#host.rotation + degrees));
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
