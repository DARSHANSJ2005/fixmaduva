const issueList = document.querySelector("#issueList");
const searchInput = document.querySelector("#searchInput");
const reportDialog = document.querySelector("#reportDialog");
const reportForm = document.querySelector("#reportForm");
const toast = document.querySelector("#toast");
const locationStatus = document.querySelector("#locationStatus");
const photoInput = document.querySelector("#issuePhoto");
const photoPreview = document.querySelector("#photoPreview");
const photoPreviewImage = document.querySelector("#photoPreviewImage");
const latInput = document.querySelector("#issueLat");
const lngInput = document.querySelector("#issueLng");
const mapElement = document.querySelector("#liveMap");
const icons = { Waste: "♻", Road: "◉", Water: "⌁", Street: "✦", Other: "＋" };
let issues = [];
let activeFilter = "all";
let toastTimeout;
let searchTimeout;
let issueLoadSequence = 0;
let locationLookupSequence = 0;
let map;
let mapMarkers;
let pickedMarker;
let pickingLocation = false;
let pickedCoordinates = null;
let photoPreviewUrl = "";
let voterId = getVoterId();

function getVoterId() {
  try {
    let id = localStorage.getItem("fixmaduva-voter-id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("fixmaduva-voter-id", id);
    }
    return id;
  } catch (error) {
    console.error("Could not save your browser voter ID.", error);
    return crypto.randomUUID();
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("visible"), 3500);
}

function initMap() {
  if (!window.L) {
    mapElement.innerHTML = '<div class="map-error">The open map could not load. Check your connection and refresh.</div>';
    return;
  }
  map = L.map(mapElement, { scrollWheelZoom: false }).setView([12.9716, 77.5946], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
  }).addTo(map);
  mapMarkers = L.featureGroup().addTo(map);
  map.on("click", (event) => {
    if (!pickingLocation) return;
    pickingLocation = false;
    if (!setPickedLocation(event.latlng.lat, event.latlng.lng)) {
      setTimeout(openReport, 250);
      return;
    }
    showToast("Location pinned. Finish the report details.");
    setTimeout(openReport, 250);
  });
}

function setPickedLocation(lat, lng) {
  if (lat < 12.6 || lat > 13.25 || lng < 77.2 || lng > 78.0) {
    showToast("FixMaduva currently supports report locations in Bengaluru.");
    return false;
  }
  pickedCoordinates = { lat, lng };
  latInput.value = lat.toFixed(6);
  lngInput.value = lng.toFixed(6);
  locationStatus.textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (map && pickedMarker) map.removeLayer(pickedMarker);
  if (map) {
    pickedMarker = L.circleMarker([lat, lng], {
      radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1,
    }).addTo(map);
  }
  return true;
}

function issueIconClass(type) {
  return ({ Waste: "waste", Water: "water", Road: "road", Street: "street" })[type] || "other";
}

function visibleIssues() {
  const query = searchInput.value.trim().toLowerCase();
  return issues.filter((issue) => {
    const matchesFilter = activeFilter === "all"
      || (activeFilter === "supported" ? issue.supported : !issue.supported);
    const matchesQuery = !query
      || `${issue.title} ${issue.details || ""} ${issue.area} ${issue.type}`.toLowerCase().includes(query);
    return matchesFilter && matchesQuery;
  });
}

function renderIssues() {
  const visible = visibleIssues();
  if (!visible.length) {
    issueList.innerHTML = issues.length
      ? '<div class="empty-state">No reports match those filters.<br />Try a different search.</div>'
      : '<div class="empty-state">No community reports yet.<br />Be the first to pin an issue on the map.</div>';
    return;
  }

  issueList.innerHTML = visible.slice(0, 40).map((issue) => `
    <article class="issue-card" data-id="${escapeHtml(issue.id)}" tabindex="0" aria-label="${escapeHtml(issue.title)}, ${escapeHtml(issue.area)}">
      <div class="issue-icon ${issueIconClass(issue.type)}">${icons[issue.type] || icons.Other}</div>
      <div class="issue-content">
        <strong class="issue-title">${escapeHtml(issue.title)}</strong>
        <div class="issue-meta"><span>${escapeHtml(issue.area)}</span><span class="dot-separator">·</span><span>${formatTime(issue.createdAt)}</span></div>
        ${issue.details ? `<p class="issue-details">${escapeHtml(issue.details)}</p>` : ""}
        ${issue.imageUrl ? `<img class="issue-photo" src="${escapeHtml(issue.imageUrl)}" alt="Photo attached to ${escapeHtml(issue.title)}" loading="lazy" />` : ""}
        <button class="support-button${issue.supported ? " supported" : ""}" type="button" data-support="${escapeHtml(issue.id)}" aria-pressed="${issue.supported}">
          <span aria-hidden="true">${issue.supported ? "♥" : "♡"}</span> ${issue.support} ${issue.support === 1 ? "neighbour backs" : "neighbours back"} this
        </button>
        <div class="issue-actions">
          <button class="track-report-button" type="button" data-track="${escapeHtml(issue.trackingCode)}">Track report <span aria-hidden="true">→</span></button>
          <button class="track-report-button" type="button" data-share="${escapeHtml(issue.id)}">Share ↗</button>
          <a class="track-report-button whatsapp-share-link" href="${escapeHtml(whatsappShareUrl(issue))}" target="_blank" rel="noreferrer">WhatsApp ↗</a>
        </div>
      </div>
      <span class="issue-tag">${escapeHtml(issue.status === "open" ? "Open report" : issue.status)}</span>
    </article>
  `).join("");
  issueList.querySelectorAll(".issue-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-support], [data-track], [data-share], .whatsapp-share-link")) return;
      focusIssue(card.dataset.id);
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && event.target === card) {
        event.preventDefault();
        focusIssue(card.dataset.id);
      }
    });
  });
  issueList.querySelectorAll("[data-support]").forEach((button) => {
    button.addEventListener("click", () => toggleSupport(button.dataset.support, button));
  });
  issueList.querySelectorAll("[data-track]").forEach((button) => {
    button.addEventListener("click", () => trackReport(button.dataset.track));
  });
  issueList.querySelectorAll("[data-share]").forEach((button) => {
    button.addEventListener("click", () => {
      const issue = issues.find((item) => item.id === button.dataset.share);
      if (issue) shareReport(issue);
    });
  });
}

function formatTime(dateString) {
  const timestamp = new Date(dateString).getTime();
  if (!Number.isFinite(timestamp)) return "Recently";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  return new Date(dateString).toLocaleDateString();
}

function renderMapMarkers() {
  if (!map || !mapMarkers) return;
  mapMarkers.clearLayers();
  issues.forEach((issue) => {
    if (!Number.isFinite(Number(issue.lat)) || !Number.isFinite(Number(issue.lng))) return;
    const marker = L.circleMarker([issue.lat, issue.lng], {
      radius: 8,
      color: "#fff",
      weight: 3,
      fillColor: issue.support > 0 ? "#1d4ed8" : "#5790e8",
      fillOpacity: 1,
    });
    marker.bindPopup(`<strong>${escapeHtml(issue.title)}</strong><br>${escapeHtml(issue.area)} · ${issue.support} supporting`);
    marker.on("click", () => {
      const card = issueList.querySelector(`[data-id="${CSS.escape(issue.id)}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    mapMarkers.addLayer(marker);
  });
}

function focusIssue(id) {
  const issue = issues.find((item) => item.id === id);
  if (!issue) return;
  if (map && Number.isFinite(Number(issue.lat)) && Number.isFinite(Number(issue.lng))) {
    map.setView([issue.lat, issue.lng], Math.max(map.getZoom(), 15), { animate: true });
    mapMarkers.eachLayer((marker) => {
      const latLng = marker.getLatLng();
      if (Math.abs(latLng.lat - issue.lat) < 0.000001 && Math.abs(latLng.lng - issue.lng) < 0.000001) marker.openPopup();
    });
  }
}

async function loadIssues() {
  const loadSequence = ++issueLoadSequence;
  issueList.innerHTML = '<div class="empty-state">Loading community reports…</div>';
  try {
    const search = new URLSearchParams({ voterId });
    const query = searchInput.value.trim();
    if (query) search.set("q", query);
    const { issues: loadedIssues } = await api(`/api/issues?${search}`);
    if (loadSequence !== issueLoadSequence) return;
    issues = loadedIssues;
    renderIssues();
    renderMapMarkers();
    document.querySelector("#allCount").textContent = String(issues.length);
    updateStats();
  } catch (error) {
    if (loadSequence !== issueLoadSequence) return;
    issueList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}<br />Please refresh to try again.</div>`;
    showToast("Could not load reports from the server.");
    console.error("Could not load reports.", error);
  }
}

async function updateStats() {
  try {
    const stats = await api("/api/stats");
    document.querySelector("#reportCount").textContent = stats.reports.toLocaleString();
    document.querySelector("#areaCount").textContent = stats.areas.toLocaleString();
    document.querySelector("#supportCount").textContent = stats.supports.toLocaleString();
  } catch (error) {
    console.error("Could not load community statistics.", error);
  }
}

async function toggleSupport(issueId, button) {
  button.disabled = true;
  try {
    await api(`/api/issues/${encodeURIComponent(issueId)}/support`, {
      method: "POST",
      body: JSON.stringify({ voterId }),
    });
    await loadIssues();
  } catch (error) {
    showToast(error.message);
    console.error("Could not update community support.", error);
  } finally {
    button.disabled = false;
  }
}

function openReport() {
  if (!reportDialog.open) reportDialog.showModal();
  document.querySelector("#issueTitle").focus();
}

function clearPhotoPreview() {
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = "";
  photoPreviewImage.removeAttribute("src");
  photoPreview.hidden = true;
  photoInput.value = "";
}

photoInput.addEventListener("change", () => {
  const [file] = photoInput.files || [];
  if (!file) {
    clearPhotoPreview();
    return;
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    clearPhotoPreview();
    showToast("Choose a JPG, PNG, or WebP photo.");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    clearPhotoPreview();
    showToast("Choose a photo smaller than 10 MB.");
    return;
  }
  if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
  photoPreviewUrl = URL.createObjectURL(file);
  photoPreviewImage.src = photoPreviewUrl;
  photoPreview.hidden = false;
});

document.querySelector("#removePhotoButton").addEventListener("click", clearPhotoPreview);

async function prepareReportPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Photo processing is not available in this browser.");
  }
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  for (const quality of [0.86, 0.74, 0.62, 0.5]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= 1_500_000) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
        reader.onerror = () => reject(new Error("Could not read the processed photo."));
        reader.readAsDataURL(blob);
      });
    }
  }
  throw new Error("Could not reduce this photo below 1.5 MB. Try a smaller image.");
}

function formatStatus(status) {
  return ({
    open: "Report received",
    in_progress: "Work in progress",
    resolved: "Marked resolved",
  })[status] || "Status updated";
}

function trackUrl(code) {
  return `${window.location.origin}/track/${encodeURIComponent(code)}`;
}

function reportShareText(issue) {
  return [
    `FixMaduva report: ${issue.title}`,
    `Area: ${issue.area}`,
    `Status: ${formatStatus(issue.status)}`,
    `Reference: ${issue.trackingCode}`,
  ].join("\n");
}

function whatsappShareUrl(issue) {
  const message = `${reportShareText(issue)}\n${trackUrl(issue.trackingCode)}`;
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

async function showReportDetails(issue, { updateUrl = true } = {}) {
  const detail = document.querySelector("#trackingDetail");
  const statusHistory = Array.isArray(issue.statusHistory) ? issue.statusHistory : [];
  const activeStage = issue.status === "resolved" ? 2 : issue.status === "in_progress" ? 1 : 0;
  const stages = [
    { status: "open", label: "Report received" },
    { status: "in_progress", label: "In progress" },
    { status: "resolved", label: "Resolved" },
  ];

  detail.innerHTML = `
    <div class="tracking-header">
      <div>
        <div class="dialog-kicker">FIXMADUVA REPORT TRACKER</div>
        <h2 id="trackingTitle">${escapeHtml(issue.title)}</h2>
        <p class="tracking-reference">Reference <strong>${escapeHtml(issue.trackingCode)}</strong></p>
      </div>
      <div class="tracking-share-actions">
        <button class="share-report-button" type="button" id="shareTrackingButton">Share ↗</button>
        <a class="share-report-button whatsapp-share-link" href="${escapeHtml(whatsappShareUrl(issue))}" target="_blank" rel="noreferrer">WhatsApp ↗</a>
      </div>
    </div>
    ${issue.imageUrl ? `<img class="tracking-photo" src="${escapeHtml(issue.imageUrl)}" alt="Photo attached to ${escapeHtml(issue.title)}" />` : ""}
    <section class="tracking-status-card" aria-label="Current report status">
      <div class="tracking-status-line"><span class="status-pulse"></span><strong>${escapeHtml(formatStatus(issue.status))}</strong></div>
      <ol class="status-steps">${stages.map((stage, index) => `
        <li class="${index <= activeStage ? "complete" : ""} ${index === activeStage ? "current" : ""}">
          <span class="status-step-dot">${index < activeStage ? "✓" : index + 1}</span>
          <span>${stage.label}</span>
        </li>
      `).join("")}</ol>
      <p class="tracking-disclaimer">This status reflects updates entered in FixMaduva. Posting here does not submit a complaint to a government office.</p>
    </section>
    <div class="tracking-columns">
      <section class="tracking-section">
        <h3>Update history</h3>
        <ol class="tracking-timeline">
          ${[...statusHistory].reverse().map((entry) => `
            <li>
              <span class="timeline-dot"></span>
              <div><strong>${escapeHtml(formatStatus(entry.status))}</strong><time>${escapeHtml(formatDate(entry.createdAt))}</time>
              <p>${escapeHtml(entry.note || "Report status updated.")}</p></div>
            </li>
          `).join("") || "<li>Tracking history is not available for this report.</li>"}
        </ol>
      </section>
      <section class="tracking-section location-section">
        <h3>Report location</h3>
        <p class="location-address" id="trackingAddress">Looking up the nearby address…</p>
        <p class="location-jurisdiction" id="trackingJurisdiction"></p>
        <a class="tracking-map-link" href="https://www.openstreetmap.org/?mlat=${encodeURIComponent(issue.lat)}&mlon=${encodeURIComponent(issue.lng)}#map=17/${encodeURIComponent(issue.lat)}/${encodeURIComponent(issue.lng)}" target="_blank" rel="noreferrer">Open pinned location in OpenStreetMap ↗</a>
        <div class="representative-lookup" id="representativeLookup"></div>
        <p class="geocoder-credit">Address from OpenStreetMap Nominatim. Map coordinates may not align with administrative boundaries.</p>
      </section>
    </div>
  `;
  const dialog = document.querySelector("#trackingDialog");
  if (!dialog.open) dialog.showModal();
  if (updateUrl) history.replaceState({ tracking: issue.trackingCode }, "", `/track/${encodeURIComponent(issue.trackingCode)}`);
  document.querySelector("#shareTrackingButton").addEventListener("click", () => shareReport(issue));
  lookupReportLocation(issue);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

async function lookupReportLocation(issue) {
  const lookupSequence = ++locationLookupSequence;
  const addressElement = document.querySelector("#trackingAddress");
  const jurisdictionElement = document.querySelector("#trackingJurisdiction");
  const representativeElement = document.querySelector("#representativeLookup");
  try {
    const { location } = await api(`/api/locations/${encodeURIComponent(issue.id)}?lat=${encodeURIComponent(issue.lat)}&lng=${encodeURIComponent(issue.lng)}`);
    if (lookupSequence !== locationLookupSequence) return;
    const locality = location.neighbourhood || issue.area;
    const addressParts = [location.road, locality, location.municipality, location.district, location.state, location.postcode].filter(Boolean);
    addressElement.textContent = addressParts.join(", ") || "A nearby street address could not be identified.";
    const jurisdiction = [location.ward && `Ward ${location.ward}`, location.municipality].filter(Boolean);
    jurisdictionElement.textContent = jurisdiction.length
      ? `Mapped civic area: ${jurisdiction.join(" · ")}`
      : "Civic ward boundary not available from this map lookup.";

    const representative = location.representative;
    const representativeDetails = representative
      ? `<p><strong>Likely MLA:</strong> ${escapeHtml(representative.mla)}<br>
          <strong>Assembly constituency:</strong> ${escapeHtml(representative.constituency)} (${escapeHtml(representative.constituencyNumber)})<br>
          <strong>Party:</strong> ${escapeHtml(representative.party)}</p>
        <p>Roster last modified: ${escapeHtml(representative.rosterLastModified || "date not provided")}</p>`
      : `<p><strong>Assembly constituency / MLA:</strong> No boundary match is available for this pinned point. Check the official electoral sources.</p>`;
    representativeElement.innerHTML = `
      <h4>Local representative lookup</h4>
      ${representativeDetails}
      <div class="representative-links">
        ${representative
    ? `<a href="${escapeHtml(representative.source)}" target="_blank" rel="noreferrer">Current Karnataka Assembly member roster ↗</a>
          <a href="${escapeHtml(representative.boundarySource)}" target="_blank" rel="noreferrer">Constituency boundary data and attribution ↗</a>`
    : ""}
        <a href="https://ceo.karnataka.gov.in/" target="_blank" rel="noreferrer">Karnataka Chief Electoral Officer ↗</a>
        <a href="https://voters.eci.gov.in/" target="_blank" rel="noreferrer">Election Commission voter services ↗</a>
      </div>
      <small>${representative
    ? `Best-effort boundary match using ${escapeHtml(representative.boundaryLicense)} community-digitized boundaries. ${escapeHtml(representative.boundaryCaveat)} This identifies an MLA only; it does not identify a councillor, MP, or agency responsible for the specific issue.`
    : "A constituency boundary and current officeholder could not be matched here. Verify through official voter services before relying on an assignment."}</small>
    `;
  } catch (error) {
    if (lookupSequence !== locationLookupSequence) return;
    addressElement.textContent = error.message;
    jurisdictionElement.textContent = "The pinned coordinates remain available on the map.";
    representativeElement.innerHTML = `
      <h4>Local representative lookup</h4>
      <p>We couldn’t resolve the locality. Check constituency details with the official voter services.</p>
      <div class="representative-links"><a href="https://ceo.karnataka.gov.in/" target="_blank" rel="noreferrer">Karnataka Chief Electoral Officer ↗</a></div>
    `;
  }
}

async function trackReport(code) {
  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) {
    showToast("Enter the FixMaduva tracking reference.");
    return;
  }
  try {
    const { issue } = await api(`/api/issues/${encodeURIComponent(normalizedCode)}?voterId=${encodeURIComponent(voterId)}`);
    await showReportDetails(issue);
  } catch (error) {
    showToast(error.message);
    document.querySelector("#trackingCodeInput").focus();
  }
}

async function shareReport(issue) {
  const url = trackUrl(issue.trackingCode);
  try {
    if (navigator.share) {
      await navigator.share({
        title: `FixMaduva report ${issue.trackingCode}`,
        text: reportShareText(issue),
        url,
      });
      return;
    }
    await navigator.clipboard.writeText(url);
    showToast("Report tracking link copied.");
  } catch (error) {
    if (error.name !== "AbortError") {
      showToast("Could not share the link. Copy this reference: " + issue.trackingCode);
    }
  }
}

document.querySelector("#trackingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  trackReport(document.querySelector("#trackingCodeInput").value);
});

document.querySelector("#trackingDialog").addEventListener("close", () => {
  locationLookupSequence += 1;
  if (window.location.pathname.startsWith("/track/")) history.replaceState(null, "", "/");
});

document.querySelectorAll("#reportButton, #howReportButton").forEach((button) => button.addEventListener("click", openReport));
document.querySelector("#joinButton").addEventListener("click", () => showToast("You can take part by posting a report or backing a neighbour."));
document.querySelector("#communityJoin").addEventListener("click", () => showToast("Post or support a report to help your neighbourhood."));
document.querySelector(".language-button").addEventListener("click", () => showToast("Kannada translation is not available yet."));

document.querySelector("#pickLocationButton").addEventListener("click", () => {
  reportDialog.close();
  if (!map) {
    showToast("The map is unavailable. Check your connection and refresh.");
    return;
  }
  pickingLocation = true;
  showToast("Click the map to pin the issue location.");
  document.querySelector("#map").scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => map.invalidateSize(), 250);
});

document.querySelector("#locateButton").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showToast("Location is not available in this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      if (latitude < 12.6 || latitude > 13.25 || longitude < 77.2 || longitude > 78.0) {
        showToast("FixMaduva currently supports report locations in Bengaluru.");
        return;
      }
      if (map) map.setView([latitude, longitude], 15);
      if (!setPickedLocation(latitude, longitude)) return;
      showToast("Map centered on your location.");
    },
    (error) => {
      const message = error.code === error.PERMISSION_DENIED
        ? "Location access was declined. You can still choose a point on the map."
        : "Could not get your location. Choose a point on the map instead.";
      showToast(message);
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
  );
});

document.querySelector("#mapStyleButton").addEventListener("click", () => {
  if (!map) return;
  map.setView([12.9716, 77.5946], 12);
});

document.querySelector("#filtersButton").addEventListener("click", () => {
  searchInput.focus();
  showToast("Search reports by title, area, or issue type.");
});

document.querySelector("#viewAllButton").addEventListener("click", () => {
  activeFilter = "all";
  searchInput.value = "";
  document.querySelectorAll(".panel-tab").forEach((tab) => {
    const selected = tab.dataset.filter === "all";
    tab.classList.toggle("selected", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
  loadIssues();
});

document.querySelectorAll(".panel-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    activeFilter = tab.dataset.filter;
    document.querySelectorAll(".panel-tab").forEach((item) => {
      const selected = item === tab;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-selected", String(selected));
    });
    renderIssues();
  });
});

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadIssues, 200);
});

reportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pickedCoordinates) {
    showToast("Pin the issue location on the map before posting.");
    return;
  }
  const formData = new FormData(reportForm);
  const submitButton = reportForm.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const photo = photoInput.files?.[0]
      ? await prepareReportPhoto(photoInput.files[0])
      : null;
    const { issue } = await api("/api/issues", {
      method: "POST",
      body: JSON.stringify({
        title: formData.get("title"),
        area: formData.get("area"),
        type: formData.get("type"),
        details: formData.get("details"),
        lat: Number(formData.get("lat")),
        lng: Number(formData.get("lng")),
        ...(photo ? { image: { mimeType: "image/jpeg", data: photo } } : {}),
      }),
    });
    reportForm.reset();
    clearPhotoPreview();
    pickedCoordinates = null;
    latInput.value = "";
    lngInput.value = "";
    locationStatus.textContent = "Required · choose a point on the map";
    if (map && pickedMarker) map.removeLayer(pickedMarker);
    pickedMarker = null;
    reportDialog.close();
    activeFilter = "all";
    document.querySelectorAll(".panel-tab").forEach((tab) => {
      const selected = tab.dataset.filter === "all";
      tab.classList.toggle("selected", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
    searchInput.value = "";
    await loadIssues();
    showToast(`Report posted. Tracking reference: ${issue.trackingCode}`);
    await showReportDetails(issue);
  } catch (error) {
    showToast(error.message);
    console.error("Could not post report.", error);
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector("#menuButton").addEventListener("click", (event) => {
  const menu = document.querySelector(".main-nav");
  const isOpen = menu.classList.toggle("open");
  event.currentTarget.setAttribute("aria-expanded", String(isOpen));
});
document.querySelectorAll(".main-nav a").forEach((link) => link.addEventListener("click", () => {
  document.querySelector(".main-nav").classList.remove("open");
  document.querySelector("#menuButton").setAttribute("aria-expanded", "false");
}));

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key === "Escape") pickingLocation = false;
});

initMap();
loadIssues();
if (window.location.pathname.startsWith("/track/")) {
  trackReport(decodeURIComponent(window.location.pathname.split("/")[2] || ""));
}
