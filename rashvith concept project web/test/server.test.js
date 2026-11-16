const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, test } = require("node:test");
const { createAppServer } = require("../server");

let server;
let dataDirectory;
let dataFile;
let baseUrl;
let locationLookupCount;

beforeEach(async () => {
  locationLookupCount = 0;
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "fixmaduva-test-"));
  dataFile = path.join(dataDirectory, "reports.json");
  server = createAppServer({
    dataFile,
    fetchImpl: async (url) => {
      assert.match(String(url), /^https:\/\/nominatim\.openstreetmap\.org\/reverse/);
      locationLookupCount += 1;
      return {
        ok: true,
        json: async () => ({
          display_name: "Indiranagar, Bengaluru, Karnataka, India",
          address: {
            road: "100 Feet Road",
            suburb: "Indiranagar",
            ward: "150",
            city_district: "Bengaluru Central City Corporation",
            state_district: "Bengaluru Urban",
            state: "Karnataka",
            postcode: "560038",
          },
        }),
      };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

async function postReport(overrides = {}) {
  return fetch(`${baseUrl}/api/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Blocked footpath",
      details: "Near the bus stop",
      area: "Indiranagar",
      type: "Road",
      lat: 12.9784,
      lng: 77.6408,
      ...overrides,
    }),
  });
}

test("serves the FixMaduva website and reports a healthy API", async () => {
  const [page, health] = await Promise.all([
    fetch(baseUrl),
    fetch(`${baseUrl}/api/health`),
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /FixMaduva/);
  assert.deepEqual(await health.json(), { ok: true, app: "FixMaduva" });
});

test("starts with honest empty stats and persists a valid community report", async () => {
  const before = await fetch(`${baseUrl}/api/stats`);
  assert.deepEqual(await before.json(), { reports: 0, areas: 0, supports: 0 });

  const created = await postReport();
  assert.equal(created.status, 201);
  const { issue } = await created.json();
  assert.equal(issue.title, "Blocked footpath");
  assert.equal(issue.status, "open");
  assert.equal(issue.support, 0);

  const listed = await fetch(`${baseUrl}/api/issues`);
  const { issues } = await listed.json();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, issue.id);
  assert.equal(issues[0].lat, 12.9784);
});

test("stores, serves, and shares an attached report photo", async () => {
  const image = await fs.readFile(path.join(__dirname, "..", "assets", "fixmaduva-logo.jpg"));
  const created = await postReport({
    title: "Photo attached report",
    details: "This issue has a public photo.",
    image: { mimeType: "image/jpeg", data: image.toString("base64") },
  });
  assert.equal(created.status, 201);
  const { issue } = await created.json();
  assert.match(issue.imageUrl, /^\/uploads\/[0-9a-f-]{36}\.jpg$/);

  const photoResponse = await fetch(`${baseUrl}${issue.imageUrl}`);
  assert.equal(photoResponse.status, 200);
  assert.equal(photoResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await photoResponse.arrayBuffer()), image);

  const listed = await fetch(`${baseUrl}/api/issues`);
  assert.equal((await listed.json()).issues[0].imageUrl, issue.imageUrl);
  const deepLink = await fetch(`${baseUrl}/track/${issue.trackingCode}`);
  const html = await deepLink.text();
  assert.match(html, /og:title" content="FixMaduva: Photo attached report"/);
  assert.match(html, new RegExp(`og:image" content="http://127\\.0\\.0\\.1:[0-9]+${issue.imageUrl.replaceAll("/", "\\/")}"`));
});

test("rejects unsupported, invalid, and oversized report photos", async () => {
  const unsupported = await postReport({ image: { mimeType: "image/png", data: "AAAA" } });
  assert.equal(unsupported.status, 400);

  const invalid = await postReport({ image: { mimeType: "image/jpeg", data: Buffer.from("not a photo").toString("base64") } });
  assert.equal(invalid.status, 400);

  const oversizedData = Buffer.alloc(1_500_001);
  oversizedData.set([0xff, 0xd8], 0);
  oversizedData.set([0xff, 0xd9], oversizedData.length - 2);
  const oversized = await postReport({ image: { mimeType: "image/jpeg", data: oversizedData.toString("base64") } });
  assert.equal(oversized.status, 413);
});

test("tracks a report by shareable code and serves its direct tracking link", async () => {
  const created = await postReport();
  const { issue } = await created.json();
  assert.match(issue.trackingCode, /^FM-[0-9A-F]{12}$/);
  assert.equal(issue.statusHistory.length, 1);
  assert.equal(issue.statusHistory[0].status, "open");

  const tracked = await fetch(`${baseUrl}/api/issues/${issue.trackingCode}`);
  assert.equal(tracked.status, 200);
  assert.equal((await tracked.json()).issue.id, issue.id);

  const deepLink = await fetch(`${baseUrl}/track/${issue.trackingCode}`);
  assert.equal(deepLink.status, 200);
  const deepLinkHtml = await deepLink.text();
  assert.match(deepLinkHtml, /trackingForm/);
  assert.match(deepLinkHtml, /href="\/styles\.css"/);
  assert.match(deepLinkHtml, /src="\/app\.js"/);
  assert.match(deepLinkHtml, /<title>FixMaduva: Blocked footpath<\/title>/);
  assert.match(deepLinkHtml, /og:title" content="FixMaduva: Blocked footpath"/);

  const notFound = await fetch(`${baseUrl}/api/issues/FM-000000000000`);
  assert.equal(notFound.status, 404);
});

test("adds authenticated status updates to the public report timeline", async () => {
  const created = await postReport();
  const { issue } = await created.json();
  const previousToken = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  const disabled = await fetch(`${baseUrl}/api/admin/issues/${issue.id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "in_progress", note: "Assigned to the sanitation team." }),
  });
  assert.equal(disabled.status, 503);

  process.env.ADMIN_TOKEN = "test-admin-token";
  try {
    const unauthorized = await fetch(`${baseUrl}/api/admin/issues/${issue.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
      body: JSON.stringify({ status: "in_progress", note: "Assigned to the sanitation team." }),
    });
    assert.equal(unauthorized.status, 401);

    const updated = await fetch(`${baseUrl}/api/admin/issues/${issue.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ status: "in_progress", note: "Assigned to the sanitation team." }),
    });
    assert.equal(updated.status, 200);
    const { issue: updatedIssue } = await updated.json();
    assert.equal(updatedIssue.status, "in_progress");
    assert.equal(updatedIssue.statusHistory.length, 2);

    const duplicate = await fetch(`${baseUrl}/api/admin/issues/${issue.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-admin-token" },
      body: JSON.stringify({ status: "in_progress", note: "Duplicate update." }),
    });
    assert.equal(duplicate.status, 409);

    const tracked = await fetch(`${baseUrl}/api/issues/${issue.trackingCode}`);
    assert.equal((await tracked.json()).issue.statusHistory[1].note, "Assigned to the sanitation team.");
  } finally {
    if (previousToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousToken;
  }
});

test("resolves report coordinates to OSM labels and the best-match current MLA", async () => {
  const created = await postReport();
  const { issue } = await created.json();
  const response = await fetch(`${baseUrl}/api/locations/${issue.id}?lat=${issue.lat}&lng=${issue.lng}`);
  assert.equal(response.status, 200);
  const { location } = await response.json();
  assert.equal(location.road, "100 Feet Road");
  assert.equal(location.neighbourhood, "Indiranagar");
  assert.equal(location.ward, "150");
  assert.equal(location.municipality, "Bengaluru Central City Corporation");
  assert.equal(location.assemblyConstituency, "");
  assert.equal(location.source, "OpenStreetMap Nominatim");
  assert.deepEqual({
    constituency: location.representative.constituency,
    constituencyNumber: location.representative.constituencyNumber,
    mla: location.representative.mla,
    party: location.representative.party,
  }, {
    constituency: "C.V Raman Nagar",
    constituencyNumber: 161,
    mla: "S Raghu",
    party: "BHARATIYA JANATA PARTY (BJP)",
  });
  assert.match(location.representative.source, /kla\.kar\.nic\.in/);
  assert.match(location.representative.boundarySource, /datameet\/maps/);
  assert.match(location.representative.boundaryCaveat, /verify/i);
  await fetch(`${baseUrl}/api/locations/${issue.id}?lat=${issue.lat}&lng=${issue.lng}`);
  assert.equal(locationLookupCount, 1, "rounded coordinate lookups should use the location cache");

  const firstBoundarySide = await fetch(`${baseUrl}/api/locations/${issue.id}?lat=13.196774994&lng=77.203209661`);
  const firstBoundaryRepresentative = (await firstBoundarySide.json()).location.representative;
  const secondBoundarySide = await fetch(`${baseUrl}/api/locations/${issue.id}?lat=13.196755006&lng=77.203210339`);
  const secondBoundaryRepresentative = (await secondBoundarySide.json()).location.representative;
  assert.equal(firstBoundaryRepresentative.constituencyNumber, 181);
  assert.equal(secondBoundaryRepresentative.constituencyNumber, 133);
  assert.equal(locationLookupCount, 2, "nearby points may reuse address labels while retaining exact MLA lookup");

  const outsideBengaluru = await fetch(`${baseUrl}/api/locations/${issue.id}?lat=19.076&lng=72.8777`);
  assert.equal(outsideBengaluru.status, 400);
});

test("keeps reports after the server restarts", async () => {
  const created = await postReport();
  const { issue } = await created.json();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  server = createAppServer({ dataFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/issues`);
  const { issues } = await response.json();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, issue.id);
});

test("validates report content and Bengaluru coordinates", async () => {
  const badTitle = await postReport({ title: "No" });
  assert.equal(badTitle.status, 400);
  assert.match((await badTitle.json()).error, /Title/);

  const outsideBengaluru = await postReport({ lat: 19.076, lng: 72.8777 });
  assert.equal(outsideBengaluru.status, 400);
  assert.match((await outsideBengaluru.json()).error, /Bengaluru/);

  const badArea = await postReport({ area: "Not a real area" });
  assert.equal(badArea.status, 400);

  const nonObject = await postReportArray();
  assert.equal(nonObject.status, 400);
});

async function postReportArray() {
  return fetch(`${baseUrl}/api/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "[]",
  });
}

test("supports a report once per browser ID and allows removal", async () => {
  const created = await postReport();
  const { issue } = await created.json();
  const voterId = "6a671e4e-3c72-44e4-b731-541ed8c92b83";
  const url = `${baseUrl}/api/issues/${issue.id}/support`;

  const supported = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voterId }),
  });
  assert.equal(supported.status, 200);
  assert.deepEqual((await supported.json()).issue.supported, true);

  const listed = await fetch(`${baseUrl}/api/issues?voterId=${voterId}`);
  const { issues } = await listed.json();
  assert.equal(issues[0].support, 1);
  assert.equal(issues[0].supported, true);

  const removed = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voterId }),
  });
  assert.deepEqual((await removed.json()).issue.supported, false);
});

test("filters public reports by text and area", async () => {
  await postReport();
  await postReport({ title: "Overflowing public bin", area: "Jayanagar", type: "Waste" });

  const response = await fetch(`${baseUrl}/api/issues?area=Jayanagar&q=bin`);
  const { issues } = await response.json();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, "Overflowing public bin");
});

test("applies the report rate limit even when submissions arrive together", async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    postReport({ title: `Footpath issue ${index + 1}` }),
  ));
  assert.equal(results.filter((response) => response.status === 201).length, 5);
  assert.equal(results.filter((response) => response.status === 429).length, 1);
});
