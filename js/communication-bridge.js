/* Bridge between the isolated Communication iframe (pages/communication.html)
   and LifeOS's shared state. The iframe keeps its own DOM/CSS/JS (avoids id
   and class clashes — both apps use names like .card, .btn, #toast), but its
   DATA now round-trips through state.js -> persist() -> Supabase, exactly
   like every other module. */
import { state, persist, rerender } from './state.js';

let iframeEl = null;

function sendInit() {
  if (!iframeEl || !iframeEl.contentWindow) return;
  iframeEl.contentWindow.postMessage({ type: "lifeos:comm:init", data: state.communication }, "*");
}

export function initCommunicationBridge() {
  iframeEl = document.querySelector("#page-communication iframe");
  if (!iframeEl) return;

  window.addEventListener("message", e => {
    // Only accept messages from our own Communication iframe.
    if (!iframeEl || e.source !== iframeEl.contentWindow) return;
    const msg = e.data || {};
    if (msg.type === "lifeos:comm:ready") {
      sendInit();
    } else if (msg.type === "lifeos:comm:save") {
      state.communication = msg.data;
      persist();               // localStorage + scheduled Supabase push, same as every other module
    }
  });
}

/* Called by supabase.js after a remote pull / realtime update lands, so an
   already-open Communication tab picks up the freshest data immediately
   instead of waiting for a manual reload. */
export function pushCommunicationUpdate() {
  sendInit();
}
