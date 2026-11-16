# FixMaduva

FixMaduva is a small full-stack Bengaluru neighbourhood issue-reporting app. It uses a dependency-free Node.js API, a browser interface, and persistent JSON storage.

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Do not open `index.html` directly: report creation, tracking, and community support require the Node.js API. Shared `/track/<reference>` links are served by the same app. Reports are stored in `data/reports.json`, created on the first successful submission. Run `npm test` for API tests.

## Photos and sharing

Reports may include one JPG, PNG, or WebP photo up to 10 MB before processing. The browser resizes it and converts it to JPEG; the server accepts only validated JPEG data up to 1.5 MB and stores it in `data/uploads/`. Report photos and reports are public. Include only images you have the right to share and avoid faces, private details, or sensitive information. Back up `data/uploads/` together with `data/reports.json`.

Use **Share** to open the device's native share sheet where supported, or copy a tracker link. **WhatsApp** opens a prefilled message with the report title, area, current status, reference, and tracker URL. The tracker page includes social preview metadata, including the uploaded report image when present. Set `PUBLIC_BASE_URL` to the canonical HTTPS origin when deploying behind a proxy or using a public domain so shared preview URLs resolve correctly.

The supplied FixMaduva logo is used in the header and footer. A low-contrast blue grid provides a civic-planning backdrop while keeping report cards and the map clear.

## Open data and attribution

- The basemap and place labels are supplied by [OpenStreetMap](https://www.openstreetmap.org/copyright), whose data is available under the [ODbL](https://opendatacommons.org/licenses/odbl/). The map displays the required attribution. The site uses the standard OpenStreetMap tile endpoint and should be moved to a suitable hosted tile provider if traffic grows; the community tile service is best-effort and does not provide an SLA.
- Pinned-report address labels use the public [Nominatim reverse-geocoding API](https://nominatim.org/release-docs/latest/api/Reverse/) and are cached in memory for 24 hours. Coordinates are sent to OpenStreetMap's Nominatim service when someone opens a report tracker. Nominatim reverse geocoding returns the nearest suitable mapped object, not a guaranteed parcel or boundary match; its public service has a strict usage policy.
- No city complaint, ward-boundary, or official resolution dataset is bundled. Reports shown in FixMaduva are submitted by users and must not be interpreted as verified BBMP/GBA records. The app starts empty rather than showing fabricated example reports.
- Report tracking uses a bundled Bengaluru-area assembly-constituency boundary subset from the [DataMeet Maps project](https://github.com/datameet/maps/tree/master/assembly-constituencies), licensed [CC BY 2.5 India](https://creativecommons.org/licenses/by/2.5/in/). It joins constituency numbers to the current member list published by the [Karnataka Legislative Assembly](https://kla.kar.nic.in/assembly/member/16assemblymemberslist.htm). The dataset includes source and roster-modification metadata; its attribution is shown in the tracker.
- A pinned point inside a bundled polygon displays a **likely MLA** and constituency. DataMeet warns that its community-digitized boundaries can have shifts or missing/misnamed constituencies, so this is a best-effort match, not an official boundary determination. Residents should verify with the [Karnataka Chief Electoral Officer](https://ceo.karnataka.gov.in/) or [ECI voter services](https://voters.eci.gov.in/). The dataset identifies MLAs only; it does not identify a councillor, MP, or the agency responsible for a specific issue. Ward/locality labels from Nominatim are also not official boundary determinations.

To refresh the bundled MLA dataset, run `python3 scripts/build-bengaluru-mla-data.py`. The script downloads the DataMeet shapefile and Karnataka Legislative Assembly roster, then updates `data/bengaluru-assembly-mlas.geojson`; review the resulting source dates and attribution before publishing.

## Report tracking

Each report receives a public reference such as `FM-A1B2C3D4E5F6`. The report card's **Track report** link, the reference form, and `/track/<reference>` open the same status history and pinned location. Tracking history records changes made in FixMaduva; submitting a report here does not send it to a government office.

An operator can enable status updates by setting an unpredictable `ADMIN_TOKEN` in the server environment and restarting the server. Keep the token secret; never put it in browser code. Use the protected API from an authorized operations environment:

```sh
curl -X PATCH http://127.0.0.1:3000/api/admin/issues/REPORT_UUID/status \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_progress","note":"Update the resident can verify."}'
```

Allowed statuses are `open`, `in_progress`, and `resolved`. Include a factual update note; it will be visible in the public report timeline.

## Current MVP limitations

The JSON file is suitable for local development and a single small instance, not a multi-instance production deployment. There is no user account, moderation console, official civic integration, database backup, or identity verification. Browser IDs only prevent accidental repeat support from the same browser; they are not secure authentication. Before public launch, add moderation and spam controls, a production database, backups, privacy/retention terms, and a deployment-specific rate limiter.

The map uses OpenStreetMap tiles and Leaflet from public CDNs, so those services and an internet connection are required to load the map. Reports and API behavior run on the local Node server.
