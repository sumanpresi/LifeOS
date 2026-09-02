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
import { state, persist } from './state.js?v=202609041200';
import { toast } from './ui.js?v=202609041200';

const LONG_PRESS_MS = 450;     // touch/pen — needs to be long enough to not steal a scroll gesture
const MOUSE_PRESS_MS = 150;    // mouse — no scroll-gesture ambiguity to protect against, so this can be snappy
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
function rowMates(card) {
  // Explicit grouping wins when present — two cards can be marked as a
  // set (data-wl-group="same-value") even when they're not adjacent in
  // the DOM, e.g. GSI/Personal Workspace's "links" card and their
  // project tracker card, which have a page title and tab bar between
  // them and so aren't row-mates in the grid-2/3 sense below.
  const group = card.dataset.wlGroup;
  if (group) {
    const page = card.closest(".page");
    if (page) return Array.from(page.querySelectorAll(`.card[data-wl-group="${group}"]`));
  }
  const parent = card.parentElement;
  if (parent && (parent.classList.contains("grid-2") || parent.classList.contains("grid-3"))) {
    return Array.from(parent.querySelectorAll(":scope > .card"));
  }
  return [card];
}
function allPageCards(page) {
  return Array.from(page.querySelectorAll(":scope > .card, :scope > .grid-2 > .card, :scope > .grid-3 > .card"));
}
function freezeInPlace(card, page, pageId) {
  if (card.classList.contains("wl-positioned")) return;
  // Measure EVERY card on the page first, before touching any of their
  // layout. This isn't just about grid-2/3 row-mates or explicitly
  // linked pairs — any single card leaving normal document flow causes
  // every later sibling in that flow to shift up and fill the gap,
  // whether they're side-by-side in a row or simply stacked full-width
  // below it (the far more common case). A card frozen alone would
  // still visually sit exactly where it was, while its now-reflowed
  // next sibling slides up into that same spot — same overlap bug,
  // just vertical instead of horizontal. Freezing the whole page at
  // once, atomically, is the only way nothing ever reflows out from
  // under anything.
  const cards = allPageCards(page);
  const rects = cards.map(c => rectRelativeToPage(c, page));
  const bucket = bucketFor(pageId);
  cards.forEach((c, i) => {
    if (c.classList.contains("wl-positioned")) return;
    const r = rects[i];
    c.classList.add("wl-positioned");
    c.style.left = r.x + "px"; c.style.top = r.y + "px";
    c.style.width = r.w + "px"; c.style.height = r.h + "px";
    // Every card needs its own saved entry now, not just the one being
    // actively dragged/resized — otherwise an untouched card that was
    // only silently frozen would have no saved layout, revert to flow
    // on the next page load, and recreate this exact overlap the
    // moment it did.
    if (c.dataset.wlKey) bucket[c.dataset.wlKey] = { x: r.x, y: r.y, w: r.w, h: r.h };
  });
  persist();
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

  let pressTimer = null, armed = false, moved = false, activePointerId = null;
  let startX = 0, startY = 0;
  // Only an explicit data-wl-group travels together as a unit during
  // the drag itself — grid-2/3 row-mates are just two cards that
  // happen to share a row; freezing them together (see freezeInPlace)
  // is enough to stop them overlapping, but they don't need to move
  // in lockstep the way an intentionally-linked pair does.
  let moveGroup = [card], origins = [];
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; card.classList.remove("wl-pressing"); };

  const onMove = (evt) => {
    if (activePointerId !== null && evt.pointerId !== activePointerId) return;
    const dx = evt.clientX - startX, dy = evt.clientY - startY;
    if (!armed) {
      // Real scroll/drag intent showed up before the hold fired — this
      // wasn't a long press, so back off and let the page scroll.
      if (Math.abs(dx) > JITTER_PX || Math.abs(dy) > JITTER_PX) cancelPress();
      return;
    }
    evt.preventDefault(); // once armed, this is our drag — don't also let the browser select text or start a native drag-image
    moved = true;
    moveGroup.forEach((c, i) => {
      c.style.left = (origins[i].left + dx) + "px";
      c.style.top = (origins[i].top + dy) + "px";
    });
  };
  const onUp = (evt) => {
    if (activePointerId !== null && evt.pointerId !== activePointerId) return;
    cancelPress();
    if (armed) {
      card.classList.remove("wl-dragging");
      moveGroup.forEach(c => c.classList.remove("wl-dragging"));
      if (moved) moveGroup.forEach(c => saveLayout(c, pageId, c.dataset.wlKey));
    }
    armed = false; moved = false; activePointerId = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };

  head.addEventListener("pointerdown", (evt) => {
    if (window.innerWidth <= DESKTOP_BREAKPOINT) return;
    if (isInteractive(evt.target)) return; // let normal clicks/typing through untouched
    if (evt.button !== undefined && evt.button !== 0) return; // left click / primary touch only
    startX = evt.clientX; startY = evt.clientY; moved = false;
    activePointerId = evt.pointerId;
    card.classList.add("wl-pressing"); // immediate feedback that the press registered, even before the hold threshold elapses
    // Tracked on window rather than just this header from here on, so
    // a fast drag that immediately leaves the header's small bounding
    // box still keeps receiving move/up events reliably.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    const delay = evt.pointerType === "mouse" ? MOUSE_PRESS_MS : LONG_PRESS_MS;
    pressTimer = setTimeout(() => {
      armed = true;
      card.classList.remove("wl-pressing");
      freezeInPlace(card, page, pageId);
      moveGroup = card.dataset.wlGroup ? rowMates(card) : [card];
      origins = moveGroup.map(c => ({ left: parseFloat(c.style.left) || 0, top: parseFloat(c.style.top) || 0 }));
      moveGroup.forEach(c => c.classList.add("wl-dragging"));
    }, delay);
  });
  head.addEventListener("contextmenu", (evt) => { if (armed || pressTimer) evt.preventDefault(); }); // mobile's long-press-for-menu would otherwise fire at the same moment as ours
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
  const onMove = (evt) => {
    if (!resizing) return;
    evt.preventDefault();
    card.style.width = Math.max(MIN_W, startW + (evt.clientX - startX)) + "px";
    card.style.height = Math.max(MIN_H, startH + (evt.clientY - startY)) + "px";
  };
  const onUp = () => {
    if (!resizing) return;
    resizing = false;
    card.classList.remove("wl-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    saveLayout(card, pageId, key);
    // Whiteboard canvases already watch their own wrapper with a
    // ResizeObserver (see whiteboard.js) and pick this up on their
    // own. Maps (Leaflet/MapLibre) don't observe anything — nudge them
    // the same way a real window resize would, which each map library
    // already listens for.
    window.dispatchEvent(new Event("resize"));
  };
  handle.addEventListener("pointerdown", (evt) => {
    if (window.innerWidth <= DESKTOP_BREAKPOINT) return;
    evt.stopPropagation();
    evt.preventDefault();
    resizing = true;
    freezeInPlace(card, page, pageId);
    startX = evt.clientX; startY = evt.clientY;
    startW = card.offsetWidth; startH = card.offsetHeight;
    card.classList.add("wl-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
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
  const bucket = bucketFor(pageId);
  const cards = Array.from(page.querySelectorAll(":scope > .card, :scope > .grid-2 > .card, :scope > .grid-3 > .card"));
  cards.forEach((card, i) => { keyFor(card, pageId, i); }); // assign every card its key first — freezeInPlace/rowMates read it below

  // Self-heal stale saved data: since freezeInPlace freezes an entire
  // page at once, a trustworthy saved layout should cover every card on
  // the page or none of them. Partial data left over from an older
  // version of this logic (row-level, or single-card) would reproduce
  // the exact overlap that whole-page freezing exists to prevent —
  // apply it only if it's complete, otherwise drop all of it and leave
  // the whole page in normal flow, which is always safe.
  const anySaved = cards.some(c => bucket[c.dataset.wlKey]);
  const allSaved = cards.every(c => bucket[c.dataset.wlKey]);
  if (anySaved && !allSaved) {
    cards.forEach(c => { delete bucket[c.dataset.wlKey]; });
    persist();
  }

  cards.forEach(card => {
    const key = card.dataset.wlKey;
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
// Same as above but figures out which page to reset itself — this is
// what the header's "Reset layout" button calls, so it always acts on
// whatever's actually on screen without needing a page id passed in.
export function resetCurrentPageLayout() {
  const visible = document.querySelector(".page.visible");
  if (!visible) return;
  const pageId = visible.id.replace(/^page-/, "");
  resetPageLayout(pageId);
  toast("Layout reset for this page");
}
