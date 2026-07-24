/* Long-press (or click-and-hold) anywhere on a map to see that point's
   coordinates, in "lat, lng" format with 6 decimal places — shared by
   every Leaflet map in LifeOS (World Map, Travel Plan stop maps).

   This deliberately triggers on a hold, not a quick click/tap — a plain
   click is already used elsewhere on these maps (it's what activates
   scroll-wheel zoom), so having a simple click also pop up coordinates
   made every ordinary click feel cluttered and duplicated. A hold is a
   clear, distinct gesture that doesn't collide with anything else. */
import { toast } from './ui.js';

export function formatCoords(lat, lng) {
  return lat.toFixed(6) + ", " + lng.toFixed(6);
}

const HOLD_MS = 550;
const MOVE_CANCEL_PX = 8;

export function attachClickCoordinates(map) {
  const container = map.getContainer();
  let timer = null;
  let startPoint = null;

  function showPopup(latlng) {
    const text = formatCoords(latlng.lat, latlng.lng);
    L.popup()
      .setLatLng(latlng)
      .setContent(
        '<div class="coord-popup"><span>' + text + '</span>' +
        '<button onclick="copyCoordsToClipboard(\'' + text + '\')">Copy</button></div>'
      )
      .openOn(map);
  }

  function onPointerDown(e) {
    if (e.target.closest && e.target.closest(".leaflet-control")) return; // toolbar buttons, not the map surface
    startPoint = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      const rect = container.getBoundingClientRect();
      const latlng = map.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top));
      showPopup(latlng);
    }, HOLD_MS);
  }
  function onPointerMove(e) {
    if (!startPoint || !timer) return;
    if (Math.hypot(e.clientX - startPoint.x, e.clientY - startPoint.y) > MOVE_CANCEL_PX) {
      clearTimeout(timer); timer = null; // moved too much — a drag/draw, not a hold
    }
  }
  function onPointerUp() {
    clearTimeout(timer); timer = null; startPoint = null;
  }

  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerUp);

  return {
    destroy() {
      clearTimeout(timer);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerUp);
    }
  };
}

export function copyCoordsToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => toast("Coordinates copied"),
      () => toast("Couldn't copy — select and copy manually: " + text)
    );
  } else {
    toast("Copy not supported here — coordinates: " + text);
  }
}
