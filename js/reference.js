/* Reference page: multiple named reference pages as tabs (e.g. "Geology
   terms", "Software shortcuts", "Book notes"), each with its own notes and
   links, plus a shared World Map for marking places and jotting notes
   about different countries — same Leaflet + freehand sketch setup as the
   Travel Plan maps, with drawings saved as GeoJSON and fully editable. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';
import { attachFreehandTool } from './leaflet-freehand.js';
import { geocodeOne } from './geocode.js';
import { addBaseLayer } from './map-basemap.js';
import { getCurrentLocation } from './geolocation.js';
import { getRoute, formatDuration } from './routing.js';
import { attachClickCoordinates } from './map-click-coords.js';
import { moveToTrash } from './trash.js';

function activeRefPage() {
  return state.reference.pages.find(p => p.id === state.reference.activePage) || state.reference.pages[0];
}

export function renderReference() {
  const pages = state.reference.pages;
  const active = activeRefPage();
  if (active && state.reference.activePage !== active.id) state.reference.activePage = active.id;

  const tabs = document.getElementById("refPageTabs");
  if (tabs) {
    tabs.innerHTML = pages.map(p => `
      <button class="tab ${p.id === active.id ? "active" : ""}" onclick="switchRefPage('${p.id}')">${esc(p.name)}</button>`).join("")
      + `<button class="tab tab-add" onclick="addRefPage()" title="New reference page">＋</button>`;
  }

  const nameEl = document.getElementById("refPageName");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = active.name;
  const delBtn = document.getElementById("refPageDelBtn");
  if (delBtn) delBtn.style.display = pages.length > 1 ? "" : "none";

  const n = document.getElementById("notes-reference");
  if (n && document.activeElement !== n) n.value = active.notes || "";
  const g = document.getElementById("secLinks-reference");
  if (g) g.innerHTML = (active.links || []).map(l => `
    <div class="link-card">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <button class="del" onclick="delRefLink('${l.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No links yet.</p>`;
}

export function addRefPage() {
  const name = prompt("Name this reference page (e.g. Geology terms, Software shortcuts, Book notes):");
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), notes: "", links: [] };
  state.reference.pages.push(p);
  state.reference.activePage = p.id;
  persist(); renderReference();
}
export function switchRefPage(id) {
  state.reference.activePage = id;
  persist(false); renderReference();
}
export function renameRefPage(v) {
  const p = activeRefPage(); if (!p || !v.trim()) return;
  p.name = v.trim();
  persist(); renderReference();
}
export function delRefPage() {
  if (state.reference.pages.length <= 1) return;
  const p = activeRefPage();
  if (!confirm(`Delete the "${p.name}" reference page? You can restore it from Trash within 30 days.`)) return;
  moveToTrash("referencePage", p);
  state.reference.pages = state.reference.pages.filter(x => x.id !== p.id);
  state.reference.activePage = state.reference.pages[0].id;
  persist(); renderReference();
}

let refNotesTimer = null;
export function saveReferenceNotes(v) {
  const p = activeRefPage();
  p.notes = v;
  clearTimeout(refNotesTimer);
  refNotesTimer = setTimeout(() => persist(), 800);
}
export function addRefLink() {
  const t = document.getElementById("refLinkTitle"), u = document.getElementById("refLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  activeRefPage().links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); renderReference();
}
export function delRefLink(id) {
  const p = activeRefPage();
  const l = p.links.find(x => x.id === id);
  if (l) moveToTrash("referenceLink", l, { pageId: p.id });
  p.links = p.links.filter(x => x.id !== id);
  persist(); renderReference();
}

/* ---------------- World Map: one shared map, mark places, sketch/write notes ---------------- */
let worldMapInstance = null;
let worldSearchMarker = null;

export async function searchWorldMap() {
  const input = document.getElementById("worldMapSearch");
  const q = input.value.trim();
  if (!q) return;
  if (!worldMapInstance) return; // map isn't visible yet — shouldn't normally happen
  const btn = document.querySelector('button[onclick="searchWorldMap()"]');
  if (btn) { btn.disabled = true; btn.textContent = "Searching…"; }
  const result = await geocodeOne(q);
  if (btn) { btn.disabled = false; btn.textContent = "🔍 Go"; }
  if (!result) { toast("Couldn't find \"" + q + "\" — try a simpler or more specific name"); return; }
  worldMapInstance.map.setView(result.coords, 6);
  if (worldSearchMarker) worldMapInstance.map.removeLayer(worldSearchMarker);
  worldSearchMarker = L.marker(result.coords).addTo(worldMapInstance.map).bindPopup(esc(q)).openPopup();
  toast("Zoomed to " + q);
}

let myLocationMarker = null;
export async function locateMeOnWorldMap() {
  if (!worldMapInstance) return;
  const btn = document.getElementById("worldMapLocateBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Locating…"; }
  try {
    const coords = await getCurrentLocation();
    worldMapInstance.map.setView(coords, 13);
    if (myLocationMarker) worldMapInstance.map.removeLayer(myLocationMarker);
    myLocationMarker = L.marker(coords).addTo(worldMapInstance.map).bindPopup("📍 You are here").openPopup();
    toast("Zoomed to your location");
  } catch (e) {
    toast(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🎯 My location"; }
  }
}

/* ---- Distance & route (two place names, or "my location" as the start) ---- */
let routeLayer = null;
let routeStartMarker = null, routeEndMarker = null;
export async function useMyLocationForRouteFrom() {
  const input = document.getElementById("routeFrom");
  const btn = document.getElementById("routeFromLocateBtn");
  if (btn) { btn.disabled = true; }
  try {
    const coords = await getCurrentLocation();
    input.value = "My location";
    input.dataset.coords = JSON.stringify(coords);
    toast("Using your current location as the start");
  } catch (e) {
    toast(e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}
export function clearRouteFromLocation() {
  const input = document.getElementById("routeFrom");
  if (input.dataset.coords) { delete input.dataset.coords; if (input.value === "My location") input.value = ""; }
}

export async function calculateWorldMapRoute() {
  if (!worldMapInstance) return;
  const fromInput = document.getElementById("routeFrom"), toInput = document.getElementById("routeTo");
  const resultEl = document.getElementById("routeResult");
  const fromText = fromInput.value.trim(), toText = toInput.value.trim();
  if (!fromText || !toText) { toast("Enter both a starting place and a destination"); return; }

  const btn = document.getElementById("routeCalcBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Calculating…"; }
  resultEl.textContent = "";
  try {
    let fromCoords = fromInput.dataset.coords ? JSON.parse(fromInput.dataset.coords) : null;
    if (!fromCoords) {
      const g = await geocodeOne(fromText);
      if (!g) { toast("Couldn't find \"" + fromText + "\""); return; }
      fromCoords = g.coords;
    }
    const toGeo = await geocodeOne(toText);
    if (!toGeo) { toast("Couldn't find \"" + toText + "\""); return; }
    const toCoords = toGeo.coords;

    const route = await getRoute(fromCoords, toCoords);
    if (!route) { toast("Couldn't calculate a driving route between those two places"); return; }

    resultEl.innerHTML = `<b>${route.distanceKm.toFixed(1)} km</b> by road · about ${formatDuration(route.durationMin)} driving`;

    if (routeLayer) worldMapInstance.map.removeLayer(routeLayer);
    if (routeStartMarker) worldMapInstance.map.removeLayer(routeStartMarker);
    if (routeEndMarker) worldMapInstance.map.removeLayer(routeEndMarker);
    const latlngs = route.geometry.coordinates.map(c => [c[1], c[0]]);
    routeLayer = L.polyline(latlngs, { color: "#1D4E89", weight: 4, opacity: 0.85 }).addTo(worldMapInstance.map);
    routeStartMarker = L.marker(fromCoords).addTo(worldMapInstance.map).bindPopup("Start: " + esc(fromText));
    routeEndMarker = L.marker(toCoords).addTo(worldMapInstance.map).bindPopup("Destination: " + esc(toText));
    worldMapInstance.map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
    document.getElementById("routeResetBtn").style.display = "";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Get route"; }
  }
}

export function resetWorldMapRoute() {
  const fromInput = document.getElementById("routeFrom"), toInput = document.getElementById("routeTo");
  const resultEl = document.getElementById("routeResult");
  fromInput.value = ""; toInput.value = "";
  if (fromInput.dataset.coords) delete fromInput.dataset.coords;
  resultEl.textContent = "";
  if (worldMapInstance) {
    if (routeLayer) { worldMapInstance.map.removeLayer(routeLayer); routeLayer = null; }
    if (routeStartMarker) { worldMapInstance.map.removeLayer(routeStartMarker); routeStartMarker = null; }
    if (routeEndMarker) { worldMapInstance.map.removeLayer(routeEndMarker); routeEndMarker = null; }
  }
  document.getElementById("routeResetBtn").style.display = "none";
}

function initWorldMap() {
  const container = document.getElementById("worldMap");
  if (!container) return;
  if (worldMapInstance) { worldMapInstance.map.invalidateSize(); return; }
  if (typeof L === "undefined") return;

  const map = L.map(container, { zoomSnap: 0.25, zoomDelta: 0.25 }).setView([20, 10], 2); // whole-world starting view
  addBaseLayer(map);

  const drawnItems = new L.FeatureGroup().addTo(map);
  const saved = state.reference.worldMapDrawing;
  if (saved && saved.features && saved.features.length) {
    try { L.geoJSON(saved).eachLayer(layer => drawnItems.addLayer(layer)); }
    catch (e) { /* corrupted/old data — start fresh rather than crash */ }
  }

  const drawControl = new L.Control.Draw({ edit: { featureGroup: drawnItems }, draw: { circlemarker: false } });
  map.addControl(drawControl);

  const save = () => { state.reference.worldMapDrawing = drawnItems.toGeoJSON(); persist(); };
  map.on(L.Draw.Event.CREATED, e => { drawnItems.addLayer(e.layer); save(); });
  map.on(L.Draw.Event.EDITED, save);
  map.on(L.Draw.Event.DELETED, save);
  const freehand = attachFreehandTool(map, drawnItems, save);
  attachClickCoordinates(map);

  worldMapInstance = { map, drawnItems, freehand };
  setTimeout(() => map.invalidateSize(), 100);
}

/* Called by ui.js's go() only when the Reference page is actually
   navigated to — never from a data re-render, since renderReference() also
   runs during initial boot for every page (including hidden ones), and a
   Leaflet map first created inside a display:none container can end up
   permanently mis-sized even after invalidateSize(). */
export function showWorldMap() {
  if (worldMapInstance) { worldMapInstance.map.invalidateSize(); return; }
  initWorldMap();
}
