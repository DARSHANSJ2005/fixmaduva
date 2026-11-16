const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");

const ROOT = __dirname;
const DEFAULT_DATA_FILE = path.join(ROOT, "data", "reports.json");
const ASSEMBLY_BOUNDARIES_FILE = path.join(ROOT, "data", "bengaluru-assembly-mlas.geojson");
const MAX_IMAGE_BYTES = 1_500_000;
const AREAS = new Set([
  "Indiranagar", "Jayanagar", "Koramangala", "MG Road", "Domlur",
  "Whitefield", "HSR Layout", "Malleshwaram", "Rajajinagar",
  "Basavanagudi", "Other Bengaluru",
]);
const TYPES = new Set(["Waste", "Road", "Water", "Street", "Other"]);
const MAX_BODY_BYTES = 2_100_000;
const CREATE_LIMIT = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const REPORT_STATUSES = new Set(["open", "in_progress", "resolved"]);
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const LOCATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/assets/fixmaduva-logo.jpg", ["assets/fixmaduva-logo.jpg", "image/jpeg"]],
]);

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

async function readReports(dataFile) {
  try {
    const data = await fs.readFile(dataFile, "utf8");
    const reports = JSON.parse(data);
    if (!Array.isArray(reports)) throw new Error("Report data must be an array.");
    return reports;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeReports(dataFile, reports) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(reports, null, 2), { mode: 0o600 });
  await fs.rename(temporaryFile, dataFile);
}

function publicReport(report, voterId) {
  const { voterIds, ...visible } = report;
  const history = visible.statusHistory || [{
    status: visible.status || "open",
    note: "Report added to the community tracker.",
    createdAt: visible.createdAt,
  }];
  return {
    ...visible,
    trackingCode: visible.trackingCode || `FM-${visible.id.replaceAll("-", "").slice(0, 12).toUpperCase()}`,
    statusHistory: history,
    support: voterIds.length,
    supported: voterIds.includes(voterId),
  };
}

function validAdminToken(token, expected) {
  if (!expected || !token) return false;
  const provided = Buffer.from(token);
  const configured = Buffer.from(expected);
  return provided.length === configured.length && timingSafeEqual(provided, configured);
}

function trackingCode() {
  return `FM-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function reportImage(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || value.mimeType !== "image/jpeg" || typeof value.data !== "string") {
    throw Object.assign(new Error("Upload a JPG, PNG, or WebP image."), { status: 400 });
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) {
    throw Object.assign(new Error("The uploaded image data is invalid."), { status: 400 });
  }
  const data = Buffer.from(value.data, "base64");
  if (data.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("The optimized image must be 1.5 MB or smaller."), { status: 413 });
  }
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
    throw Object.assign(new Error("The uploaded photo could not be read as a JPEG image."), { status: 400 });
  }
  return data;
}

function validVoterId(value) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [currentLng, currentLat] = ring[index];
    const [previousLng, previousLat] = ring[previous];
    const crossesLatitude = (currentLat > lat) !== (previousLat > lat);
    if (crossesLatitude && lng < ((previousLng - currentLng) * (lat - currentLat)) / (previousLat - currentLat) + currentLng) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(lng, lat, rings) {
  return rings.length > 0
    && pointInRing(lng, lat, rings[0])
    && !rings.slice(1).some((ring) => pointInRing(lng, lat, ring));
}

function representativeAt(lng, lat, collection) {
  for (const feature of collection.features) {
    const { properties, geometry } = feature;
    if (geometry.type !== "MultiPolygon") continue;
    if (!geometry.coordinates.some((polygon) => pointInPolygon(lng, lat, polygon))) continue;
    return {
      constituency: properties.constituency,
      constituencyNumber: properties.acNo,
      mla: properties.mla,
      party: properties.party,
      source: properties.mlaSource,
      rosterLastModified: properties.mlaRosterLastModified,
      rosterCheckedAt: properties.mlaRosterCheckedAt,
      boundarySource: properties.boundarySource,
      boundaryLicense: properties.boundaryLicense,
      boundaryCaveat: properties.boundaryCaveat,
    };
  }
  return null;
}

function createAppServer({ dataFile = DEFAULT_DATA_FILE, fetchImpl = fetch } = {}) {
  const uploadsDirectory = path.join(path.dirname(dataFile), "uploads");
  const reportAttempts = new Map();
  const locationCache = new Map();
  let nextNominatimRequestAt = 0;
  let nominatimQueue = Promise.resolve();
  let writeQueue = Promise.resolve();
  let assemblyDataPromise;

  async function lookupRepresentative(lng, lat) {
    assemblyDataPromise ||= fs.readFile(ASSEMBLY_BOUNDARIES_FILE, "utf8").then((data) => JSON.parse(data));
    const collection = await assemblyDataPromise;
    return representativeAt(lng, lat, collection);
  }

  function updateReports(update) {
    const operation = writeQueue.then(async () => {
      const reports = await readReports(dataFile);
      const result = await update(reports);
      await writeReports(dataFile, reports);
      return result;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function lookupLocation(lat, lng) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const cached = locationCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, representative: await lookupRepresentative(lng, lat) };
    }

    const operation = nominatimQueue.then(async () => {
      const delay = Math.max(0, nextNominatimRequestAt - Date.now());
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      nextNominatimRequestAt = Date.now() + 1100;

      const lookupUrl = new URL(NOMINATIM_URL);
      lookupUrl.search = new URLSearchParams({
        lat: String(lat),
        lon: String(lng),
        format: "jsonv2",
        addressdetails: "1",
        zoom: "18",
      });
      const response = await fetchImpl(lookupUrl, {
        headers: {
          "User-Agent": "FixMaduva/1.0 (+community location and report tracking)",
          "Accept-Language": "en",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const error = new Error(response.status === 429
          ? "Location search is busy. Please try again in a minute."
          : "Nearby location details are temporarily unavailable.");
        error.status = response.status === 429 ? 503 : 502;
        throw error;
      }
      const result = await response.json();
      const address = result.address || {};
      const value = {
        displayName: result.display_name || "",
        road: address.road || address.pedestrian || address.footway || "",
        neighbourhood: address.neighbourhood || address.quarter || address.suburb || "",
        ward: address.ward || "",
        municipality: address.city_district || address.municipality || address.city || "",
        district: address.state_district || address.county || "",
        state: address.state || "",
        postcode: address.postcode || "",
        assemblyConstituency: address.constituency || "",
        source: "OpenStreetMap Nominatim",
      };
      locationCache.set(key, { value, expiresAt: Date.now() + LOCATION_CACHE_TTL_MS });
      return { ...value, representative: await lookupRepresentative(lng, lat) };
    });
    nominatimQueue = operation.catch(() => {});
    return operation;
  }

  async function serve(request, response) {
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      json(response, 400, { error: "Invalid request URL." });
      return;
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      json(response, 200, { ok: true, app: "FixMaduva" });
      return;
    }

    const uploadMatch = url.pathname.match(/^\/uploads\/([0-9a-f-]{36}\.jpg)$/i);
    if (uploadMatch && request.method === "GET") {
      try {
        const image = await fs.readFile(path.join(uploadsDirectory, uploadMatch[1]));
        response.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(image);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        json(response, 404, { error: "Report image not found." });
      }
      return;
    }

    if (url.pathname === "/api/issues" && request.method === "GET") {
      const voterId = url.searchParams.get("voterId") || "";
      const reports = await readReports(dataFile);
      const area = url.searchParams.get("area");
      const type = url.searchParams.get("type");
      const status = url.searchParams.get("status");
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      const filtered = reports.filter((report) =>
        (!area || report.area === area)
        && (!type || report.type === type)
        && (!status || report.status === status)
        && (!query || `${report.title} ${report.details} ${report.area} ${report.type}`.toLowerCase().includes(query)),
      );
      json(response, 200, { issues: filtered.map((report) => publicReport(report, voterId)) });
      return;
    }

    if (url.pathname === "/api/stats" && request.method === "GET") {
      const reports = await readReports(dataFile);
      json(response, 200, {
        reports: reports.length,
        areas: new Set(reports.map((report) => report.area)).size,
        supports: reports.reduce((total, report) => total + report.voterIds.length, 0),
      });
      return;
    }

    const locationMatch = url.pathname.match(/^\/api\/locations\/[0-9a-f-]{36}$/i);
    if (locationMatch && request.method === "GET") {
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 12.6 || lat > 13.25 || lng < 77.2 || lng > 78.0) {
        json(response, 400, { error: "Choose a valid report location in Bengaluru." });
        return;
      }
      try {
        const location = await lookupLocation(lat, lng);
        json(response, 200, { location });
      } catch (error) {
        json(response, error.status || 502, { error: error.status ? error.message : "Could not look up nearby location details." });
      }
      return;
    }

    const reportMatch = url.pathname.match(/^\/api\/issues\/([0-9a-f-]{36}|FM-[0-9A-F]{12})$/i);
    if (reportMatch && request.method === "GET") {
      const reports = await readReports(dataFile);
      const key = reportMatch[1].toLowerCase();
      const report = reports.find((item) =>
        item.id.toLowerCase() === key || publicReport(item, "").trackingCode.toLowerCase() === key,
      );
      if (!report) {
        json(response, 404, { error: "We couldn't find a report with that tracking code." });
        return;
      }
      const voterId = url.searchParams.get("voterId") || "";
      json(response, 200, { issue: publicReport(report, voterId) });
      return;
    }

    if (url.pathname === "/api/issues" && request.method === "POST") {
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(response, 400, { error: "Request body must be a JSON object." });
        return;
      }
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const details = typeof body.details === "string" ? body.details.trim() : "";
      const imageData = reportImage(body.image);
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (title.length < 5 || title.length > 100) {
        json(response, 400, { error: "Title must be between 5 and 100 characters." });
        return;
      }
      if (!AREAS.has(body.area) || !TYPES.has(body.type)) {
        json(response, 400, { error: "Choose a valid Bengaluru area and issue type." });
        return;
      }
      if (details.length > 500) {
        json(response, 400, { error: "Details must be 500 characters or fewer." });
        return;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 12.6 || lat > 13.25 || lng < 77.2 || lng > 78.0) {
        json(response, 400, { error: "Choose a valid report location in Bengaluru on the map." });
        return;
      }

      const now = Date.now();
      const client = request.socket.remoteAddress || "unknown";
      const attempts = (reportAttempts.get(client) || []).filter((time) => now - time < RATE_WINDOW_MS);
      if (attempts.length >= CREATE_LIMIT) {
        json(response, 429, { error: "Too many reports from this connection. Please try again later." });
        return;
      }
      attempts.push(now);
      reportAttempts.set(client, attempts);

      const imageFilename = imageData ? `${randomUUID()}.jpg` : "";
      if (imageData) {
        await fs.mkdir(uploadsDirectory, { recursive: true });
        await fs.writeFile(path.join(uploadsDirectory, imageFilename), imageData, { flag: "wx", mode: 0o644 });
      }
      let report;
      try {
        report = await updateReports((reports) => {
          let code = trackingCode();
          while (reports.some((item) => item.trackingCode === code)) code = trackingCode();
          const createdAt = new Date().toISOString();
          const newReport = {
            id: randomUUID(),
            trackingCode: code,
            title,
            details,
            area: body.area,
            type: body.type,
            lat,
            lng,
            ...(imageFilename ? { imageUrl: `/uploads/${imageFilename}` } : {}),
            status: "open",
            createdAt,
            statusHistory: [{
              status: "open",
              note: "Your report was received by the FixMaduva community tracker. It has not been sent to a government office.",
              createdAt,
            }],
            voterIds: [],
          };
          reports.unshift(newReport);
          return newReport;
        });
      } catch (error) {
        if (imageFilename) {
          await fs.unlink(path.join(uploadsDirectory, imageFilename)).catch((cleanupError) => {
            console.error("Could not remove an image after report creation failed.", cleanupError);
          });
        }
        throw error;
      }
      json(response, 201, { issue: publicReport(report, "") });
      return;
    }

    const statusMatch = url.pathname.match(/^\/api\/admin\/issues\/([0-9a-f-]{36})\/status$/i);
    if (statusMatch && request.method === "PATCH") {
      if (!validAdminToken(request.headers.authorization?.replace(/^Bearer\s+/i, ""), process.env.ADMIN_TOKEN)) {
        json(response, process.env.ADMIN_TOKEN ? 401 : 503, {
          error: process.env.ADMIN_TOKEN ? "A valid admin token is required." : "Report status updates are disabled until ADMIN_TOKEN is configured.",
        });
        return;
      }
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(response, 400, { error: "Request body must be a JSON object." });
        return;
      }
      if (!REPORT_STATUSES.has(body.status)) {
        json(response, 400, { error: "Status must be open, in_progress, or resolved." });
        return;
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (!note || note.length > 500) {
        json(response, 400, { error: "Status update note must be between 1 and 500 characters." });
        return;
      }
      const updatedReport = await updateReports((reports) => {
        const found = reports.find((item) => item.id === statusMatch[1]);
        if (!found) return null;
        found.statusHistory ||= [{
          status: found.status || "open",
          note: "Report added to the community tracker.",
          createdAt: found.createdAt,
        }];
        if (found.status === body.status) return { conflict: true };
        found.status = body.status;
        found.statusHistory.push({
          status: body.status,
          note,
          createdAt: new Date().toISOString(),
        });
        return found;
      });
      if (!updatedReport) {
        json(response, 404, { error: "Report not found." });
        return;
      }
      if (updatedReport.conflict) {
        json(response, 409, { error: "The report already has that status." });
        return;
      }
      json(response, 200, { issue: publicReport(updatedReport, "") });
      return;
    }

    const supportMatch = url.pathname.match(/^\/api\/issues\/([0-9a-f-]+)\/support$/i);
    if (supportMatch && request.method === "POST") {
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(response, 400, { error: "Request body must be a JSON object." });
        return;
      }
      if (!validVoterId(body.voterId)) {
        json(response, 400, { error: "A valid browser voter ID is required." });
        return;
      }
      const report = await updateReports((reports) => {
        const found = reports.find((item) => item.id === supportMatch[1]);
        if (!found) return null;
        const voterIndex = found.voterIds.indexOf(body.voterId);
        if (voterIndex === -1) found.voterIds.push(body.voterId);
        else found.voterIds.splice(voterIndex, 1);
        return found;
      });
      if (!report) {
        json(response, 404, { error: "Report not found." });
        return;
      }
      json(response, 200, { issue: publicReport(report, body.voterId) });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "API endpoint not found." });
      return;
    }

    const trackPage = /^\/track\/(?:FM-[0-9A-F]{12}|[0-9a-f-]{36})$/i.test(url.pathname);
    if (trackPage && request.method === "GET") {
      const code = decodeURIComponent(url.pathname.slice("/track/".length)).toUpperCase();
      const reports = await readReports(dataFile);
      const issue = reports.find((report) => publicReport(report, "").trackingCode.toUpperCase() === code);
      let html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
      if (issue) {
        const baseUrl = new URL(process.env.PUBLIC_BASE_URL || `http://${request.headers.host || "localhost"}`);
        const reportUrl = new URL(`/track/${encodeURIComponent(code)}`, baseUrl).href;
        const imageUrl = new URL(issue.imageUrl || "/assets/fixmaduva-logo.jpg", baseUrl).href;
        const status = ({ open: "Open", in_progress: "In progress", resolved: "Resolved" })[issue.status] || "Updated";
        const description = `${issue.area} · ${status} · Reference ${code}${issue.details ? ` · ${issue.details}` : ""}`;
        const metadata = [
          `<meta property="og:type" content="article" />`,
          `<meta property="og:title" content="${escapeHtml(`FixMaduva: ${issue.title}`)}" />`,
          `<meta property="og:description" content="${escapeHtml(description)}" />`,
          `<meta property="og:url" content="${escapeHtml(reportUrl)}" />`,
          `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`,
          `<meta property="og:image:alt" content="${escapeHtml(`Photo for FixMaduva report: ${issue.title}`)}" />`,
          `<meta name="twitter:card" content="summary_large_image" />`,
        ].join("\n    ");
        html = html.replace(
          /<title>[\s\S]*?<\/title>/,
          `<title>${escapeHtml(`FixMaduva: ${issue.title}`)}</title>`,
        ).replace("</head>", `    ${metadata}\n  </head>`);
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
      response.end(html);
      return;
    }

    const staticFile = STATIC_FILES.get(url.pathname) || (trackPage ? ["index.html", "text/html; charset=utf-8"] : null);
    if (staticFile && request.method === "GET") {
      const [filename, contentType] = staticFile;
      const content = await fs.readFile(path.join(ROOT, filename));
      response.writeHead(200, {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
      response.end(content);
      return;
    }
    json(response, 404, { error: "Page not found." });
  }

  return http.createServer((request, response) => {
    serve(request, response).catch((error) => {
      if (!response.headersSent) {
        const status = error.status || 500;
        json(response, status, { error: status === 500 ? "The server could not complete the request." : error.message });
      } else {
        response.destroy(error);
      }
      if (!error.status) console.error("Request failed:", error);
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  createAppServer().listen(port, host, () => {
    console.log(`FixMaduva running at http://${host}:${port}`);
  });
}

module.exports = { createAppServer };
