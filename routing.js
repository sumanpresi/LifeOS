/* Free, no-API-key driving routes and distances via OSRM's public demo
   server (router.project-osrm.org), sponsored by FOSSGIS. Same nature as
   the Nominatim geocoding already used elsewhere — a community-run best-
   effort service, not a commercial API with an uptime guarantee. Fine for
   a personal app's occasional route lookups (its usage policy asks for
   "reasonable, non-commercial use", which this is). */

/* coords are [lat, lng]. Returns {distanceKm, durationMin, geometry} where
   geometry is a GeoJSON LineString ([lng,lat] pairs), or null if no route
   could be found (or the service is unreachable). */
export async function getRoute(fromCoords, toCoords) {
  try {
    const url = "https://router.project-osrm.org/route/v1/driving/" +
      fromCoords[1] + "," + fromCoords[0] + ";" + toCoords[1] + "," + toCoords[0] +
      "?overview=full&geometries=geojson";
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes || !data.routes[0]) return null;
    const r = data.routes[0];
    return { distanceKm: r.distance / 1000, durationMin: r.duration / 60, geometry: r.geometry };
  } catch (e) { return null; }
}

export function formatDuration(mins) {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  if (h === 0) return m + " min";
  return m ? h + "h " + m + "m" : h + "h";
}
