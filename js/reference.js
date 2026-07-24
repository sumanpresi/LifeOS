/* Reference page: multiple named reference pages as tabs (e.g. "Geology
   terms", "Software shortcuts", "Book notes"), each with its own notes and
   links, plus a shared World Map for marking places and jotting notes
   about different countries — same Leaflet + freehand sketch setup as the
   Travel Plan maps, with drawings saved as GeoJSON and fully editable. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';
import { attachFreehandTool } from './leaflet-freehand.js';
import { geocodeOne } from './geocode.js';

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
  if (!confirm(`Delete the "${p.name}" reference page? This cannot be undone.`)) return;
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

function initWorldMap() {
  const container = document.getElementById("worldMap");
  if (!container) return;
  if (worldMapInstance) { worldMapInstance.map.invalidateSize(); return; }
  if (typeof L === "undefined") return;

  const map = L.map(container).setView([20, 10], 2); // whole-world starting view
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

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
