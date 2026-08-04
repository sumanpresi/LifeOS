/* On-demand loading for the heavy map libraries.

   Leaflet, Leaflet.draw, MapLibre GL and the MapLibre-Leaflet bridge come
   to roughly a megabyte, and every one of them was being fetched and
   parsed in the document <head> — before a single pixel of LifeOS could
   be drawn — on every page load, for every person, whether or not they
   ever opened a map. Maps appear on exactly two pages: the Reference
   world map and a travel stop's map.

   So they are loaded the first time a map is actually opened. The promise
   per URL is cached, which matters for two reasons: opening a second map
   must not fetch the same library again, and two maps opened at once must
   not race each other into loading it twice.

   `async = false` on an injected script is not a mistake — for scripts
   added this way it means "still execute these in the order I added
   them", which Leaflet.draw and the MapLibre bridge both depend on,
   since they attach themselves to an already-present L. */

const pending = {};

export function loadScript(src) {
  if (pending[src]) return pending[src];
  pending[src] = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.onload = resolve;
    el.onerror = () => { delete pending[src]; reject(new Error("Could not load " + src)); };
    document.head.appendChild(el);
  });
  return pending[src];
}

function loadStyle(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const el = document.createElement("link");
  el.rel = "stylesheet";
  el.href = href;
  document.head.appendChild(el);
}

let mapLibsPromise = null;
export function loadMapLibs() {
  if (mapLibsPromise) return mapLibsPromise;
  mapLibsPromise = (async () => {
    // Stylesheets first and unawaited: they don't gate the JS, and having
    // them in place avoids a flash of unstyled map controls.
    loadStyle("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
    loadStyle("https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css");
    loadStyle("https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css");
    // Sequential on purpose — each of these extends the one before it.
    await loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
    await loadScript("https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js");
    await loadScript("https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js");
    await loadScript("https://unpkg.com/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js");
  })().catch(err => {
    mapLibsPromise = null; // let a later attempt retry rather than failing forever
    throw err;
  });
  return mapLibsPromise;
}
