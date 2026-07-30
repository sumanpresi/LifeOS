/* Shared base-map layer for every Leaflet map in LifeOS. Uses OpenFreeMap's
   free, unrestricted vector tiles (via the official MapLibre GL Leaflet
   binding) instead of the plain OpenStreetMap raster tiles, because its
   "liberty" style already has real language handling built into every
   label — it prefers an English name where OSM has one, and automatically
   shows a Latin-script transliteration alongside non-Latin scripts (so a
   place in, say, Russia shows readable Latin text instead of only
   Cyrillic). No API key, no billing, no per-domain restriction — unlike
   Wikimedia's map tiles (Wikimedia-affiliated sites only) or Google/
   Mapbox's full APIs.

   If MapLibre GL fails to load for any reason (slow network, blocked
   script), this falls back to the plain OpenStreetMap raster tiles, so
   the map — and the drawing tools on it — still work either way, just
   without the language handling. */
export function addBaseLayer(map) {
  if (typeof L.maplibreGL === "function") {
    try {
      L.maplibreGL({ style: "https://tiles.openfreemap.org/styles/liberty" }).addTo(map);
      return;
    } catch (e) { /* fall through to the raster fallback below */ }
  }
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
}

/* Scroll-wheel zoom is on by default in Leaflet, which means simply
   scrolling down a page that happens to pass the mouse over an embedded
   map hijacks that scroll into a zoom instead — a common, disorienting
   problem with any inline interactive map. The standard fix: require a
   click on the map first (a clear signal of intent to interact with it)
   before scroll-wheel zoom activates, and turn it back off once the
   pointer leaves, so scrolling the rest of the page is unaffected again. */
export function enableClickToScrollZoom(map) {
  try {
    if (!map.scrollWheelZoom) return; // extra safety net — this is a core, always-present Leaflet handler, but a broken map is worse than a missing convenience feature
    map.scrollWheelZoom.disable();
    const container = map.getContainer();
    container.addEventListener("click", () => map.scrollWheelZoom.enable());
    container.addEventListener("mouseleave", () => map.scrollWheelZoom.disable());
  } catch (e) { /* the map itself must still work even if this convenience feature can't be wired up */ }
}
