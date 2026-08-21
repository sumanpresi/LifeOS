/* ---------- KML on the world map ----------

   Reads a .kml file into plain GeoJSON so the rest of LifeOS never has to
   know what KML is: the parsed features go into state.reference.kmlLayers
   and therefore sync through persist() -> Supabase like everything else,
   and Leaflet draws them with the same L.geoJSON it already uses for the
   freehand drawings.

   Parsed here rather than with a library because the subset that matters —
   Placemark, Point, LineString, Polygon, MultiGeometry, Folder — is small,
   and a Google Earth export is exactly that subset. Anything outside it is
   skipped rather than throwing: a file with one unusual feature should
   still give you the other forty. */

/* KML coordinates are "lon,lat[,alt]" tuples separated by any whitespace —
   Google Earth writes them across many lines with generous indentation. */
function parseCoords(text) {
  return String(text || "").trim().split(/\s+/).map(tuple => {
    const [lon, lat] = tuple.split(",").map(Number);
    return (Number.isFinite(lon) && Number.isFinite(lat)) ? [lon, lat] : null;
  }).filter(Boolean);
}

function textOf(node, tag) {
  const el = node.getElementsByTagName(tag)[0];
  return el ? (el.textContent || "").trim() : "";
}

/* A Placemark can hold several geometries at once (MultiGeometry). Each
   becomes its own GeoJSON feature carrying the same name/description, which
   keeps the details list readable — one row per thing you can click. */
function geometriesOf(placemark) {
  const out = [];

  [...placemark.getElementsByTagName("Point")].forEach(p => {
    const c = parseCoords(textOf(p, "coordinates"));
    if (c.length) out.push({ type: "Point", coordinates: c[0] });
  });

  [...placemark.getElementsByTagName("LineString")].forEach(l => {
    const c = parseCoords(textOf(l, "coordinates"));
    if (c.length > 1) out.push({ type: "LineString", coordinates: c });
  });

  [...placemark.getElementsByTagName("Polygon")].forEach(poly => {
    const rings = [];
    const outer = poly.getElementsByTagName("outerBoundaryIs")[0];
    if (outer) {
      const c = parseCoords(textOf(outer, "coordinates"));
      if (c.length > 2) rings.push(closeRing(c));
    }
    [...poly.getElementsByTagName("innerBoundaryIs")].forEach(inner => {
      const c = parseCoords(textOf(inner, "coordinates"));
      if (c.length > 2) rings.push(closeRing(c));
    });
    if (rings.length) out.push({ type: "Polygon", coordinates: rings });
  });

  return out;
}
/* GeoJSON requires a ring's last point to repeat its first; KML does not
   always bother. Leaflet copes either way, but the stored data should be
   valid GeoJSON in case anything else ever reads it. */
function closeRing(ring) {
  const a = ring[0], b = ring[ring.length - 1];
  return (a[0] === b[0] && a[1] === b[1]) ? ring : [...ring, a];
}

export function parseKml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("That doesn't look like a valid KML file.");
  }
  if (!doc.getElementsByTagName("kml").length && !doc.getElementsByTagName("Document").length) {
    throw new Error("No KML content found in that file.");
  }

  const docNode = doc.getElementsByTagName("Document")[0] || doc.documentElement;
  const features = [];

  [...doc.getElementsByTagName("Placemark")].forEach(pm => {
    /* The enclosing Folder's name, when there is one — Google Earth uses
       folders as groups, and showing that grouping makes a long list far
       easier to read. */
    let folder = "";
    for (let n = pm.parentNode; n && n.nodeType === 1; n = n.parentNode) {
      if (n.nodeName === "Folder") { folder = textOf(n, "name"); break; }
    }
    const name = textOf(pm, "name");
    const description = stripTags(textOf(pm, "description"));
    geometriesOf(pm).forEach(geometry => {
      features.push({ type: "Feature", geometry,
        properties: { name, description, folder } });
    });
  });

  return {
    name: textOf(docNode, "name") || "",
    description: stripTags(textOf(docNode, "description")),
    features,
  };
}

/* KML descriptions routinely contain HTML (Google Earth writes whole
   tables in there). It is shown as plain text — this is a details list,
   not a browser, and injecting a file's markup into the page would hand
   any downloaded .kml a script tag. */
function stripTags(html) {
  if (!html) return "";
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent || "").replace(/\s+/g, " ").trim();
}

/* ---------- drawing ---------- */

export function kmlLayerToLeaflet(L, layer, onFeatureClick) {
  return L.geoJSON({ type: "FeatureCollection", features: layer.features || [] }, {
    pointToLayer: (feature, latlng) => L.marker(latlng),
    style: () => ({ color: layer.color || "#B9714A", weight: 3, opacity: .9, fillOpacity: .18 }),
    onEachFeature: (feature, lyr) => {
      const p = (feature && feature.properties) || {};
      const title = p.name || "Untitled place";
      /* Built with the DOM rather than an HTML string, so a name or
         description from the file can never become markup. */
      const box = document.createElement("div");
      box.className = "kml-popup";
      const h = document.createElement("strong");
      h.textContent = title;
      box.appendChild(h);
      if (p.description) {
        const d = document.createElement("p");
        d.textContent = p.description;
        box.appendChild(d);
      }
      lyr.bindPopup(box);
      if (onFeatureClick) lyr.on("click", () => onFeatureClick(feature));
    }
  });
}

/* Where a feature sits, for the "fly to it" behaviour in the details list. */
export function featureLatLng(feature) {
  const g = feature && feature.geometry;
  if (!g) return null;
  if (g.type === "Point") return [g.coordinates[1], g.coordinates[0]];
  const flat = g.type === "Polygon" ? g.coordinates[0] : g.coordinates;
  if (!flat || !flat.length) return null;
  const mid = flat[Math.floor(flat.length / 2)];
  return [mid[1], mid[0]];
}

export function featureKindLabel(feature) {
  const t = feature && feature.geometry && feature.geometry.type;
  if (t === "Point") return "Place";
  if (t === "LineString") return "Path";
  if (t === "Polygon") return "Area";
  return "Feature";
}
