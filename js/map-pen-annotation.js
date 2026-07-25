/* Map Pen Annotation — a SECOND, separate drawing tool from the existing
   freehand scribble tool (js/leaflet-freehand.js), which is untouched by
   this file. Where the scribble tool accepts any input (finger, mouse, or
   stylus) and disables map panning while active, this tool is different
   on purpose: it responds ONLY to a real stylus (pointerType === "pen"),
   and — critically — it must NOT disable map dragging/zoom while active,
   because finger and mouse need to keep panning/zooming the map at the
   exact same time a pen is annotating it. That's a genuinely different
   interaction model, not a copy of the existing tool's.

   Strokes are stored as geographic points (lat/lng), the same principle
   the scribble tool already uses, so annotations move and scale correctly
   as the map pans and zooms — never a fixed pixel-space canvas overlay.
   Each point also carries pressure and a timestamp, and each stroke is
   rendered as short pressure-weighted segments rather than one uniform
   line, so real stylus pressure actually shows up visually.

   Usage: attachPenAnnotationTool(map, getAnnotations, setAnnotations, onChanged)
   - getAnnotations(): returns the current {strokes:[...]} object
   - setAnnotations(next): persists a new {strokes:[...]} object
   - onChanged(): called after any change, for the caller to persist() */
export function attachPenAnnotationTool(map, getAnnotations, setAnnotations, onChanged) {
  let mode = null; // null | "draw" | "erase"
  let currentPoints = null; // points of the in-progress stroke
  let currentSegmentLayers = null; // Leaflet polylines drawn live, for the in-progress stroke
  let strokeLayers = new Map(); // strokeId -> [polyline, polyline, ...]
  let erasedSomething = false;
  const MIN_DRAG_PX = 2.5;

  const container = map.getContainer();
  let penBtn = null, eraseBtn = null, toolbar = null;

  const MIN_WIDTH = 1.5, MAX_WIDTH = 6.5; // px, at the extremes of pressure 0..1
  let strokeColor = "#2A6FB0";
  let strokeOpacity = 0.85;

  function toLatLng(evt) {
    const rect = container.getBoundingClientRect();
    return map.containerPointToLatLng(L.point(evt.clientX - rect.left, evt.clientY - rect.top));
  }
  function toScreenPoint(evt) {
    const rect = container.getBoundingClientRect();
    return L.point(evt.clientX - rect.left, evt.clientY - rect.top);
  }
  function widthForPressure(p) {
    // Some devices/browsers report 0 pressure for a non-pressure-sensitive
    // pen, or before enough contact registers — treat that as a sensible
    // mid-weight default rather than an invisible hairline.
    const pr = (typeof p === "number" && p > 0) ? p : 0.5;
    return MIN_WIDTH + pr * (MAX_WIDTH - MIN_WIDTH);
  }

  /* Renders one stroke as a chain of short segments, each weighted by that
     segment's own pressure — this is what actually makes pressure visible,
     since a single Leaflet polyline can only have one uniform width. */
  function renderStroke(stroke) {
    const layers = [];
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1], b = stroke.points[i];
      const w = widthForPressure((a.pressure + b.pressure) / 2) * (stroke.width || 1);
      const seg = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
        color: stroke.color || strokeColor, weight: w,
        opacity: stroke.opacity != null ? stroke.opacity : strokeOpacity,
        lineCap: "round", lineJoin: "round"
      }).addTo(map);
      layers.push(seg);
    }
    strokeLayers.set(stroke.id, layers);
  }
  function removeStrokeLayers(id) {
    const layers = strokeLayers.get(id);
    if (layers) layers.forEach(l => map.removeLayer(l));
    strokeLayers.delete(id);
  }
  function renderAll() {
    strokeLayers.forEach((layers) => layers.forEach(l => map.removeLayer(l)));
    strokeLayers.clear();
    (getAnnotations().strokes || []).forEach(renderStroke);
  }

  function eraseNear(screenPt) {
    const data = getAnnotations();
    const remaining = [];
    let removedAny = false;
    data.strokes.forEach(stroke => {
      const hit = stroke.points.some(pt => {
        const sp = map.latLngToContainerPoint([pt.lat, pt.lng]);
        return screenPt.distanceTo(sp) <= 16;
      });
      if (hit) { removeStrokeLayers(stroke.id); removedAny = true; }
      else remaining.push(stroke);
    });
    if (removedAny) { setAnnotations({ strokes: remaining }); erasedSomething = true; }
  }

  function onPointerDown(evt) {
    if (evt.pointerType !== "pen") return; // finger/mouse pass straight through to Leaflet's own pan/zoom — untouched
    if (!mode) return;
    if (evt.target.closest && evt.target.closest(".leaflet-control")) return;
    evt.preventDefault();
    try { container.setPointerCapture(evt.pointerId); } catch (e) {}
    if (mode === "draw") {
      const ll = toLatLng(evt);
      currentPoints = [{ lat: ll.lat, lng: ll.lng, pressure: evt.pressure, t: Date.now() }];
      currentSegmentLayers = [];
    } else if (mode === "erase") {
      erasedSomething = false;
      eraseNear(toScreenPoint(evt));
    }
  }
  function onPointerMove(evt) {
    if (evt.pointerType !== "pen") return;
    if (!mode) return;
    evt.preventDefault();
    if (mode === "draw") {
      if (!currentPoints) return;
      const last = currentPoints[currentPoints.length - 1];
      const lastScreen = map.latLngToContainerPoint([last.lat, last.lng]);
      const nowScreen = toScreenPoint(evt);
      if (lastScreen.distanceTo(nowScreen) < MIN_DRAG_PX) return;
      const ll = toLatLng(evt);
      const pt = { lat: ll.lat, lng: ll.lng, pressure: evt.pressure, t: Date.now() };
      const w = widthForPressure((last.pressure + pt.pressure) / 2);
      const seg = L.polyline([[last.lat, last.lng], [ll.lat, ll.lng]], {
        color: strokeColor, weight: w, opacity: strokeOpacity, lineCap: "round", lineJoin: "round"
      }).addTo(map);
      currentSegmentLayers.push(seg);
      currentPoints.push(pt);
    } else if (mode === "erase") {
      eraseNear(toScreenPoint(evt));
    }
  }
  function onPointerUp(evt) {
    if (evt.pointerType !== "pen") return;
    if (!mode) return;
    evt.preventDefault();
    if (mode === "draw") {
      if (!currentPoints) return;
      if (currentPoints.length > 1) {
        const id = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "s" + Date.now() + Math.random().toString(36).slice(2, 8);
        const stroke = { id, points: currentPoints, color: strokeColor, width: 1, opacity: strokeOpacity };
        strokeLayers.set(id, currentSegmentLayers); // keep the just-drawn segments, no need to redraw them
        const data = getAnnotations();
        setAnnotations({ strokes: data.strokes.concat([stroke]) });
        if (onChanged) onChanged();
      } else if (currentSegmentLayers) {
        currentSegmentLayers.forEach(l => map.removeLayer(l)); // a tap with no drag
      }
      currentPoints = null; currentSegmentLayers = null;
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
    mode = mode === next ? null : next;
    if (penBtn) penBtn.classList.toggle("on", mode === "draw");
    if (eraseBtn) eraseBtn.classList.toggle("on", mode === "erase");
    // Deliberately NOT touching map.dragging/doubleClickZoom/tap here —
    // finger and mouse must keep working normally the whole time this
    // tool is active. Only pen input is ever intercepted, above.
  }

  const PenControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      const bar = L.DomUtil.create("div", "leaflet-bar leaflet-control pen-annotation-toolbar");
      penBtn = L.DomUtil.create("a", "freehand-btn pen-annotation-btn", bar);
      penBtn.href = "#"; penBtn.title = "Pen annotation — stylus only (Apple Pencil, S Pen); finger and mouse still pan/zoom normally";
      penBtn.innerHTML = "🖊️";
      L.DomEvent.on(penBtn, "click", L.DomEvent.stop).on(penBtn, "click", () => setMode("draw"));

      eraseBtn = L.DomUtil.create("a", "freehand-btn pen-eraser-btn", bar);
      eraseBtn.href = "#"; eraseBtn.title = "Erase pen annotations — stylus only";
      eraseBtn.innerHTML = "🧽";
      L.DomEvent.on(eraseBtn, "click", L.DomEvent.stop).on(eraseBtn, "click", () => setMode("erase"));

      L.DomEvent.disableClickPropagation(bar);
      toolbar = bar;
      return bar;
    }
  });
  map.addControl(new PenControl());
  renderAll();

  return {
    setMode,
    destroy() {
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
      strokeLayers.forEach(layers => layers.forEach(l => map.removeLayer(l)));
      strokeLayers.clear();
    }
  };
}
