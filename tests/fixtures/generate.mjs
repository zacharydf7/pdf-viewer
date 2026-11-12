// Generates the PDF fixtures and a manifest of where their ink is, so tests can compare rendering to known geometry.
// Every page has red ink at a location known by construction. Run with: npm run fixtures (in src/viewer-core).
import { createHash } from "node:crypto";
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

// A fixture is its pages, or an object with pages and options for the whole document.
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
  // The second page has thousands of separate text runs, which is what makes a text layer expensive.
  "dense-text": [page(letter), page(letter, { denseText: true })],
  // Red text in a font whose glyphs the document draws itself. Each glyph is three quarters of an em wide and tall, so the
  // four glyphs' ink is known by construction.
  "type3-font": {
    font: "type3",
    pages: [page(letter, { ink: { x: 100, y: 150, width: 150, height: 30 }, text: "ABBA" })],
  },
  // Japanese text in a font that isn't embedded, so reading it takes pdf.js's CMap files. The glyphs come from whatever
  // font the browser falls back to, so only the text layer is predictable.
  "cjk-cmap": { font: "cjk", pages: [page(letter)] },
  // Opens without a password, but its streams still have to be decrypted.
  "encrypted-owner": { ownerPassword: "owner", userPassword: "", pages: [page(letter)] },
  "encrypted-user": { ownerPassword: "owner", userPassword: "user", pages: [page(letter)] },
};

/** Each font's object, and the string operand its sample text uses. */
const fonts = {
  standard: {
    text: (pageNumber) => `(Page ${pageNumber} sample text)`,
    object: () => "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  },
  type3: {
    object(add) {
      const square = add.stream("", "1000 0 0 0 750 750 d1 0 0 750 750 re f");
      const triangle = add.stream("", "1000 0 0 0 750 750 d1 0 0 m 750 0 l 375 750 l f");
      return "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 750 750] /FontMatrix [0.001 0 0 0.001 0 0] " +
        `/CharProcs << /A ${square} 0 R /B ${triangle} 0 R >> ` +
        "/Encoding << /Type /Encoding /Differences [65 /A /B] >> " +
        "/FirstChar 65 /LastChar 66 /Widths [1000 1000] /Resources << >> >>";
    },
  },
  cjk: {
    // "Nihongo", the word for the Japanese language, as UTF-16 code units for the UniJIS-UTF16-H CMap.
    text: () => "<65E5672C8A9E>",
    object(add) {
      const descriptor = add("<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 " +
        "/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>");
      const descendant = add("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /DW 1000 " +
        `/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor ${descriptor} 0 R >>`);
      return "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UTF16-H " +
        `/DescendantFonts [${descendant} 0 R] >>`;
    },
  },
};

function buildPdf({ pages, font = "standard", ownerPassword, userPassword }) {
  const objects = [];
  const encryption = ownerPassword === undefined ? undefined : standardEncryption(ownerPassword, userPassword);
  const add = (body) => objects.push(body) && objects.length;
  add.set = (id, body) => { objects[id - 1] = body; };
  // A stream is encrypted with a key made from its own object number.
  add.stream = (entries, content) => {
    const data = encryption === undefined ? content : encryption.encrypt(objects.length + 1, content);
    const dictionary = [entries, `/Length ${data.length}`].filter(Boolean).join(" ");
    return add(`<< ${dictionary} >>\nstream\n${data}\nendstream`);
  };
  const catalogId = add("");
  const pagesId = add("");
  const fontId = add("");
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
  pages.forEach((definition, index) => add.stream("", pageContent(definition, index + 1, fonts[font])));
  if (annotationsOnPage) {
    addAnnotation(add, "/Subtype /Widget /FT /Tx /T (field)", [100, 500, 200, 550], "0 1 0 rg");
    addAnnotation(add, "/Subtype /Square", [300, 500, 400, 550], "0 0 1 rg");
  }
  add.set(fontId, fonts[font].object(add));
  const encryptId = encryption && add(encryption.dictionary);
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
  const encrypt = encryption ? ` /Encrypt ${encryptId} 0 R /ID [${encryption.id} ${encryption.id}]` : "";
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R${encrypt} >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

/** Adds an annotation and its appearance stream, a solid block of the given color, as two consecutive objects. */
function addAnnotation(add, subtype, [left, bottom, right, top], color) {
  const width = right - left;
  const height = top - bottom;
  const annotationId = add("");
  const appearanceId = add.stream(`/Type /XObject /Subtype /Form /BBox [0 0 ${width} ${height}]`,
    `${color} 0 0 ${width} ${height} re f`);
  return add.set(annotationId, `<< /Type /Annot ${subtype} /Rect [${left} ${bottom} ${right} ${top}] /F 4 ` +
    `/AP << /N ${appearanceId} 0 R >> >>`);
}

function pageContent(definition, pageNumber, font) {
  const [left, , , top] = definition.crop ?? definition.media;
  const { x, y, width, height } = definition.ink;
  const bottom = top - y - height;
  if (definition.text !== undefined) {
    // The text is the page's ink: red, and sized so that glyphs three quarters of an em tall fill the ink's height.
    return `1 0 0 rg BT /F1 ${height / 0.75} Tf ${left + x} ${bottom} Td (${definition.text}) Tj ET`;
  }
  const textBaseline = top - y - height - 40;
  const filler = definition.filler ? `% ${"x".repeat(definition.filler)}\n` : "";
  return `${filler}1 0 0 rg ${left + x} ${bottom} ${width} ${height} re f\n` +
    `0 0 0 rg BT /F1 18 Tf ${left + x} ${textBaseline} Td ${font.text(pageNumber)} Tj ET` +
    (definition.denseText ? denseText(left, top) : "");
}

/** 3,000 short runs in the lower part of the page, far enough apart that pdf.js keeps each as its own text item. */
function denseText(left, top) {
  let content = "";
  for (let index = 0; index < 3_000; index++) {
    const x = left + 20 + (index % 30) * 19;
    const y = top - 330 - Math.floor(index / 30) * 4.5;
    content += `\nBT /F1 4 Tf ${x} ${y} Td (w${index}) Tj ET`;
  }
  return content;
}

/**
 * The standard security handler with 128-bit RC4 (revision 3), following algorithms 1, 2, 3 and 5 of ISO 32000-1. Only
 * streams are encrypted here, so an encrypted fixture can't have strings in its dictionaries.
 */
function standardEncryption(ownerPassword, userPassword) {
  const padding = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
  const pad = (password) => Buffer.concat([Buffer.from(password, "latin1"), padding]).subarray(0, 32);
  const md5 = (...parts) => createHash("md5").update(Buffer.concat(parts)).digest();
  const md5Repeated = (data) => Array.from({ length: 50 }).reduce((digest) => md5(digest), data);
  // Twenty passes, each with the key XORed with the pass number.
  const rc4Repeated = (key, data) =>
    Array.from({ length: 20 }).reduce((result, _, pass) => rc4(key.map((byte) => byte ^ pass), result), data);
  const id = Buffer.from("0123456789ABCDEF0123456789ABCDEF", "hex");
  const permissions = Buffer.from([0xfc, 0xff, 0xff, 0xff]);

  const owner = rc4Repeated(md5Repeated(md5(pad(ownerPassword))), pad(userPassword));
  const key = md5Repeated(md5(pad(userPassword), owner, permissions, id));
  const user = Buffer.concat([rc4Repeated(key, md5(padding, id)), Buffer.alloc(16)]);
  const hex = (bytes) => `<${bytes.toString("hex")}>`;
  return {
    id: hex(id),
    dictionary: `<< /Filter /Standard /V 2 /R 3 /Length 128 /O ${hex(owner)} /U ${hex(user)} /P -4 >>`,
    encrypt(objectNumber, content) {
      const number = Buffer.from([objectNumber & 0xff, (objectNumber >> 8) & 0xff, (objectNumber >> 16) & 0xff, 0, 0]);
      return rc4(md5(key, number), Buffer.from(content, "latin1")).toString("latin1");
    },
  };
}

function rc4(key, data) {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const output = Buffer.alloc(data.length);
  for (let index = 0, i = 0, j = 0; index < data.length; index++) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    output[index] = data[index] ^ state[(state[i] + state[j]) & 0xff];
  }
  return output;
}

const manifest = {};
for (const [name, fixture] of Object.entries(fixtures)) {
  const document = Array.isArray(fixture) ? { pages: fixture } : fixture;
  await writeFile(join(outputDirectory, `${name}.pdf`), buildPdf(document));
  manifest[name] = document.pages.map(({ ink: rect }) => rect);
}
await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
