/* Travel Plan page: multiple named plans as tabs, each with an itinerary of
   stops and a packing list. Per-stop maps are real interactive Leaflet maps
   (OpenStreetMap tiles, no API key or billing needed) with drawing tools —
   markers, lines, shapes — that save as GeoJSON and reload fully editable.
   The Route Map tab still uses Google's no-key directions embed. */
import { state, uid, esc, persist, rerender } from './state.js';
import { loadMapLibs } from './lazy-libs.js';
import { toast } from './ui.js';
import { attachFreehandTool } from './leaflet-freehand.js';
import { geocodeOne } from './geocode.js';
import { addBaseLayer, enableClickToScrollZoom } from './map-basemap.js';
import { addFullscreenControl } from './map-fullscreen.js';
import { moveToTrash } from './trash.js';
import { getCurrentLocation } from './geolocation.js';
import { attachClickCoordinates } from './map-click-coords.js';
import { mountRichEditor, unmountRichEditor, getRichEditor } from './rich-text.js';
import { sanitizeHtml } from './sanitize.js';

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
  if (viewTabs) viewTabs.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tview === travelView));
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
          <span class="tsf-wrap"><input type="text" placeholder="Place name" value="${esc(s.place)}" onchange="editStop('${s.id}','place',this.value)">
            <button class="locate-btn" onclick="locateStop('${s.id}','place')" title="Zoom the map to this place">🎯</button></span>
          <input type="text" placeholder="Duration, e.g. 3 nights" value="${esc(s.duration)}" onchange="editStop('${s.id}','duration',this.value)">
          <input type="text" placeholder="Hotel (searching)" value="${esc(s.hotel)}" onchange="editStop('${s.id}','hotel',this.value)">
          <span class="tsf-wrap"><input type="text" placeholder="Booked hotel" value="${esc(s.bookedHotel)}" onchange="editStop('${s.id}','bookedHotel',this.value)">
            <button class="locate-btn" onclick="locateStop('${s.id}','bookedHotel')" title="Zoom the map to this hotel">🎯</button></span>
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:12.5px" onclick="toggleStopMap('${s.id}')" id="mapToggleBtn-${s.id}">${s.mapOpen ? "Hide map" : "🗺️ Map"}</button>
          <button class="del" onclick="delStop('${s.id}')">✕</button>
        </div>
        <p class="hint stop-map-caption" id="mapCaption-${s.id}" style="display:${s.mapOpen ? "" : "none"};margin:8px 0 4px"></p>
        <div class="stop-map-toolbar" id="mapToolbar-${s.id}" style="display:${s.mapOpen ? "" : "none"}">
          <button class="btn btn-ghost" style="padding:5px 10px;font-size:12px" onclick="locateMeOnStopMap('${s.id}')">🎯 My location</button>
        </div>
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

  renderPackLists(active);
}

/* ---------- packing lists ----------
   A plan holds several named lists ("Documents", "Field kit", …), picked
   with the same tab row the plans themselves use. */
function activePackList(plan) {
  const lists = plan.packLists || [];
  return lists.find(l => l.id === plan.activePackList) || lists[0] || null;
}
const PACK_NOTES_EDITOR = "packListNotesEditor";

/* Turns bare URLs typed into an item into real tappable links. The text is
   escaped first and only <a> is added afterwards, so an item can never
   inject markup — the anchor is built from the matched URL alone. */
function linkifyPackText(text) {
  const safe = esc(text);
  return safe.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, m => {
    const trimmed = m.replace(/[.,;:!?)\]]+$/, ""); // trailing punctuation belongs to the sentence, not the URL
    const tail = m.slice(trimmed.length);
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
    return `<a href="${href}" target="_blank" rel="noopener" class="pack-item-link" onclick="event.stopPropagation()">${trimmed}</a>${tail}`;
  });
}

function renderPackLists(plan) {
  const tabs = document.getElementById("packListTabs");
  const list = activePackList(plan);
  if (tabs && list) {
    tabs.innerHTML = (plan.packLists || []).map(l => `
      <button class="tab ${l.id === list.id ? "active" : ""}" onclick="switchPackList('${l.id}')">${esc(l.name)}</button>`).join("")
      + `<button class="tab tab-add" onclick="addPackList()" title="New packing list">＋</button>`;
  }
  const nameEl = document.getElementById("packListName");
  if (nameEl && list && document.activeElement !== nameEl) nameEl.value = list.name;
  const delBtn = document.getElementById("packListDelBtn");
  if (delBtn) delBtn.style.display = (plan.packLists || []).length > 1 ? "" : "none";

  const box = document.getElementById("travelPackingList");
  if (box) {
    const items = list ? list.items : [];
    box.innerHTML = items.map(it => `
      <div class="pack-item ${it.done ? "done" : ""}">
        <button class="chk ${it.done ? "on" : ""}" onclick="togglePackingItem('${it.id}')" aria-label="Toggle packed">
          <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
        <span class="pack-item-text">${linkifyPackText(it.text)}</span>
        <button class="del" onclick="delPackingItem('${it.id}')" aria-label="Delete">✕</button>
      </div>`).join("") || `<p class="hint">Add what you need to pack — passport, chargers, warm jacket…</p>`;
  }

  /* One editor serves every list, so switching lists swaps its contents —
     the same one-instance-many-documents arrangement the journal uses.
     mountRichEditor only reads its initial-content callback on first
     mount, hence the explicit swap below. */
  const notesBox = document.getElementById(PACK_NOTES_EDITOR);
  if (!notesBox || !list) return;
  const quill = mountRichEditor(PACK_NOTES_EDITOR, () => list.notes || "", html => {
    const l = (plan.packLists || []).find(x => x.id === loadedPackListId);
    if (!l) return;
    l.notes = html;
    persist(); // rich-text.js debounced this already; renderTravel() here would destroy the editor mid-edit
  });
  if (!quill) return;
  quill.root.dataset.placeholder = "Notes for this list — sizes, weights, what to buy…";
  if (loadedPackListId === null) { loadedPackListId = list.id; return; }
  if (loadedPackListId === list.id) return;
  flushPackNotes(plan);
  loadedPackListId = list.id;
  // Same as the journal: switching lists loads HTML directly, outside
  // mountRichEditor's own sanitizing.
  if (list.notes) quill.clipboard.dangerouslyPasteHTML(sanitizeHtml(list.notes));
  else quill.setText("");
}
let loadedPackListId = null; // which list's notes the shared editor is currently holding
function flushPackNotes(plan) {
  // Quill's change handler is debounced, so an edit can still be in flight
  // when the list changes — write it back to the list it belongs to first.
  const q = getRichEditor(PACK_NOTES_EDITOR);
  if (!q || loadedPackListId === null) return;
  const l = (plan.packLists || []).find(x => x.id === loadedPackListId);
  if (l && l.notes !== q.root.innerHTML) { l.notes = q.root.innerHTML; persist(); }
}

export function addPackList() {
  const name = prompt("Name this packing list (e.g. Documents, Field kit, Clothing):");
  if (!name || !name.trim()) return;
  const plan = activePlan();
  flushPackNotes(plan);
  const l = { id: uid(), name: name.trim(), notes: "", items: [] };
  plan.packLists.push(l);
  plan.activePackList = l.id;
  persist(); renderTravel();
}
export function switchPackList(id) {
  const plan = activePlan();
  flushPackNotes(plan);
  plan.activePackList = id;
  persist(false); renderTravel();
}
export function renamePackList(v) {
  const l = activePackList(activePlan());
  if (!l || !v.trim()) return;
  l.name = v.trim();
  persist(); renderTravel();
}
export function delPackList() {
  const plan = activePlan();
  if ((plan.packLists || []).length <= 1) return; // a plan always keeps at least one list
  const l = activePackList(plan);
  if (!l) return;
  if (!confirm(`Delete the "${l.name}" packing list and its ${l.items.length} item(s)? You can restore it from Trash within 30 days.`)) return;
  flushPackNotes(plan);
  moveToTrash("packList", l, { planId: plan.id });
  plan.packLists = plan.packLists.filter(x => x.id !== l.id);
  plan.activePackList = plan.packLists[0].id;
  loadedPackListId = null;
  unmountRichEditor(PACK_NOTES_EDITOR);
  persist(); renderTravel();
}

/* ---------- plans ---------- */
export function addTravelPlan() {
  const name = prompt("Name this travel plan (e.g. Sikkim, Rajasthan, Ladakh):");
  if (!name || !name.trim()) return;
  // `packing: ""` here was a real bug — addPackingItem() push()es onto it,
  // which throws on a string. New plans now start with one empty named list.
  const p = { id: uid(), name: name.trim(), notes: "", packing: [], stops: [],
    packLists: [{ id: uid(), name: "Packing list", notes: "", items: [] }] };
  p.activePackList = p.packLists[0].id;
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
  if (!confirm(`Delete the "${p.name}" travel plan? You can restore it from Trash within 30 days.`)) return;
  moveToTrash("travelPlan", p);
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
  const s = p.stops.find(x => x.id === id);
  if (s) moveToTrash("travelStop", s, { planId: p.id });
  p.stops = p.stops.filter(x => x.id !== id);
  persist(); renderTravel();
}

export function addPackingItem() {
  const el = document.getElementById("newPackingItem");
  const v = el.value.trim(); if (!v) return;
  const l = activePackList(activePlan());
  if (!l) return;
  l.items.push({ id: uid(), text: v, done: false });
  el.value = "";
  persist(); renderTravel();
  el.focus();
}
export function togglePackingItem(id) {
  const l = activePackList(activePlan());
  const item = l && l.items.find(x => x.id === id);
  if (item) { item.done = !item.done; persist(); renderTravel(); }
}
export function delPackingItem(id) {
  const p = activePlan();
  const l = activePackList(p);
  if (!l) return;
  const item = l.items.find(x => x.id === id);
  if (item) moveToTrash("packingItem", item, { planId: p.id, packListId: l.id });
  l.items = l.items.filter(x => x.id !== id);
  persist(); renderTravel();
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
  const toolbar = document.getElementById("mapToolbar-" + id);
  if (btn) btn.textContent = s.mapOpen ? "Hide map" : "🗺️ Map";
  if (container) container.style.display = s.mapOpen ? "" : "none";
  if (caption) { caption.style.display = s.mapOpen ? "" : "none"; caption.innerHTML = mapCaptionHtml(s); }
  if (toolbar) toolbar.style.display = s.mapOpen ? "" : "none";

  if (s.mapOpen) initStopMap(p, s);
  else destroyStopMap(id);
}

/* Tries the most specific query first, then falls back to simpler ones —
   a specific hotel name often isn't in OpenStreetMap's free geocoder, but
   the place/town name almost always is. */
async function geocodeWithFallback(hotelName, placeName, alreadyTried) {
  const tried = alreadyTried || new Set();
  const attempts = [];
  if (hotelName && placeName) attempts.push(hotelName + ", " + placeName);
  if (hotelName) attempts.push(hotelName);
  if (placeName) attempts.push(placeName);
  for (const q of attempts) {
    if (tried.has(q)) continue;
    tried.add(q);
    const result = await geocodeOne(q);
    if (result) return { coords: result.coords, matchedQuery: q };
  }
  return null;
}

async function initStopMap(plan, s) {
  if (mapInstances[s.id]) { mapInstances[s.id].map.invalidateSize(); return; }
  const container = document.getElementById("leafletMap-" + s.id);
  if (!container) return;
  // Fetched on demand rather than at boot — see js/lazy-libs.js.
  try { await loadMapLibs(); } catch (e) { container.textContent = "Map library couldn't load — check your connection."; return; }
  if (typeof L === "undefined") return;

  // Fractional zoom (zoomSnap/zoomDelta below 1) was tried here for
  // smoother wheel-zoom steps, but it visibly clashed with the vector
  // tile base layer and made the whole map jittery — reverted to
  // Leaflet's normal integer zoom levels, which render cleanly.
  const map = L.map(container).setView([22.5, 80], 5); // default: India, until geocoded
  addBaseLayer(map);
  enableClickToScrollZoom(map);
  addFullscreenControl(map, s.place || "Map");

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
  const freehand = attachFreehandTool(map, drawnItems, save);
  attachClickCoordinates(map);

  mapInstances[s.id] = { map, drawnItems, bookedMarker: null, myLocationMarker: null, freehand };
  setTimeout(() => map.invalidateSize(), 100); // container just became visible

  if ((s.place || "").trim() || (s.bookedHotel || "").trim()) {
    zoomStopToLocation(s, /*silent=*/true);
  }
}

/* Explicit "🎯 locate" button handler — geocodes just the one field the
   button sits next to, opening the map first if it isn't already open. */
export function locateStop(id, field) {
  const p = activePlan();
  const s = p.stops.find(x => x.id === id); if (!s) return;
  if (!s.mapOpen) { toggleStopMap(id); return; } // opening already triggers a zoom attempt
  zoomStopToLocation(s, /*silent=*/false, field);
}

export async function locateMeOnStopMap(id) {
  const inst = mapInstances[id];
  if (!inst) return;
  const btn = document.querySelector(`#mapToolbar-${id} button`);
  if (btn) { btn.disabled = true; btn.textContent = "Locating…"; }
  try {
    const coords = await getCurrentLocation();
    inst.map.setView(coords, 13);
    if (inst.myLocationMarker) inst.map.removeLayer(inst.myLocationMarker);
    inst.myLocationMarker = L.marker(coords).addTo(inst.map).bindPopup("📍 You are here").openPopup();
    toast("Zoomed to your location");
  } catch (e) {
    toast(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🎯 My location"; }
  }
}

async function zoomStopToLocation(s, silent, focusField) {
  const inst = mapInstances[s.id];
  if (!inst) return;
  const hotelName = (s.bookedHotel || "").trim();
  const placeName = (s.place || "").trim();

  let result = null;
  const tried = new Set();
  // When a specific field's locate button was clicked, try that field alone first
  // (fastest path to what the person actually asked to zoom to).
  if (focusField === "place" && placeName) result = await geocodeWithFallback("", placeName, tried);
  else if (focusField === "bookedHotel" && hotelName) result = await geocodeWithFallback(hotelName, "", tried);
  if (!result) result = await geocodeWithFallback(hotelName, placeName, tried);

  if (!mapInstances[s.id]) return; // map was closed while we were waiting on the network
  if (result) {
    inst.map.setView(result.coords, 14);
    if (inst.bookedMarker) { inst.map.removeLayer(inst.bookedMarker); inst.bookedMarker = null; }
    if (hotelName && result.matchedQuery.includes(hotelName)) {
      inst.bookedMarker = L.marker(result.coords).addTo(inst.map).bindPopup("📍 " + esc(hotelName)).openPopup();
    }
    if (!silent) toast("Map zoomed to " + result.matchedQuery);
  } else if (!silent) {
    toast("Couldn't find that location — try a simpler name (just the town/city often works better than a full hotel name)");
  }
}

function recenterStopMap(plan, s) {
  if (!mapInstances[s.id]) return;
  zoomStopToLocation(s, /*silent=*/true);
}

function destroyStopMap(id) {
  const inst = mapInstances[id];
  if (inst) { if (inst.freehand) inst.freehand.destroy(); inst.map.remove(); delete mapInstances[id]; }
}
function destroyAllStopMaps() {
  Object.keys(mapInstances).forEach(destroyStopMap);
}
