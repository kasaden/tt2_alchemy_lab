// Tiny static server for local use: the page loads ES modules, a worker and the CSV files,
// none of which work from file://. Any other static server does the job as well.
// Usage: node server.js   (PORT=8080 node server.js for another port)

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5199);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml"
};

http
  .createServer(async (request, response) => {
    const { pathname } = new URL(request.url, `http://${HOST}`);
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).slice(1);
    const file = path.resolve(ROOT, relative);

    // stay inside the project, and keep node_modules and dotfiles out of reach
    const inside = file.startsWith(ROOT + path.sep);
    const hidden = relative.split("/").some((part) => part.startsWith(".") || part === "node_modules");

    try {
      if (!inside || hidden) throw new Error("forbidden");
      const body = await fs.readFile(file);
      response.writeHead(200, {
        "content-type": MIME[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Alchemy optimizer on http://${HOST}:${PORT}/`);
  });
