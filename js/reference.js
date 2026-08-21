/* Reference page: multiple named reference pages as tabs (e.g. "Geology
   terms", "Software shortcuts", "Book notes"), each with its own notes and
   links, plus a shared World Map for marking places and jotting notes
   about different countries — same Leaflet + freehand sketch setup as the
   Travel Plan maps, with drawings saved as GeoJSON and fully editable. */
import { state, uid, esc, persist, rerender } from './state.js';
import { loadMapLibs } from './lazy-libs.js';
import { toast } from './ui.js';
import { attachFreehandTool } from './leaflet-freehand.js';
import { attachPenAnnotationTool } from './map-pen-annotation.js';
import { createToolCoordinator } from './map-tool-state.js';
import { geocodeOne } from './geocode.js';
import { addBaseLayer, enableClickToScrollZoom } from './map-basemap.js';
import { addFullscreenControl } from './map-fullscreen.js';
import { getCurrentLocation } from './geolocation.js';
import { getRoute, formatDuration } from './routing.js';
import { attachClickCoordinates } from './map-click-coords.js';
import { moveToTrash } from './trash.js';
import { parseKml, readKmlOrKmz, kmlLayerToLeaflet, featureLatLng, featureKindLabel } from './map-kml.js';

function activeRefPage() {
  return state.reference.pages.find(p => p.id === state.reference.activePage) || state.reference.pages[0];
}

export function renderReference() {
  renderKmlUI();   // independent of the map: see uploadKmlFiles
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

async function initWorldMap() {
  const container = document.getElementById("worldMap");
  if (!container) return;
  if (worldMapInstance) { worldMapInstance.map.invalidateSize(); return; }
  // Fetched on demand rather than at boot — see js/lazy-libs.js.
  try { await loadMapLibs(); } catch (e) { container.textContent = "Map library couldn't load — check your connection."; return; }
  if (typeof L === "undefined") return;
  // Another call may have finished building the map while this awaited.
  if (worldMapInstance) { worldMapInstance.map.invalidateSize(); return; }

  const map = L.map(container).setView([20, 10], 2); // whole-world starting view
  addBaseLayer(map);
  enableClickToScrollZoom(map);
  addFullscreenControl(map, "World map");

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
  // Both drawing tools below share ONE coordinator so exactly one of the
  // four buttons (scribble draw/erase, pen draw/erase) can ever be active
  // at a time — this is what fixes the "both toolbars show active"
  // state-management bug.
  const toolCoordinator = createToolCoordinator();
  const freehand = attachFreehandTool(map, drawnItems, save, toolCoordinator);
  const savePenAnnotations = () => persist();
  const penAnnotation = attachPenAnnotationTool(
    map,
    () => state.reference.penAnnotations,
    (next) => { state.reference.penAnnotations = next; },
    savePenAnnotations,
    toolCoordinator
  );
  attachClickCoordinates(map);

  worldMapInstance = { map, drawnItems, freehand, penAnnotation, kml: new Map() };
  syncKmlLayers();
  setTimeout(() => map.invalidateSize(), 100);
}

/* ---------- uploaded KML layers ----------

   The map is rebuilt from state, never the other way round: state holds
   the parsed features, syncKmlLayers() makes the Leaflet layers match, and
   every action (upload, hide, delete) changes state and calls it again.
   One direction only, so a layer added on another device appears here on
   the next sync without any extra plumbing. */

const KML_MAX_FEATURES = 3000;

function kmlLayersState() {
  if (!Array.isArray(state.reference.kmlLayers)) state.reference.kmlLayers = [];
  return state.reference.kmlLayers;
}

/* Add, remove and show/hide Leaflet layers until the map agrees with state. */
function syncKmlLayers(fit) {
  if (!worldMapInstance || typeof L === "undefined") return;
  const { map, kml } = worldMapInstance;
  const layers = kmlLayersState();
  const wanted = new Set(layers.map(l => l.id));

  // Anything on the map that state no longer knows about.
  [...kml.keys()].forEach(id => {
    if (!wanted.has(id)) { map.removeLayer(kml.get(id)); kml.delete(id); }
  });

  layers.forEach(layer => {
    let lyr = kml.get(layer.id);
    if (!lyr) {
      lyr = kmlLayerToLeaflet(L, layer);
      kml.set(layer.id, lyr);
    }
    const shouldShow = layer.visible !== false;
    if (shouldShow && !map.hasLayer(lyr)) lyr.addTo(lyr._map === map ? map : map);
    if (!shouldShow && map.hasLayer(lyr)) map.removeLayer(lyr);
  });

  if (fit) fitToKmlLayer(fit);
}

function fitToKmlLayer(id) {
  const lyr = worldMapInstance && worldMapInstance.kml.get(id);
  if (!lyr) return;
  try {
    const b = lyr.getBounds();
    if (b && b.isValid()) worldMapInstance.map.fitBounds(b, { padding: [40, 40], maxZoom: 12 });
  } catch (e) { /* a layer with no drawable geometry — leave the view alone */ }
}

/* ---------- the tab strip and the details list ---------- */

function renderKmlUI() {
  const tabs = document.getElementById("kmlTabs");
  const details = document.getElementById("kmlDetails");
  if (!tabs || !details) return;
  const layers = kmlLayersState();

  tabs.innerHTML = layers.map(l => {
    const active = l.id === state.reference.activeKmlLayer;
    const hidden = l.visible === false;
    return `<span class="kml-tab${active ? " active" : ""}${hidden ? " hidden-layer" : ""}">
      <button type="button" class="kml-open" onclick="selectKmlLayer('${l.id}')"
        title="${hidden ? "Hidden — click to show" : "Show details and zoom to this layer"}"
        style="border:0;background:transparent;cursor:pointer;font:inherit;color:inherit;padding:0">
        ${hidden ? "👁️‍🗨️ " : ""}${esc(l.name)} <span class="kml-count">${(l.features || []).length}</span>
      </button>
      <button type="button" class="kml-x" onclick="deleteKmlLayer('${l.id}')"
        title="Remove this file from the map" aria-label="Remove ${esc(l.name)}">✕</button>
    </span>`;
  }).join("");

  const active = layers.find(l => l.id === state.reference.activeKmlLayer);
  if (!layers.length) {
    details.innerHTML = `<p class="kml-empty">No map files yet — upload a .kml or .kmz from Google Earth or Google My Maps to see its places on the map.</p>`;
    return;
  }
  if (!active) {
    details.innerHTML = `<p class="kml-empty">${layers.length} file${layers.length > 1 ? "s" : ""} on the map. Pick one above to list what's inside it.</p>`;
    return;
  }

  const feats = active.features || [];
  const note = [active.fileName, feats.length + " feature" + (feats.length === 1 ? "" : "s"),
                active.description || ""].filter(Boolean).join(" · ");
  details.innerHTML = `
    <p class="kml-file-note">${esc(note)}</p>
    <div class="kml-list">
      ${feats.map((f, i) => {
        const p = (f && f.properties) || {};
        return `<button type="button" class="kml-item" onclick="flyToKmlFeature('${active.id}', ${i})">
          <span class="kml-kind">${featureKindLabel(f)}</span>
          <span>
            <h4>${esc(p.name || "Untitled")}</h4>
            ${p.folder ? `<span class="kml-folder">${esc(p.folder)}</span>` : ""}
            ${p.description ? `<p>${esc(p.description)}</p>` : ""}
          </span>
        </button>`;
      }).join("")}
    </div>`;
}

/* ---------- actions ---------- */

export async function uploadKmlFiles(input) {
  const files = [...(input.files || [])];
  input.value = ""; // so re-picking the same file still fires a change
  if (!files.length) return;
  if (!worldMapInstance) await initWorldMap();

  let added = 0, lastId = "";
  for (const file of files) {
    try {
      const text = await readKmlOrKmz(file);   // .kml, or the .kml inside a .kmz
      const parsed = parseKml(text);
      if (!parsed.features.length) { toast(`No places found in ${file.name}`); continue; }
      if (parsed.features.length > KML_MAX_FEATURES) {
        /* This data syncs with everything else, so one enormous file would
           slow every save on every device. Refused with the number, rather
           than silently truncating to something that looks complete. */
        toast(`${file.name} has ${parsed.features.length} features — too large to sync (limit ${KML_MAX_FEATURES})`);
        continue;
      }
      const layer = {
        id: uid(),
        name: parsed.name || file.name.replace(/\.(kml|kmz)$/i, ""),
        fileName: file.name,
        description: parsed.description || "",
        addedAt: Date.now(),
        visible: true,
        features: parsed.features,
      };
      kmlLayersState().push(layer);
      lastId = layer.id;
      added++;
    } catch (e) {
      toast(`Couldn't read ${file.name} — ${e.message}`);
    }
  }
  if (!added) return;
  state.reference.activeKmlLayer = lastId;
  persist();
  /* The list is drawn from state first and the map updated second, so the
     places are readable even when the map itself can't load — a blocked
     CDN or an offline device shouldn't cost you the contents of the file
     you just uploaded. */
  renderKmlUI();
  syncKmlLayers(lastId);   // draw it and zoom to it, if there is a map
  toast(added === 1 ? "Map layer added" : `${added} map layers added`);
}

/* Clicking the active tab again hides/shows the layer — the quickest way to
   compare two files without deleting either. */
export function selectKmlLayer(id) {
  const layer = kmlLayersState().find(l => l.id === id);
  if (!layer) return;
  if (state.reference.activeKmlLayer === id) {
    layer.visible = layer.visible === false;
  } else {
    state.reference.activeKmlLayer = id;
    layer.visible = true;
  }
  persist();
  renderKmlUI();
  syncKmlLayers(layer.visible !== false ? id : null);
}

export function deleteKmlLayer(id) {
  const layers = kmlLayersState();
  const i = layers.findIndex(l => l.id === id);
  if (i < 0) return;
  const [gone] = layers.splice(i, 1);
  if (state.reference.activeKmlLayer === id) state.reference.activeKmlLayer = "";
  /* Into Trash rather than deleted outright: a KML can represent real work
     (a survey route, a set of field stations) and re-uploading is not
     always possible from the device you noticed on. */
  try { moveToTrash("kmlLayer", gone, { name: gone.name }); } catch (e) { /* trash unavailable */ }
  persist();
  renderKmlUI();
  syncKmlLayers();
  toast(`Removed "${gone.name}" — it's in Trash`);
}

export function flyToKmlFeature(layerId, index) {
  const layer = kmlLayersState().find(l => l.id === layerId);
  if (!layer || !worldMapInstance) return;
  const feature = (layer.features || [])[index];
  const at = featureLatLng(feature);
  if (!at) return;
  worldMapInstance.map.setView(at, Math.max(worldMapInstance.map.getZoom(), 11), { animate: true });
  /* Open the matching popup, so clicking a row in the list and clicking the
     pin on the map do the same thing. */
  const lyr = worldMapInstance.kml.get(layerId);
  if (lyr) lyr.eachLayer(child => {
    if (child.feature === feature && child.openPopup) child.openPopup();
  });
}

/* Called after a sync replaces state, so layers added on another device
   appear without a reload. */
export function refreshKmlLayers() {
  renderKmlUI();
  if (worldMapInstance) syncKmlLayers();
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
