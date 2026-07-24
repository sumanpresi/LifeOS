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
