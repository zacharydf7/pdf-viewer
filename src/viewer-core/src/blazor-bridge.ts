import type { DocumentSource } from "./engine.js";
import type { ObjectDrawn, PageInfo, PvEventMap } from "./events.js";
import { errorMessage } from "./events.js";
import type { ChangeOrigin, ObjectBatch, ObjectUpdate, PageObject } from "./object-store.js";
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
  /** Whether .NET decides what becomes of each object the user draws. Without that, a drawn object is added at once. */
  drawn: boolean;
  /** Whether .NET decides on each object the user asks to delete. Without that, the object is removed at once. */
  deleteRequested: boolean;
}

/**
 * What .NET hears of in one message: the object changes the user made since the last message, and the selection as it
 * now stands. The sequence is that of the latest change either part reports.
 */
interface ChangesNotification {
  sequence: number;
  objects: { added: PageObject[]; updated: ObjectUpdate[]; removed: PageObject[] } | null;
  selection: { origin: ChangeOrigin; primaryId: string | null; count: number } | null;
}

/** The .NET side of a viewer. Only state and commands pass through, except when .NET asks for the document's bytes. */
export class ViewerBridge {
  readonly #host: PdfViewerElement;
  readonly #dotNet: DotNetReference;
  readonly #abort = new AbortController();
  #subscriptions: ViewerSubscriptions;
  /** Changes waiting to go to .NET together, once the task that made them has finished. */
  #pending: ChangesNotification | undefined;
  /** The drafts whose handlers .NET is still running. */
  readonly #heldDrafts = new Set<string>();

  constructor(host: PdfViewerElement, dotNet: DotNetReference, subscriptions: ViewerSubscriptions) {
    this.#host = host;
    this.#dotNet = dotNet;
    this.#subscriptions = subscriptions;
    const { signal } = this.#abort;
    // Each event's detail goes to .NET unchanged, as the one argument of the method named here.
    const forward = (type: keyof PvEventMap, method: string) =>
      host.addEventListener(type, (event) => this.#notify(method, event.detail), { signal });

    // This one goes without its page labels, which in a long document could exceed the hub's message size limit. .NET
    // asks for a page's label with getPageInfo. It carries the page shown first, so .NET needn't work it out.
    host.addEventListener("pv-document-loaded", ({ detail }) =>
      this.#notify("NotifyDocumentLoaded", { pageCount: detail.pageCount, page: host.currentPage }), { signal });
    forward("pv-page-change", "NotifyPageChanged");
    forward("pv-error", "NotifyError");
    host.addEventListener("pv-object-drawn", (event) => {
      if (this.#subscriptions.drawn) {
        event.preventDefault();
        this.#hold(event.detail);
      }
    }, { signal });
    host.addEventListener("pv-delete-requested", (event) => {
      if (this.#subscriptions.deleteRequested) {
        event.preventDefault();
        void this.#notify("NotifyDeleteRequested", event.detail);
      }
    }, { signal });
    // .NET hears only of the object changes the user made. It made the others itself, and a whole document's objects
    // could exceed the hub's message size limit.
    host.addEventListener("pv-objects-changed", ({ detail: { sequence, origin, added, updated, removed } }) => {
      if (origin === "user" && this.#subscriptions.objects) {
        const objects = this.#pendingChanges(sequence).objects ??= { added: [], updated: [], removed: [] };
        objects.added.push(...added);
        objects.updated.push(...updated);
        objects.removed.push(...removed);
      }
    }, { signal });
    // The ids are left out for the same reason as the page labels: any number of objects can be selected. .NET gets
    // their count, and asks for the ids with getSelectedObjectIds.
    host.addEventListener("pv-selection-change", ({ detail: { sequence, origin, primaryId, ids } }) => {
      if (this.#subscriptions.selection) {
        this.#pendingChanges(sequence).selection = { origin, primaryId, count: ids.length };
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
  /** Every object .NET sends is whole, so one it changed replaces the stored object, clearing whatever it left out. */
  applyObjects = (batch: ObjectBatch): void => this.#host.applyObjects(batch);
  setReadOnly = (readOnly: boolean): void => {
    this.#host.readOnly = readOnly;
  };
  /** Resolves once the move has been applied, which waits for its page if that isn't displayed. */
  moveObjectBy = async (id: string, deltaX: number, deltaY: number): Promise<void> => {
    await this.#host.moveObjectBy(id, deltaX, deltaY);
  };
  commitDraft = (id: string): boolean => this.#host.commitDraft(id);
  discardDraft = (id: string): boolean => this.#host.discardDraft(id);
  selectObjects = (ids: string[]): void => this.#host.selectObjects(ids);
  /** The selected ids as UTF-8 JSON, which .NET reads as a stream, so their number isn't limited by the hub. */
  getSelectedObjectIds = (): Uint8Array => new TextEncoder().encode(JSON.stringify(this.#host.selectedObjectIds));
  getPageInfo = (page: number): Promise<PageInfo> => this.#host.getPageInfo(page);

  /** Discards the drafts .NET was still deciding on, since nothing will answer for them now. */
  dispose(): void {
    this.#abort.abort();
    this.#pending = undefined;
    for (const id of this.#heldDrafts) {
      this.#host.discardDraft(id);
    }
    this.#heldDrafts.clear();
  }

  /**
   * Keeps a drawn object as a draft until .NET's handler has finished, however long that takes. A handler that wants
   * the object commits the draft before it finishes, by adding an object with its id or with commitDraft, so a draft
   * still there afterward is discarded. So is one whose handler failed, or whose notification found the circuit gone.
   * A circuit that closes while the handler is running leaves the notification unanswered, so that draft stays until
   * the circuit reconnects and answers, or the page reloads.
   */
  #hold({ object }: ObjectDrawn): void {
    this.#heldDrafts.add(object.id);
    void this.#notify("NotifyObjectDrawn", { object }).then(() => {
      if (this.#heldDrafts.delete(object.id)) {
        this.#host.discardDraft(object.id);
      }
    });
  }

  /**
   * The message that will carry the changes made in this task. One gesture often makes several, such as drawing an
   * object and selecting it, and together they cost one message over the circuit.
   */
  #pendingChanges(sequence: number): ChangesNotification {
    if (this.#pending === undefined) {
      queueMicrotask(() => {
        const pending = this.#pending;
        this.#pending = undefined;
        if (pending !== undefined) {
          this.#notify("NotifyChanges", pending);
        }
      });
    }
    this.#pending ??= { sequence, objects: null, selection: null };
    this.#pending.sequence = sequence;
    return this.#pending;
  }

  /** Commands aren't awaited by .NET, so a command that fails has to report itself. */
  #run(command: Promise<unknown>): void {
    command.catch((error: unknown) => {
      const detail: PvEventMap["pv-error"] = { code: "command", message: errorMessage(error), documentFailed: false };
      this.#host.dispatchEvent(new CustomEvent("pv-error", { detail, bubbles: true }));
    });
  }

  /** Resolves once .NET has finished handling the notification, whether or not that worked. */
  #notify(method: string, ...args: unknown[]): Promise<void> {
    // Warn rather than rethrow: a lost circuit also ends up here and the element keeps working without it. Staying silent
    // would hide a failing handler.
    return this.#dotNet.invokeMethodAsync(method, ...args).then(() => {}, (error: unknown) => {
      console.warn(`The viewer's ${method} notification failed.`, error);
    });
  }
}

export function attach(host: PdfViewerElement, dotNet: DotNetReference, options: ViewerOptions,
  subscriptions: ViewerSubscriptions): ViewerBridge {
  host.configure(options);
  return new ViewerBridge(host, dotNet, subscriptions);
}
