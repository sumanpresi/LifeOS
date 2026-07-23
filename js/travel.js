/* Travel Plan page: multiple named plans as tabs, each with an itinerary of
   stops and a packing list. Per-stop maps are real interactive Leaflet maps
   (OpenStreetMap tiles, no API key or billing needed) with drawing tools —
   markers, lines, shapes — that save as GeoJSON and reload fully editable.
   The Route Map tab still uses Google's no-key directions embed. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';

let travelView = "itinerary"; // "itinerary" | "route"

/* Leaflet map instances are stateful DOM-attached objects — they must NOT be
   torn down by an unrelated re-render, or drawings and edit mode break.
   Keyed by stop id. */
const mapInstances = {}; // { [stopId]: { map, drawnItems } }

function activePlan() {
  return state.travel.plans.find(p => p.id === state.travel.activePlan) || state.travel.plans[0];
}
function routeMapUrl(places) {
  const [first, ...rest] = places;
  const daddr = rest.map(p => encodeURIComponent(p)).join("+to:");
  return "https://www.google.com/maps?saddr=" + encodeURIComponent(first) + "&daddr=" + daddr + "&output=embed";
}

export function switchTravelView(v) {
  travelView = v;
  renderTravel();
}

/* ---------- full rebuild: structure only changes on add/delete stop or plan switch ---------- */
export function renderTravel() {
  destroyAllStopMaps(); // about to rebuild the DOM they live in

  const plans = state.travel.plans;
  const active = activePlan();
  if (active && state.travel.activePlan !== active.id) state.travel.activePlan = active.id;

  const tabs = document.getElementById("travelPlanTabs");
  if (tabs) {
    tabs.innerHTML = plans.map(p => `
      <button class="tab ${p.id === active.id ? "active" : ""}" onclick="switchTravelPlan('${p.id}')">${esc(p.name)}</button>`).join("")
      + `<button class="tab tab-add" onclick="addTravelPlan()" title="New travel plan">＋</button>`;
  }

  const viewTabs = document.getElementById("travelViewTabs");
  if (viewTabs) viewTabs.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.tview === travelView));
  document.querySelectorAll(".travel-view").forEach(el => el.classList.toggle("active", el.dataset.tview === travelView));

  const nameEl = document.getElementById("travelPlanName");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = active.name;
  const delBtn = document.getElementById("travelPlanDelBtn");
  if (delBtn) delBtn.style.display = plans.length > 1 ? "" : "none";

  const stopsBox = document.getElementById("travelStops");
  if (stopsBox) {
    stopsBox.innerHTML = (active.stops || []).map(s => `
      <div class="travel-stop">
        <div class="travel-stop-row">
          <input type="text" placeholder="Place name" value="${esc(s.place)}" onchange="editStop('${s.id}','place',this.value)">
          <input type="text" placeholder="Duration, e.g. 3 nights" value="${esc(s.duration)}" onchange="editStop('${s.id}','duration',this.value)">
          <input type="text" placeholder="Hotel (searching)" value="${esc(s.hotel)}" onchange="editStop('${s.id}','hotel',this.value)">
          <input type="text" placeholder="Booked hotel" value="${esc(s.bookedHotel)}" onchange="editStop('${s.id}','bookedHotel',this.value)">
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:12.5px" onclick="toggleStopMap('${s.id}')" id="mapToggleBtn-${s.id}">${s.mapOpen ? "Hide map" : "🗺️ Map"}</button>
          <button class="del" onclick="delStop('${s.id}')">✕</button>
        </div>
        <p class="hint stop-map-caption" id="mapCaption-${s.id}" style="display:${s.mapOpen ? "" : "none"};margin:8px 0 4px"></p>
        <div class="leaflet-map-container" id="leafletMap-${s.id}" style="display:${s.mapOpen ? "" : "none"}"></div>
      </div>`).join("") || `<p class="hint">Add a stop to start planning this trip.</p>`;

    /* (Re)initialise any stops that were already marked open before this rebuild. */
    (active.stops || []).forEach(s => { if (s.mapOpen) initStopMap(active, s); });
  }

  const routeBox = document.getElementById("travelRouteMap");
  if (routeBox) {
    const places = (active.stops || []).map(s => (s.place || "").trim()).filter(Boolean);
    if (places.length >= 2) {
      routeBox.innerHTML = `<p class="hint" style="margin-bottom:8px">Route: ${places.map(esc).join(" → ")}</p>
        <iframe class="travel-map travel-route-map" src="${routeMapUrl(places)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
    } else {
      routeBox.innerHTML = `<p class="hint">Add at least two stops with place names to see the route for this plan.</p>`;
    }
  }

  const packEl = document.getElementById("travelPacking");
  if (packEl && document.activeElement !== packEl) packEl.value = active.packing || "";
}

/* ---------- plans ---------- */
export function addTravelPlan() {
  const name = prompt("Name this travel plan (e.g. Sikkim, Rajasthan, Ladakh):");
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), notes: "", packing: "", stops: [] };
  state.travel.plans.push(p);
  state.travel.activePlan = p.id;
  persist(); renderTravel();
}
export function switchTravelPlan(id) {
  state.travel.activePlan = id;
  persist(false); renderTravel();
}
export function renameTravelPlan(v) {
  const p = activePlan(); if (!p || !v.trim()) return;
  p.name = v.trim();
  persist(); renderTravel();
}
export function delTravelPlan() {
  if (state.travel.plans.length <= 1) return;
  const p = activePlan();
  if (!confirm(`Delete the "${p.name}" travel plan? This cannot be undone.`)) return;
  state.travel.plans = state.travel.plans.filter(x => x.id !== p.id);
  state.travel.activePlan = state.travel.plans[0].id;
  persist(); renderTravel();
}

/* ---------- stops (structural changes rebuild; field edits don't) ---------- */
export function addStop() {
  const p = activePlan();
  p.stops.push({ id: uid(), place: "", duration: "", hotel: "", bookedHotel: "", mapOpen: false, mapDrawing: null });
  persist(); renderTravel();
}
export function editStop(id, field, v) {
  const p = activePlan();
  const s = p.stops.find(x => x.id === id); if (!s) return;
  s[field] = v;
  persist();
  /* Field edits never rebuild the DOM (that would destroy an open map).
     If the place or hotel changed while the map is open, just recentre it. */
  if (s.mapOpen && (field === "place" || field === "bookedHotel")) recenterStopMap(p, s);
  const cap = document.getElementById("mapCaption-" + id);
  if (cap) cap.innerHTML = mapCaptionHtml(s);
}
export function delStop(id) {
  const p = activePlan();
  p.stops = p.stops.filter(x => x.id !== id);
  persist(); renderTravel();
}

let packTimer = null;
export function saveTravelPacking(v) {
  const p = activePlan();
  p.packing = v;
  clearTimeout(packTimer);
  packTimer = setTimeout(() => persist(), 800);
}

/* ---------- per-stop Leaflet map: init / destroy / recentre / draw persistence ---------- */
function mapCaptionHtml(s) {
  const hasPlace = (s.place || "").trim();
  const hasBooked = (s.bookedHotel || "").trim();
  if (hasBooked) return `📍 Showing your booked hotel: <b>${esc(s.bookedHotel)}</b> — use the drawing tools (top-left of the map) to mark it up.`;
  if (hasPlace) return `Showing <b>${esc(s.place)}</b> — search "hotels near ${esc(s.place)}" on the map, or draw directly on it.`;
  return `Enter a place name, then use the map's drawing tools (top-left) to mark it up.`;
}

export function toggleStopMap(id) {
  const p = activePlan();
  const s = p.stops.find(x => x.id === id); if (!s) return;
  s.mapOpen = !s.mapOpen;
  persist(false);

  const btn = document.getElementById("mapToggleBtn-" + id);
  const container = document.getElementById("leafletMap-" + id);
  const caption = document.getElementById("mapCaption-" + id);
  if (btn) btn.textContent = s.mapOpen ? "Hide map" : "🗺️ Map";
  if (container) container.style.display = s.mapOpen ? "" : "none";
  if (caption) { caption.style.display = s.mapOpen ? "" : "none"; caption.innerHTML = mapCaptionHtml(s); }

  if (s.mapOpen) initStopMap(p, s);
  else destroyStopMap(id);
}

async function geocode(query) {
  if (!query || !query.trim()) return null;
  try {
    const res = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query));
    const data = await res.json();
    if (data && data[0]) return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  } catch (e) { /* offline or blocked — fall back to default view */ }
  return null;
}

function initStopMap(plan, s) {
  if (mapInstances[s.id]) { mapInstances[s.id].map.invalidateSize(); return; }
  const container = document.getElementById("leafletMap-" + s.id);
  if (!container || typeof L === "undefined") return;

  const map = L.map(container).setView([22.5, 80], 5); // default: India, until geocoded
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const drawnItems = new L.FeatureGroup().addTo(map);
  if (s.mapDrawing && s.mapDrawing.features && s.mapDrawing.features.length) {
    try {
      L.geoJSON(s.mapDrawing).eachLayer(layer => drawnItems.addLayer(layer));
    } catch (e) { /* corrupted/old drawing data — start fresh rather than crash */ }
  }

  const drawControl = new L.Control.Draw({
    edit: { featureGroup: drawnItems },
    draw: { circlemarker: false }
  });
  map.addControl(drawControl);

  const save = () => { s.mapDrawing = drawnItems.toGeoJSON(); persist(); };
  map.on(L.Draw.Event.CREATED, e => { drawnItems.addLayer(e.layer); save(); });
  map.on(L.Draw.Event.EDITED, save);
  map.on(L.Draw.Event.DELETED, save);

  mapInstances[s.id] = { map, drawnItems };

  const query = (s.bookedHotel || "").trim() || (s.place || "").trim();
  if (query) {
    geocode((s.bookedHotel ? s.bookedHotel + ", " : "") + s.place).then(coords => {
      if (coords && mapInstances[s.id]) {
        map.setView(coords, 13);
        if (s.bookedHotel) L.marker(coords).addTo(map).bindPopup("📍 " + esc(s.bookedHotel));
      }
      map.invalidateSize();
    });
  }
  setTimeout(() => map.invalidateSize(), 100); // container just became visible
}

function recenterStopMap(plan, s) {
  const inst = mapInstances[s.id];
  if (!inst) return;
  const query = (s.bookedHotel || "").trim() || (s.place || "").trim();
  if (!query) return;
  geocode((s.bookedHotel ? s.bookedHotel + ", " : "") + s.place).then(coords => {
    if (coords && mapInstances[s.id]) inst.map.setView(coords, 13);
  });
}

function destroyStopMap(id) {
  const inst = mapInstances[id];
  if (inst) { inst.map.remove(); delete mapInstances[id]; }
}
function destroyAllStopMaps() {
  Object.keys(mapInstances).forEach(destroyStopMap);
}
