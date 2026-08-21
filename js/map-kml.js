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

/* ---------- .kmz ----------

   A KMZ is a ZIP holding a .kml (conventionally doc.kml) plus any images
   its styles reference. Unzipped here rather than with a library: the
   browser can already inflate a deflate stream, so all that is missing is
   reading the ZIP's own table of contents, which is about sixty lines.
   Avoiding a CDN dependency matters for this app in particular — the map
   libraries already fail to load on filtered networks, and an upload
   should not be the next thing that stops working. */

const ZIP_EOCD = 0x06054b50, ZIP_CENTRAL = 0x02014b50;

async function inflate(bytes, method) {
  if (method === 0) return bytes;                    // stored, not compressed
  if (method !== 8) throw new Error("Unsupported compression in that .kmz");
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't open .kmz files — unzip it and upload the .kml");
  }
  /* "deflate-raw" — the bare deflate stream a ZIP stores, without the zlib
     header that plain "deflate" expects. */
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Returns the text of the .kml inside a .kmz. */
async function readKmz(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  /* The central directory is found from the end: its locator is the last
     thing in the file, after a comment of unknown length, so it has to be
     scanned for backwards. */
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (view.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("That .kmz file looks damaged.");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);   // start of the central directory

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== ZIP_CENTRAL) break;
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localAt = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (compressed === 0xFFFFFFFF || localAt === 0xFFFFFFFF) {
      throw new Error("That .kmz is a ZIP64 archive, which isn't supported.");
    }
    entries.push({ name, method, compressed, localAt });
    p += 46 + nameLen + extraLen + commentLen;
  }

  /* doc.kml by convention, otherwise the first .kml anywhere in the
     archive — some exporters name it after the map. Directory entries and
     the __MACOSX noise a Mac adds are skipped. */
  const kmlEntries = entries.filter(e =>
    /\.kml$/i.test(e.name) && !e.name.startsWith("__MACOSX/") && !e.name.endsWith("/"));
  const entry = kmlEntries.find(e => /(^|\/)doc\.kml$/i.test(e.name)) || kmlEntries[0];
  if (!entry) throw new Error("No .kml found inside that .kmz");

  // The local header repeats the name/extra lengths, and they can differ
  // from the central directory's — the data starts after whatever IT says.
  const lNameLen = view.getUint16(entry.localAt + 26, true);
  const lExtraLen = view.getUint16(entry.localAt + 28, true);
  const start = entry.localAt + 30 + lNameLen + lExtraLen;
  const raw = bytes.subarray(start, start + entry.compressed);
  const out = await inflate(raw, entry.method);
  return new TextDecoder("utf-8").decode(out);
}

/* Reads either format and hands back KML text. A .kmz is recognised by its
   ZIP signature rather than its file extension, so a mis-named file still
   opens. */
export async function readKmlOrKmz(file) {
  const buffer = await file.arrayBuffer();
  const b = new Uint8Array(buffer);
  const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4B &&
                (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
  if (isZip) return readKmz(buffer);
  return new TextDecoder("utf-8").decode(b);
}

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
