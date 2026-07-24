/* Shared free geocoding (OpenStreetMap's Nominatim, no API key needed) used
   by both Travel Plan's per-stop "locate" buttons and the World Map's
   location search. See travel.js for the fuller history/rationale — this
   is just the underlying lookup, extracted so both modules can share it. */

export async function geocodeOne(query) {
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
