/** The only module that talks to pdf.js. It loads the library on demand, and no pdf.js type leaves this file. */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api.js";
import type { PageGeometry, Rotation } from "./geometry.js";
import { normalizeRotation } from "./geometry.js";

type PdfJs = typeof import("pdfjs-dist");

export type DocumentSource =
  | { kind: "url"; url: string; headers?: Record<string, string>; withCredentials?: boolean }
  | { kind: "data"; data: Uint8Array };

export type DocumentErrorCode = "invalid-pdf" | "network" | "password-required" | "password-incorrect" | "unknown";

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;

  constructor(code: DocumentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RenderHandle {
  /** Resolves when finished, and rejects with RenderCancelled if canceled first. */
  readonly done: Promise<void>;
  cancel(): void;
}

export interface TextRender extends RenderHandle {
  /** Moves a finished layer to a new zoom or rotation, which is far cheaper than laying out the text again. */
  update(scale: number, viewRotation: Rotation): void;
}

export class RenderCancelled extends Error {}

export interface CanvasOptions {
  maximumPixels: number;
  /** Leaves form fields unpainted, while other annotations still appear. */
  hideFormFields: boolean;
}

export interface EnginePage {
  /** The page's geometry with a viewer rotation added to its own /Rotate. */
  geometry(viewRotation: Rotation): PageGeometry;
  /** The displayed size in CSS pixels at the given zoom. */
  cssSize(scale: number, viewRotation: Rotation): { width: number; height: number };
  /** CSS scale that text layer styles multiply by, which includes the page's UserUnit. */
  totalScale(scale: number): number;
  renderCanvas(canvas: HTMLCanvasElement, scale: number, viewRotation: Rotation, options: CanvasOptions): RenderHandle;
  /** Lays out selectable text. Extraction can take seconds on some documents, so its result is cached per page. */
  renderText(container: HTMLElement, scale: number, viewRotation: Rotation): TextRender;
  release(): void;
}

export interface EngineDocument {
  readonly pageCount: number;
  getPage(pageNumber: number): Promise<EnginePage>;
  /** The original document's bytes. For a URL source, this fetches whatever hasn't been fetched yet. */
  getData(): Promise<Uint8Array>;
  destroy(): Promise<void>;
}

const textCacheSize = 16;
const assetsUrl = new URL("./pdfjs/", import.meta.url).href;
let pdfJsPromise: Promise<PdfJs> | undefined;

function loadPdfJs(): Promise<PdfJs> {
  pdfJsPromise ??= (import(/* @vite-ignore */ `${assetsUrl}pdf.min.mjs`) as Promise<PdfJs>).then((pdfJs) => {
    pdfJs.GlobalWorkerOptions.workerSrc = `${assetsUrl}pdf.worker.min.mjs`;
    return pdfJs;
  });
  return pdfJsPromise;
}

export async function openDocument(source: DocumentSource): Promise<EngineDocument> {
  const pdfJs = await loadPdfJs();
  const task = pdfJs.getDocument({
    ...(source.kind === "url"
      ? { url: source.url, httpHeaders: source.headers, withCredentials: source.withCredentials }
      : { data: source.data }),
    // Fetch only what the visible page needs when the server supports range requests.
    disableAutoFetch: true,
    disableStream: true,
    // Bundled fonts keep rendering the same across machines.
    useSystemFonts: false,
    wasmUrl: `${assetsUrl}wasm/`,
    cMapUrl: `${assetsUrl}cmaps/`,
    cMapPacked: true,
    iccUrl: `${assetsUrl}iccs/`,
    standardFontDataUrl: `${assetsUrl}standard_fonts/`,
  });

  let document: PDFDocumentProxy;
  try {
    document = await task.promise;
  } catch (error) {
    await task.destroy();
    throw toDocumentError(pdfJs, error);
  }

  const textCache = new Map<number, Promise<TextContent>>();
  return {
    pageCount: document.numPages,
    getPage: async (pageNumber) => wrapPage(pdfJs, await document.getPage(pageNumber), textCache),
    getData: () => document.getData(),
    destroy: () => task.destroy(),
  };
}

/** Returns a page's text from the cache, keeping the most recently used pages. */
function cachedTextContent(page: PDFPageProxy, cache: Map<number, Promise<TextContent>>): Promise<TextContent> {
  const content = cache.get(page.pageNumber) ?? page.getTextContent({ disableNormalization: true });
  cache.delete(page.pageNumber);
  cache.set(page.pageNumber, content);
  if (cache.size > textCacheSize) {
    cache.delete(cache.keys().next().value!);
  }
  return content;
}

function wrapPage(pdfJs: PdfJs, page: PDFPageProxy, textCache: Map<number, Promise<TextContent>>): EnginePage {
  const viewport = (scale: number, viewRotation: Rotation) =>
    page.getViewport({ scale, rotation: normalizeRotation(page.rotate + viewRotation) });
  // The layer is laid out unrotated, and pv.css rotates it from the attribute pdf.js sets.
  const textViewport = (scale: number, viewRotation: Rotation) => viewport(scale, viewRotation).clone({ dontFlip: true });

  return {
    geometry(viewRotation) {
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      return { width: x1 - x0, height: y1 - y0, rotation: normalizeRotation(page.rotate + viewRotation) };
    },
    cssSize(scale, viewRotation) {
      const { width, height } = viewport(scale, viewRotation);
      return { width, height };
    },
    totalScale: (scale) => scale * page.userUnit,
    renderCanvas(canvas, scale, viewRotation, { maximumPixels, hideFormFields }) {
      const target = viewport(scale, viewRotation);
      const pixelLimit = Math.sqrt(maximumPixels / (target.width * target.height));
      const pixelRatio = Math.min(window.devicePixelRatio || 1, pixelLimit);
      canvas.width = Math.floor(target.width * pixelRatio);
      canvas.height = Math.floor(target.height * pixelRatio);
      const task = page.render({
        canvas,
        viewport: target,
        transform: [canvas.width / target.width, 0, 0, canvas.height / target.height, 0, 0],
        // This mode expects form fields to be drawn by a separate layer, and without one they simply don't appear.
        annotationMode: hideFormFields ? pdfJs.AnnotationMode.ENABLE_FORMS : pdfJs.AnnotationMode.ENABLE,
      });
      return {
        done: task.promise.catch((error: unknown) => {
          throw error instanceof pdfJs.RenderingCancelledException ? new RenderCancelled() : error;
        }),
        cancel: () => task.cancel(),
      };
    },
    renderText(container, scale, viewRotation) {
      let layer: InstanceType<PdfJs["TextLayer"]> | undefined;
      let canceled = false;
      const render = async () => {
        const textContentSource = await cachedTextContent(page, textCache);
        if (canceled) {
          throw new RenderCancelled();
        }
        layer = new pdfJs.TextLayer({ textContentSource, container, viewport: textViewport(scale, viewRotation) });
        await layer.render();
      };
      return {
        done: render().catch((error: unknown) => {
          throw canceled ? new RenderCancelled() : error;
        }),
        cancel() {
          canceled = true;
          layer?.cancel();
        },
        update(newScale, newRotation) {
          layer?.update({ viewport: textViewport(newScale, newRotation) });
        },
      };
    },
    release: () => page.cleanup(),
  };
}

function toDocumentError(pdfJs: PdfJs, error: unknown): DocumentError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof pdfJs.PasswordException) {
    const incorrect = error.code === pdfJs.PasswordResponses.INCORRECT_PASSWORD;
    return new DocumentError(incorrect ? "password-incorrect" : "password-required", message);
  }
  if (error instanceof pdfJs.InvalidPDFException) {
    return new DocumentError("invalid-pdf", message);
  }
  if (error instanceof pdfJs.ResponseException) {
    return new DocumentError("network", message);
  }
  return new DocumentError("unknown", message);
}
