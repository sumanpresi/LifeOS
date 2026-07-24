/* Sketch tools for Leaflet maps: freehand draw + a selective eraser — lets
   you draw with a finger, mouse, or stylus (Apple Pencil, Samsung S Pen)
   directly on the map, the same way you'd sketch on paper, and erase just
   the marks you drag over rather than clearing everything. Uses the
   browser's Pointer Events API, which reports mouse, touch, and pen input
   through one unified interface, so no device-specific code is needed.

   Strokes are added to the SAME Leaflet FeatureGroup as the shape-drawing
   tools (Leaflet.draw), so they save through the exact same GeoJSON
   persistence path already in place, and the eraser works on anything in
   that group — freehand strokes or Leaflet.draw shapes alike.

   Usage: attachFreehandTool(map, drawnItems, onChanged) */
export function attachFreehandTool(map, drawnItems, onChanged) {
  let mode = null; // null | "draw" | "erase"
  let currentStroke = null; // Leaflet polyline being drawn right now
  let points = [];
  let lastPoint = null;
  let erasedSomething = false;
  const MIN_DRAG_PX = 3;     // skip points closer together than this — keeps stroke data compact
  const ERASE_RADIUS_PX = 16; // how close the eraser needs to be to a mark to remove it

  const container = map.getContainer();
  let drawBtn = null, eraseBtn = null;

  function toLatLng(evt) {
    const rect = container.getBoundingClientRect();
    return map.containerPointToLatLng(
      L.point(evt.clientX - rect.left, evt.clientY - rect.top)
    );
  }
  function toScreenPoint(evt) {
    const rect = container.getBoundingClientRect();
    return L.point(evt.clientX - rect.left, evt.clientY - rect.top);
  }

  /* Points worth hit-testing a layer against, in the map's own container-
     pixel space — vertices for lines/shapes, the single point for markers
     and circles. Good enough to feel precise for freehand strokes (which
     are dense with points) without needing per-layer-type geometry math. */
  function layerScreenPoints(layer) {
    let latlngs = [];
    if (typeof layer.getLatLng === "function") latlngs = [layer.getLatLng()];
    else if (typeof layer.getLatLngs === "function") {
      const raw = layer.getLatLngs();
      const flatten = arr => arr.reduce((acc, v) => acc.concat(Array.isArray(v) ? flatten(v) : [v]), []);
      latlngs = flatten(raw);
    }
    return latlngs.map(ll => map.latLngToContainerPoint(ll));
  }
  function eraseNear(screenPt) {
    const layers = drawnItems.getLayers();
    for (const layer of layers) {
      const pts = layerScreenPoints(layer);
      for (const p of pts) {
        if (screenPt.distanceTo(p) <= ERASE_RADIUS_PX) {
          drawnItems.removeLayer(layer);
          erasedSomething = true;
          break;
        }
      }
    }
  }

  function onPointerDown(evt) {
    if (!mode) return;
    if (evt.target.closest && evt.target.closest(".leaflet-control")) return; // clicks on our own toolbar, not the map surface
    evt.preventDefault();
    try { container.setPointerCapture(evt.pointerId); } catch (e) { /* not fatal — interaction still works without capture */ }
    if (mode === "draw") {
      const ll = toLatLng(evt);
      points = [ll];
      lastPoint = evt;
      currentStroke = L.polyline([ll], { color: "#B3372C", weight: 3, opacity: 0.9, lineCap: "round", lineJoin: "round" }).addTo(map);
    } else if (mode === "erase") {
      erasedSomething = false;
      eraseNear(toScreenPoint(evt));
    }
  }
  function onPointerMove(evt) {
    if (!mode) return;
    evt.preventDefault();
    if (mode === "draw") {
      if (!currentStroke) return;
      if (lastPoint) {
        const dx = evt.clientX - lastPoint.clientX, dy = evt.clientY - lastPoint.clientY;
        if (Math.hypot(dx, dy) < MIN_DRAG_PX) return;
      }
      lastPoint = evt;
      points.push(toLatLng(evt));
      currentStroke.setLatLngs(points);
    } else if (mode === "erase") {
      eraseNear(toScreenPoint(evt));
    }
  }
  function onPointerUp(evt) {
    if (!mode) return;
    evt.preventDefault();
    if (mode === "draw") {
      if (!currentStroke) return;
      if (points.length > 1) {
        map.removeLayer(currentStroke); // remove the live-preview layer...
        const finalStroke = L.polyline(points, { color: "#B3372C", weight: 3, opacity: 0.9, lineCap: "round", lineJoin: "round" });
        drawnItems.addLayer(finalStroke); // ...and re-add it as a permanent member of the saved group
        if (onChanged) onChanged();
      } else {
        map.removeLayer(currentStroke); // a tap with no drag — nothing worth keeping
      }
      currentStroke = null; points = []; lastPoint = null;
    } else if (mode === "erase") {
      if (erasedSomething && onChanged) onChanged();
      erasedSomething = false;
    }
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerUp);

  function setMode(next) {
    mode = mode === next ? null : next; // clicking the active tool again turns it off
    container.classList.toggle("freehand-active", mode === "draw");
    container.classList.toggle("eraser-active", mode === "erase");
    if (drawBtn) drawBtn.classList.toggle("on", mode === "draw");
    if (eraseBtn) eraseBtn.classList.toggle("on", mode === "erase");
    if (mode) {
      map.dragging.disable();
      map.doubleClickZoom.disable();
      if (map.tap) map.tap.disable();
    } else {
      map.dragging.enable();
      map.doubleClickZoom.enable();
      if (map.tap) map.tap.enable();
    }
  }

  const SketchControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control freehand-toolbar");
      drawBtn = L.DomUtil.create("a", "freehand-btn", bar);
      drawBtn.href = "#"; drawBtn.title = "Freehand sketch — draw or write directly on the map";
      drawBtn.innerHTML = "✏️";
      L.DomEvent.on(drawBtn, "click", L.DomEvent.stop).on(drawBtn, "click", () => setMode("draw"));

      eraseBtn = L.DomUtil.create("a", "freehand-btn eraser-btn", bar);
      eraseBtn.href = "#"; eraseBtn.title = "Eraser — drag over a mark to remove just that one";
      eraseBtn.innerHTML = "🧹";
      L.DomEvent.on(eraseBtn, "click", L.DomEvent.stop).on(eraseBtn, "click", () => setMode("erase"));

      L.DomEvent.disableClickPropagation(bar);
      return bar;
    }
  });
  map.addControl(new SketchControl());

  return {
    destroy() {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
    }
  };
}
