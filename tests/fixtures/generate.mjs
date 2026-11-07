// Generates the PDF fixtures and a manifest of where their ink is, so tests can compare rendering to known geometry.
// Every page has a red rectangle at a location known by construction. Run with: npm run fixtures (in src/viewer-core).
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputDirectory = dirname(fileURLToPath(import.meta.url));

/** Ink position in page space: origin at the crop box's top-left corner, y down, unrotated. */
const ink = { x: 100, y: 150, width: 200, height: 100 };

function page(media, options = {}) {
  return { media, ink, ...options };
}

const letter = [0, 0, 612, 792];

const fixtures = {
  letter: [page(letter), page(letter, { ink: { x: 50, y: 400, width: 120, height: 300 } }), page(letter)],
  a4: [page([0, 0, 595, 842])],
  "crop-offset": [page(letter, { crop: [50, 100, 562, 692] })],
  "negative-origin": [page([-100, -200, 512, 592])],
  "rotate-90": [page(letter, { rotate: 90 })],
  "rotate-180": [page(letter, { rotate: 180 })],
  "rotate-270": [page(letter, { rotate: 270 })],
  "crop-offset-rotate-90": [page(letter, { crop: [50, 100, 562, 692], rotate: 90 })],
  "mixed-sizes": [page(letter), page([0, 0, 792, 612]), page([0, 0, 400, 500], { rotate: 90 })],
  "user-unit": [page([0, 0, 400, 500], { userUnit: 2 })],
  // A green form field and a blue square annotation, both with appearance streams.
  annotations: [page(letter, { annotated: true })],
  // Long enough for pdf.js to use range requests, and with filler so that loading one page fetches little of it.
  "range-large": Array.from({ length: 40 }, () => page(letter, { filler: 12_000 })),
};

function buildPdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  add.set = (id, body) => { objects[id - 1] = body; };
  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  // Page dictionaries sit together, ahead of the content. pdf.js visits every page in the tree when opening a document,
  // so scattering them would make it fetch the whole file, however few pages are displayed.
  const contentIds = pages.map((_, index) => 4 + pages.length + index);
  const firstAnnotationId = 4 + pages.length * 2;
  const annotationsOnPage = pages.some(({ annotated }) => annotated);
  const pageIds = pages.map((definition, index) => {
    const contentId = contentIds[index];
    const attributes = [
      `/MediaBox [${definition.media.join(" ")}]`,
      definition.crop && `/CropBox [${definition.crop.join(" ")}]`,
      definition.rotate && `/Rotate ${definition.rotate}`,
      definition.userUnit && `/UserUnit ${definition.userUnit}`,
      definition.annotated && `/Annots [${firstAnnotationId} 0 R ${firstAnnotationId + 2} 0 R]`,
    ].filter(Boolean);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R ${attributes.join(" ")} ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
  });
  pages.forEach((definition, index) => {
    const content = pageContent(definition, index + 1);
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  if (annotationsOnPage) {
    addAnnotation(add, "/Subtype /Widget /FT /Tx /T (field)", [100, 500, 200, 550], "0 1 0 rg");
    addAnnotation(add, "/Subtype /Square", [300, 500, 400, 550], "0 0 1 rg");
  }
  const acroForm = annotationsOnPage ? ` /AcroForm << /Fields [${firstAnnotationId} 0 R] >>` : "";
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${acroForm} >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  let output = "%PDF-1.7\n";
  const offsets = objects.map((body, index) => {
    const offset = output.length;
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xrefOffset = output.length;
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

/** Adds an annotation and its appearance stream, a solid block of the given color, as two consecutive objects. */
function addAnnotation(add, subtype, [left, bottom, right, top], color) {
  const width = right - left;
  const height = top - bottom;
  const appearance = `${color} 0 0 ${width} ${height} re f`;
  const annotationId = add("");
  const appearanceId = add(`<< /Type /XObject /Subtype /Form /BBox [0 0 ${width} ${height}] ` +
    `/Length ${appearance.length} >>\nstream\n${appearance}\nendstream`);
  return add.set(annotationId, `<< /Type /Annot ${subtype} /Rect [${left} ${bottom} ${right} ${top}] /F 4 ` +
    `/AP << /N ${appearanceId} 0 R >> >>`);
}

function pageContent(definition, pageNumber) {
  const [left, , , top] = definition.crop ?? definition.media;
  const { x, y, width, height } = definition.ink;
  const bottom = top - y - height;
  const textBaseline = top - y - height - 40;
  const filler = definition.filler ? `% ${"x".repeat(definition.filler)}\n` : "";
  return `${filler}1 0 0 rg ${left + x} ${bottom} ${width} ${height} re f\n` +
    `0 0 0 rg BT /F1 18 Tf ${left + x} ${textBaseline} Td (Page ${pageNumber} sample text) Tj ET`;
}

const manifest = {};
for (const [name, pages] of Object.entries(fixtures)) {
  await writeFile(join(outputDirectory, `${name}.pdf`), buildPdf(pages));
  manifest[name] = pages.map(({ ink: rect }) => rect);
}
await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
