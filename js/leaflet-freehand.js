/* A freehand sketch/write tool for Leaflet maps — lets you draw with a
   finger, mouse, or stylus (Apple Pencil, Samsung S Pen) directly on the
   map, the same way you'd sketch on paper. Uses the browser's Pointer
   Events API, which reports mouse, touch, and pen input through one
   unified interface, so no device-specific code is needed.

   Strokes are added to the SAME Leaflet FeatureGroup as the shape-drawing
   tools (Leaflet.draw), so they save through the exact same GeoJSON
   persistence path already in place, and are editable/deletable with
   Leaflet.draw's normal edit toolbar (each stroke is just a polyline).

   Usage: attachFreehandTool(map, drawnItems, onStrokeSaved) */
export function attachFreehandTool(map, drawnItems, onStrokeSaved) {
  let active = false;
  let currentStroke = null; // Leaflet polyline being drawn right now
  let points = [];
  let lastPoint = null;
  const MIN_DRAG_PX = 3; // skip points closer together than this — keeps stroke data compact

  const container = map.getContainer();

  function toLatLng(evt) {
    const rect = container.getBoundingClientRect();
    return map.containerPointToLatLng(
      L.point(evt.clientX - rect.left, evt.clientY - rect.top)
    );
  }

  function onPointerDown(evt) {
    if (!active) return;
    evt.preventDefault();
    container.setPointerCapture(evt.pointerId);
    const ll = toLatLng(evt);
    points = [ll];
    lastPoint = evt;
    currentStroke = L.polyline([ll], { color: "#B3372C", weight: 3, opacity: 0.9, lineCap: "round", lineJoin: "round" }).addTo(map);
  }
  function onPointerMove(evt) {
    if (!active || !currentStroke) return;
    evt.preventDefault();
    if (lastPoint) {
      const dx = evt.clientX - lastPoint.clientX, dy = evt.clientY - lastPoint.clientY;
      if (Math.hypot(dx, dy) < MIN_DRAG_PX) return;
    }
    lastPoint = evt;
    points.push(toLatLng(evt));
    currentStroke.setLatLngs(points);
  }
  function onPointerUp(evt) {
    if (!active || !currentStroke) return;
    evt.preventDefault();
    if (points.length > 1) {
      map.removeLayer(currentStroke); // remove the live-preview layer...
      const finalStroke = L.polyline(points, { color: "#B3372C", weight: 3, opacity: 0.9, lineCap: "round", lineJoin: "round" });
      drawnItems.addLayer(finalStroke); // ...and re-add it as a permanent member of the saved group
      if (onStrokeSaved) onStrokeSaved();
    } else {
      map.removeLayer(currentStroke); // a tap with no drag — nothing worth keeping
    }
    currentStroke = null; points = []; lastPoint = null;
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerUp);

  function setActive(on) {
    active = on;
    container.classList.toggle("freehand-active", on);
    if (on) {
      map.dragging.disable();
      map.doubleClickZoom.disable();
      if (map.tap) map.tap.disable();
    } else {
      map.dragging.enable();
      map.doubleClickZoom.enable();
      if (map.tap) map.tap.enable();
    }
  }

  const FreehandControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control freehand-toolbar");
      const btn = L.DomUtil.create("a", "freehand-btn", bar);
      btn.href = "#"; btn.title = "Freehand sketch — draw or write directly on the map";
      btn.innerHTML = "✏️";
      L.DomEvent.on(btn, "click", L.DomEvent.stop).on(btn, "click", () => {
        setActive(!active);
        btn.classList.toggle("on", active);
      });
      L.DomEvent.disableClickPropagation(bar);
      return bar;
    }
  });
  map.addControl(new FreehandControl());

  return {
    destroy() {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
    }
  };
}
