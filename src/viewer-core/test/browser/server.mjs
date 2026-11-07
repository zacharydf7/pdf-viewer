// Static file server for browser tests, rooted at the repository. It supports range requests, as pdf.js expects.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repositoryRoot = join(packageRoot, "..", "..");
const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".pdf": "application/pdf", ".wasm": "application/wasm", ".json": "application/json" };

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, "http://localhost");
  const decoded = normalize(decodeURIComponent(pathname));
  const path = decoded.includes(`${join("tests", "fixtures")}`) ? join(repositoryRoot, decoded) : join(packageRoot, decoded);
  let info;
  try {
    info = await stat(path);
  } catch {
    response.writeHead(404).end();
    return;
  }
  const headers = { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream", "Accept-Ranges": "bytes" };
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (range === null) {
    response.writeHead(200, { ...headers, "Content-Length": info.size });
    createReadStream(path).pipe(response);
    return;
  }
  const start = Number(range[1]);
  const end = range[2] === "" ? info.size - 1 : Math.min(Number(range[2]), info.size - 1);
  response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}` });
  createReadStream(path, { start, end }).pipe(response);
}).listen(Number(process.argv[2]), "127.0.0.1");
