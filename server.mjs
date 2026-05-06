import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const contentPath =
  process.env.MAGNOLIA_CONTENT_PATH ||
  path.join(rootDir, "data", "magnolia-content.json");
const maxJsonBytes = 1024 * 1024;

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

function sendJson(response, statusCode, payload) {
  send(response, statusCode, JSON.stringify(payload), {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
}

function resolveRequestPath(urlPathname) {
  const decodedPathname = decodeURIComponent(urlPathname);
  const pathname =
    decodedPathname === "/"
      ? "/index.html"
      : decodedPathname === "/venues"
        ? "/venues.html"
        : decodedPathname === "/bands"
          ? "/bands.html"
          : decodedPathname === "/manage"
            ? "/manage.html"
        : decodedPathname;
  const resolvedPath = path.resolve(rootDir, `.${pathname}`);

  if (!resolvedPath.startsWith(`${rootDir}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

async function readJsonBody(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > maxJsonBytes) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON request body.");
    error.status = 400;
    throw error;
  }
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }

  return normalizeText(value)
    .split(/\n|,/)
    .map(normalizeText)
    .filter(Boolean);
}

function slugify(value, fallback) {
  const slug = normalizeText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || fallback;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeVenue(venue, index = 0) {
  const name = normalizeText(venue?.name);

  return {
    id: normalizeText(venue?.id) || slugify(name, `venue-${index + 1}`),
    name,
    city: normalizeText(venue?.city),
    address: normalizeText(venue?.address),
    type: normalizeText(venue?.type),
    capacity: numberOrNull(venue?.capacity),
    founded: numberOrNull(venue?.founded),
    lat: numberOrNull(venue?.lat),
    lng: numberOrNull(venue?.lng),
    description: normalizeText(venue?.description),
    notable: splitList(venue?.notable),
    contactName: normalizeText(venue?.contactName),
    contactEmail: normalizeText(venue?.contactEmail),
    contactPhone: normalizeText(venue?.contactPhone),
    website: normalizeText(venue?.website),
    preferredGenres: splitList(venue?.preferredGenres),
    typicalNights: normalizeText(venue?.typicalNights),
    dealNotes: normalizeText(venue?.dealNotes),
    internalNotes: normalizeText(venue?.internalNotes),
    status: normalizeText(venue?.status) || "active"
  };
}

function normalizeBand(band, index = 0) {
  const name = normalizeText(band?.name);

  return {
    id: normalizeText(band?.id) || slugify(name, `band-${index + 1}`),
    name,
    hometown: normalizeText(band?.hometown),
    genres: splitList(band?.genres),
    bio: normalizeText(band?.bio),
    members: splitList(band?.members),
    contactName: normalizeText(band?.contactName),
    contactEmail: normalizeText(band?.contactEmail),
    contactPhone: normalizeText(band?.contactPhone),
    website: normalizeText(band?.website),
    musicUrl: normalizeText(band?.musicUrl),
    instagram: normalizeText(band?.instagram),
    draw: normalizeText(band?.draw),
    rate: normalizeText(band?.rate),
    availability: normalizeText(band?.availability),
    preferredMarkets: splitList(band?.preferredMarkets),
    venueHistory: splitList(band?.venueHistory),
    internalNotes: normalizeText(band?.internalNotes),
    status: normalizeText(band?.status) || "active"
  };
}

function normalizeContent(content) {
  return {
    updatedAt: new Date().toISOString(),
    venues: Array.isArray(content?.venues)
      ? content.venues.map(normalizeVenue).filter((venue) => venue.name)
      : [],
    bands: Array.isArray(content?.bands)
      ? content.bands.map(normalizeBand).filter((band) => band.name)
      : []
  };
}

async function loadDefaultContent() {
  const venueHtml = await readFile(path.join(rootDir, "venues.html"), "utf8");
  const match = venueHtml.match(/(?:const|let)\s+venues\s*=\s*(\[[\s\S]*?\n\]);/);
  const venues = match
    ? vm.runInNewContext(match[1], Object.create(null), { timeout: 1000 })
    : [];

  return normalizeContent({
    updatedAt: null,
    venues,
    bands: []
  });
}

async function readContent() {
  try {
    const payload = JSON.parse(await readFile(contentPath, "utf8"));
    return normalizeContent(payload);
  } catch {
    return loadDefaultContent();
  }
}

async function writeContent(content) {
  const normalized = normalizeContent(content);
  await mkdir(path.dirname(contentPath), { recursive: true });
  await writeFile(contentPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function assertAdmin(request) {
  const configuredToken = process.env.MAGNOLIA_ADMIN_TOKEN || "";

  if (!configuredToken && process.env.RAILWAY_ENVIRONMENT) {
    const error = new Error("Magnolia admin token is not configured.");
    error.status = 503;
    throw error;
  }

  if (!configuredToken) {
    return;
  }

  const authHeader = request.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const headerToken = request.headers["x-admin-token"] || "";

  if (bearerToken !== configuredToken && headerToken !== configuredToken) {
    const error = new Error("Admin key required.");
    error.status = 401;
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/content") {
      sendJson(response, 200, await readContent());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/content") {
      assertAdmin(request);
      const body = await readJsonBody(request);
      sendJson(response, 200, await writeContent(body));
      return;
    }
  } catch (error) {
    sendJson(response, error.status || 500, {
      error: {
        message: error.message || "Request failed."
      }
    });
    return;
  }

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
    const fileBody = await readFile(filePath);
    const body = request.method === "HEAD" ? "" : fileBody;
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
