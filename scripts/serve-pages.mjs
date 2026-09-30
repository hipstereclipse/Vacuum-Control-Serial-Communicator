import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const output = path.resolve("dist", "client");
const repositoryName =
  (process.env.GITHUB_REPOSITORY ?? "").split("/")[1] ||
  "Vacuum-Control-Serial-Communicator";
const basePath = `/${repositoryName}`;
const port = Number(process.env.PAGES_PREVIEW_PORT ?? 4173);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".rsc": "text/x-component; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === basePath) {
      response.writeHead(308, { location: `${basePath}/` });
      response.end();
      return;
    }
    if (!url.pathname.startsWith(`${basePath}/`)) {
      response.writeHead(404).end("Not found");
      return;
    }

    const relativePath =
      decodeURIComponent(url.pathname.slice(basePath.length + 1)) || "index.html";
    const filePath = path.resolve(output, relativePath);
    if (!filePath.startsWith(`${output}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const file = await stat(filePath);
    if (!file.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream"
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`GitHub Pages preview: http://127.0.0.1:${port}${basePath}/`);
});
