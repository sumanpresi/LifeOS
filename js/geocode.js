/* Shared free geocoding (OpenStreetMap's Nominatim, no API key needed) used
   by both Travel Plan's per-stop "locate" buttons and the World Map's
   location search. See travel.js for the fuller history/rationale — this
   is just the underlying lookup, extracted so both modules can share it. */

/* If the text is already a "lat, lng" pair (e.g. "22.579617, 88.434900"),
   parse it directly instead of sending it out to be geocoded — lets every
   search box double as a coordinate jump-to box. Returns [lat, lng] or
   null if the text doesn't look like a coordinate pair. */
export function parseCoordinates(text) {
  if (!text) return null;
  const m = text.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

export async function geocodeOne(query) {
  const coords = parseCoordinates(query);
  if (coords) return { coords, label: coords[0].toFixed(6) + ", " + coords[1].toFixed(6) };
  if (!query || !query.trim()) return null;
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&email=lifeos.app%40example.com&q=" + encodeURIComponent(query);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data[0]) return { coords: [parseFloat(data[0].lat), parseFloat(data[0].lon)], label: data[0].display_name || query };
  } catch (e) { /* network error, timeout, or the free geocoder is temporarily unavailable */ }
  return null;
}
