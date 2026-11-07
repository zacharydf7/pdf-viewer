// Builds the viewer into dist/ and copies it to the Razor class library's static web assets.
import { build } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const webAssets = join(root, "..", "Pv.Blazor", "wwwroot");
const pdfJs = join(root, "node_modules", "pdfjs-dist");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "pdfjs"), { recursive: true });

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(dist, "pv.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
});
await cp(join(root, "src", "pv.css"), join(dist, "pv.css"));

// pdf.js files ship byte for byte. Scripting stays off, so its sandbox and QuickJS are left out.
for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  await cp(join(pdfJs, "build", file), join(dist, "pdfjs", file));
}
await cp(join(pdfJs, "LICENSE"), join(dist, "pdfjs", "LICENSE"));
for (const folder of ["cmaps", "iccs", "standard_fonts"]) {
  await cp(join(pdfJs, folder), join(dist, "pdfjs", folder), { recursive: true });
}
await mkdir(join(dist, "pdfjs", "wasm"));
for (const file of await readdir(join(pdfJs, "wasm"))) {
  if (!file.toLowerCase().includes("quickjs")) {
    await cp(join(pdfJs, "wasm", file), join(dist, "pdfjs", "wasm", file));
  }
}

await rm(webAssets, { recursive: true, force: true });
await cp(dist, webAssets, { recursive: true });
