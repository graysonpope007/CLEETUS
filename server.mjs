import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".yml": "text/yaml; charset=utf-8"
};

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": statusCode === 200 ? "public, max-age=300" : "no-store",
    ...headers
  });
  response.end(body);
}

function resolveRequestPath(urlPathname) {
  const decodedPathname = decodeURIComponent(urlPathname);
  const pathname =
    decodedPathname === "/"
      ? "/index.html"
      : decodedPathname === "/venues"
        ? "/venues.html"
        : decodedPathname;
  const resolvedPath = path.resolve(rootDir, `.${pathname}`);

  if (!resolvedPath.startsWith(`${rootDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method not allowed", {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8"
    });
    return;
  }

  if (url.pathname === "/health") {
    send(response, 200, JSON.stringify({ ok: true }), {
      "Content-Type": "application/json; charset=utf-8"
    });
    return;
  }

  const filePath = resolveRequestPath(url.pathname);

  if (!filePath) {
    send(response, 403, "Forbidden", {
      "Content-Type": "text/plain; charset=utf-8"
    });
    return;
  }

  try {
    const body = request.method === "HEAD" ? "" : await readFile(filePath);
    const contentType =
      mimeTypes[path.extname(filePath).toLowerCase()] ||
      "application/octet-stream";

    send(response, 200, body, {
      "Content-Type": contentType
    });
  } catch {
    send(response, 404, "Not found", {
      "Content-Type": "text/plain; charset=utf-8"
    });
  }
});

server.listen(port, host, () => {
  console.log(`Magnolia Booking site running at http://${host}:${port}`);
});
