/* Widget layout: long-press a card's header to drag it anywhere on the
   page; drag its corner handle to resize it. Deliberately does NOT
   restructure any page's HTML (no wrapping every card in a grid
   library's container) — cards stay exactly where they already are in
   the DOM. A card only leaves normal document flow the first time it's
   actually dragged or resized, at which point it's measured in place
   and switched to an explicit px position/size (.wl-positioned); every
   card nobody has touched still renders exactly as it always has.

   Desktop-only. An absolute px layout doesn't survive a viewport-width
   change the way normal flow does — a card positioned for a 1400px
   screen would overlap or run off-screen at 400px — so phones always
   fall back to the standard stacked layout regardless of any saved
   customization (see the max-width:900px override in style.css, which
   is the actual enforcement; the width checks here just avoid arming a
   drag/resize that CSS would immediately undo).

   Content resize is handled by letting each card be a normal block
   element at a new width/height — text and flex/grid children reflow
   the same way they would if you resized a browser window, rather than
   being visually stretched. If content doesn't fit a shrunk card, it
   scrolls internally (.wl-positioned sets overflow:auto) instead of
   being clipped or distorted. One known tradeoff: a few cards have
   their own popovers/date-pickers that rely on overflow:visible to
   escape the card's box — those can get visually clipped once their
   card has been resized. Not solved here; flagged for awareness. */
import { state, persist, rerender } from './state.js';

const LONG_PRESS_MS = 450;
const JITTER_PX = 8;
const MIN_W = 220, MIN_H = 120;
const DESKTOP_BREAKPOINT = 900;

function bucketFor(pageId) {
  state.layouts = state.layouts || {};
  state.layouts[pageId] = state.layouts[pageId] || {};
  return state.layouts[pageId];
}
function keyFor(card, pageId, index) {
  if (!card.dataset.wlKey) card.dataset.wlKey = card.id || (pageId + "-c" + index);
  return card.dataset.wlKey;
}
function isInteractive(el) {
  return !!el.closest("input,textarea,select,button,a,.icon-btn,.expand-btn,.wb-tab,.seg button,.wl-resize-handle");
}
function rectRelativeToPage(card, page) {
  const c = card.getBoundingClientRect();
  const p = page.getBoundingClientRect();
  return { x: c.left - p.left + page.scrollLeft, y: c.top - p.top + page.scrollTop, w: c.width, h: c.height };
}
function freezeInPlace(card, page) {
  if (card.classList.contains("wl-positioned")) return;
  const r = rectRelativeToPage(card, page);
  card.classList.add("wl-positioned");
  card.style.left = r.x + "px"; card.style.top = r.y + "px";
  card.style.width = r.w + "px"; card.style.height = r.h + "px";
}
function saveLayout(card, pageId, key) {
  bucketFor(pageId)[key] = {
    x: parseFloat(card.style.left) || 0, y: parseFloat(card.style.top) || 0,
    w: card.offsetWidth, h: card.offsetHeight
  };
  persist();
}
function ensureResizeHandle(card) {
  let h = card.querySelector(":scope > .wl-resize-handle");
  if (h) return h;
  h = document.createElement("div");
  h.className = "wl-resize-handle";
  h.title = "Drag to resize";
  h.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v6h-6M21 21 10 10"/></svg>`;
  card.appendChild(h);
  return h;
}

function wireDrag(card, page, pageId, key) {
  const head = card.querySelector(":scope > .card-head");
  if (!head || head.dataset.wlWired) return;
  head.dataset.wlWired = "1";

  let pressTimer = null, armed = false, moved = false;
  let startX = 0, startY = 0, originLeft = 0, originTop = 0;
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };

  head.addEventListener("pointerdown", (evt) => {
    if (window.innerWidth <= DESKTOP_BREAKPOINT) return;
    if (isInteractive(evt.target)) return; // let normal clicks/typing through untouched
    if (evt.button !== undefined && evt.button !== 0) return; // left click / primary touch only
    startX = evt.clientX; startY = evt.clientY; moved = false;
    pressTimer = setTimeout(() => {
      armed = true;
      freezeInPlace(card, page);
      originLeft = parseFloat(card.style.left) || 0;
      originTop = parseFloat(card.style.top) || 0;
      card.classList.add("wl-dragging");
      try { head.setPointerCapture(evt.pointerId); } catch (e) {}
    }, LONG_PRESS_MS);
  });
  head.addEventListener("pointermove", (evt) => {
    if (!pressTimer && !armed) return;
    const dx = evt.clientX - startX, dy = evt.clientY - startY;
    if (!armed) {
      // Real scroll/drag intent showed up before the hold fired — this
      // wasn't a long press, so back off and let the page scroll.
      if (Math.abs(dx) > JITTER_PX || Math.abs(dy) > JITTER_PX) cancelPress();
      return;
    }
    moved = true;
    card.style.left = (originLeft + dx) + "px";
    card.style.top = (originTop + dy) + "px";
  });
  const finish = (evt) => {
    cancelPress();
    if (armed) {
      card.classList.remove("wl-dragging");
      try { head.releasePointerCapture(evt.pointerId); } catch (e) {}
      if (moved) saveLayout(card, pageId, key);
    }
    armed = false; moved = false;
  };
  head.addEventListener("pointerup", finish);
  head.addEventListener("pointercancel", finish);
  // Quick recovery — double-click/double-tap the header sends this one
  // widget back to its normal flow position, no confirmation needed
  // since it's a two-second redo, not a destructive action.
  head.addEventListener("dblclick", (evt) => {
    if (isInteractive(evt.target)) return;
    delete bucketFor(pageId)[key];
    persist();
    card.classList.remove("wl-positioned");
    card.style.left = card.style.top = card.style.width = card.style.height = "";
  });
}

function wireResize(card, page, pageId, key) {
  const handle = ensureResizeHandle(card);
  if (handle.dataset.wlWired) return;
  handle.dataset.wlWired = "1";

  let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
  handle.addEventListener("pointerdown", (evt) => {
    if (window.innerWidth <= DESKTOP_BREAKPOINT) return;
    evt.stopPropagation();
    resizing = true;
    freezeInPlace(card, page);
    startX = evt.clientX; startY = evt.clientY;
    startW = card.offsetWidth; startH = card.offsetHeight;
    card.classList.add("wl-resizing");
    try { handle.setPointerCapture(evt.pointerId); } catch (e) {}
  });
  handle.addEventListener("pointermove", (evt) => {
    if (!resizing) return;
    card.style.width = Math.max(MIN_W, startW + (evt.clientX - startX)) + "px";
    card.style.height = Math.max(MIN_H, startH + (evt.clientY - startY)) + "px";
  });
  const finish = (evt) => {
    if (!resizing) return;
    resizing = false;
    card.classList.remove("wl-resizing");
    try { handle.releasePointerCapture(evt.pointerId); } catch (e) {}
    saveLayout(card, pageId, key);
    // Whiteboard canvases already watch their own wrapper with a
    // ResizeObserver (see whiteboard.js) and pick this up on their
    // own. Maps (Leaflet/MapLibre) don't observe anything — nudge them
    // the same way a real window resize would, which each map library
    // already listens for.
    window.dispatchEvent(new Event("resize"));
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

/* Called once a page becomes visible (see go() in ui.js) — wires every
   .card on it (including ones nested one level inside a .grid-2/.grid-3
   layout wrapper) and re-applies any saved position/size. Wiring is
   idempotent (dataset.wlWired guards) so calling this again on the same
   page, e.g. after a re-render replaced some inner HTML, is harmless
   and just re-applies saved layouts to any new card elements. */
export function initPageLayout(pageId) {
  const page = document.getElementById("page-" + pageId);
  if (!page) return;
  const bucket = (state.layouts && state.layouts[pageId]) || {};
  const cards = page.querySelectorAll(":scope > .card, :scope > .grid-2 > .card, :scope > .grid-3 > .card");
  cards.forEach((card, i) => {
    const key = keyFor(card, pageId, i);
    const saved = bucket[key];
    if (saved && !card.classList.contains("wl-positioned")) {
      card.classList.add("wl-positioned");
      card.style.left = saved.x + "px"; card.style.top = saved.y + "px";
      card.style.width = saved.w + "px"; card.style.height = saved.h + "px";
    }
    wireDrag(card, page, pageId, key);
    wireResize(card, page, pageId, key);
  });
}

// Reset every widget on a page back to normal flow — the escape hatch
// if a page's customization gets into a state someone wants to back
// out of entirely, rather than fixing cards one at a time.
export function resetPageLayout(pageId) {
  if (state.layouts) delete state.layouts[pageId];
  persist();
  const page = document.getElementById("page-" + pageId);
  if (page) {
    page.querySelectorAll(".card.wl-positioned").forEach(card => {
      card.classList.remove("wl-positioned");
      card.style.left = card.style.top = card.style.width = card.style.height = "";
    });
  }
}
