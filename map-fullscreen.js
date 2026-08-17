/* A true fullscreen toggle for maps, using the browser's native Fullscreen
   API — genuinely more screen space than the "view large" modal used
   elsewhere, which matters most for maps specifically (more room to pan,
   zoom, and draw precisely).

   Cross-platform notes, since support has a real history of unevenness:
   desktop browsers and Android have supported fullscreening an arbitrary
   element (not just <video>) for years; iOS Safari didn't for a long
   time, but current iOS/iPadOS versions do. Rather than gamble on exactly
   which OS version a given device is running, this checks for support at
   call time and falls back to the existing "view large" modal — which
   works everywhere unconditionally — if the native API isn't there or
   the browser refuses the request for any reason. Fullscreen is a bonus
   when available, never a requirement. */
import { expandView } from './expand-view.js';

function getRequestFullscreen(el) {
  return el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen || null;
}
function getExitFullscreen() {
  return document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen || null;
}
function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
}

/* map: the Leaflet instance. Its own container element (which already has
   a unique id, e.g. "worldMap" or "leafletMap-<stopId>") is both the
   thing that goes fullscreen and the fallback target for "view large" if
   fullscreen isn't available. */
export function addFullscreenControl(map, title) {
  const container = map.getContainer();
  const btn = document.createElement("button");
  btn.className = "map-fullscreen-btn";
  btn.type = "button";
  btn.title = "View full screen";
  btn.innerHTML = "⛶";
  btn.onclick = (e) => { e.stopPropagation(); toggleFullscreen(); };
  container.appendChild(btn);

  function useModalFallback() {
    expandView(container.id, title || "");
    setTimeout(() => map.invalidateSize(), 60);
  }

  function toggleFullscreen() {
    const reqFs = getRequestFullscreen(container);
    if (!reqFs) { useModalFallback(); return; } // no native support at all — use the modal instead

    if (getFullscreenElement() === container) {
      const exitFs = getExitFullscreen();
      if (exitFs) exitFs.call(document);
      return;
    }
    try {
      const result = reqFs.call(container);
      // Some older/partial implementations don't return a Promise, or
      // silently no-op instead of throwing — invalidateSize() still runs
      // via the fullscreenchange listener below when it actually works;
      // if it doesn't, nothing bad happens, the map just stays as-is.
      if (result && typeof result.catch === "function") {
        result.catch(useModalFallback); // request was refused — fall back
      }
    } catch (e) {
      useModalFallback();
    }
  }

  ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(evt => {
    document.addEventListener(evt, () => {
      btn.classList.toggle("on", getFullscreenElement() === container);
      setTimeout(() => map.invalidateSize(), 60); // let the browser finish resizing first
    });
  });
}
