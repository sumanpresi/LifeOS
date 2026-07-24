/* Click (or tap) anywhere on a map to see that point's coordinates, in
   "lat, lng" format with 6 decimal places — shared by every Leaflet map
   in LifeOS (World Map, Travel Plan stop maps). */
import { toast } from './ui.js';

export function formatCoords(lat, lng) {
  return lat.toFixed(6) + ", " + lng.toFixed(6);
}

export function attachClickCoordinates(map) {
  function onClick(e) {
    const text = formatCoords(e.latlng.lat, e.latlng.lng);
    L.popup()
      .setLatLng(e.latlng)
      .setContent(
        '<div class="coord-popup"><span>' + text + '</span>' +
        '<button onclick="copyCoordsToClipboard(\'' + text + '\')">Copy</button></div>'
      )
      .openOn(map);
  }
  map.on("click", onClick);
  return { destroy() { map.off("click", onClick); } };
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
