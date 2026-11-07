import { PdfViewerElement } from "./viewer-element.js";

if (customElements.get("pdf-viewer") === undefined) {
  customElements.define("pdf-viewer", PdfViewerElement);
}

export { attach } from "./blazor-bridge.js";
export { PdfViewerElement };
