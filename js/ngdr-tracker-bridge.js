/* Bridge between the isolated NGDR Upload Tracker iframe
   (pages/ngdr-tracker.html) and LifeOS's shared state — same pattern as
   communication-bridge.js. The iframe keeps its own DOM/CSS/JS (it has a
   completely different visual design and a Chart.js dependency), but its
   DATA round-trips through state.js -> persist() -> Supabase. */
import { state, persist } from './state.js';

let iframeEl = null;

function sendInit() {
  if (!iframeEl || !iframeEl.contentWindow) return;
  iframeEl.contentWindow.postMessage({ type: "lifeos:ngdr:init", data: state.ngdrTracker }, "*");
}

export function initNgdrTrackerBridge() {
  iframeEl = document.querySelector("#page-work iframe.ngdr-tracker-frame");
  if (!iframeEl) return;

  window.addEventListener("message", e => {
    if (!iframeEl || e.source !== iframeEl.contentWindow) return;
    const msg = e.data || {};
    if (msg.type === "lifeos:ngdr:ready") {
      sendInit();
    } else if (msg.type === "lifeos:ngdr:save") {
      state.ngdrTracker = Array.isArray(msg.data) ? msg.data : [];
      persist();
    }
  });
}

/* Called by supabase.js after a remote pull / realtime update lands, so an
   already-open tracker tab picks up the freshest data immediately. */
export function pushNgdrTrackerUpdate() {
  sendInit();
}
