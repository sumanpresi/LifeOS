/* ============================================================
   Cursor glow
   ============================================================
   The Redsun skin's orange is used as LIGHT rather than as fill, and in
   the reference that light moves with the pointer. Two coordinates are
   all the CSS needs to do the rest:

     --cursor-x / --cursor-y   on <html>, viewport pixels, drives the
                               ambient wash on body::after
     --glow-x  / --glow-y      on the one card under the pointer, card-
                               local pixels, drives its spotlight

   Everything about how those coordinates LOOK — radius, colour, falloff,
   the fade — lives in css/style.css under html[data-skin="redsun"]. This
   file only reports where the pointer is. No other skin reads the
   variables, so they are inert everywhere else.

   Cost control, in order of how much they save:
     - a single passive listener on window, not one per card;
     - an early return when Redsun is not the active skin, so every other
       theme pays one string comparison per pointermove and nothing else;
     - writes coalesced to one requestAnimationFrame, so a fast drag
       across the screen still only touches the DOM once per frame;
     - exactly one getBoundingClientRect per frame, on the hovered card.

   It declines to run at all on a device without a fine pointer (there is
   no cursor to follow, and touch would leave a glow stranded wherever
   the last tap landed) or when the person has asked for reduced motion.
   ============================================================ */

const SKIN = "redsun";
const CLASS = "has-cursor-glow";
/* Wide enough that the glow is already fading before it reaches the card
   edge, which is what stops the boundary from reading as a hard cut. */
const CARD_SELECTOR = ".card";

let x = 0, y = 0;
let hovered = null;   // what the last pointermove was over
let lit = null;       // what currently carries the class
let queued = false;

function flush() {
  queued = false;
  const root = document.documentElement;
  root.style.setProperty("--cursor-x", x + "px");
  root.style.setProperty("--cursor-y", y + "px");

  if (hovered !== lit) {
    if (lit) douse(lit);
    lit = hovered;
    if (lit) lit.classList.add(CLASS);
  }
  if (lit) {
    /* Read after the class write rather than before: the class only sets
       a custom property, so it forces no layout of its own. */
    const r = lit.getBoundingClientRect();
    lit.style.setProperty("--glow-x", (x - r.left) + "px");
    lit.style.setProperty("--glow-y", (y - r.top) + "px");
  }
}

function douse(el) {
  el.classList.remove(CLASS);
  el.style.removeProperty("--glow-x");
  el.style.removeProperty("--glow-y");
}

/* Used when the pointer leaves the window, the tab is hidden, or the
   skin changes out from under a stationary pointer — without this the
   last card keeps its spotlight indefinitely. */
function clear() {
  if (lit) { douse(lit); lit = null; }
  hovered = null;
  const root = document.documentElement;
  root.style.removeProperty("--cursor-x");
  root.style.removeProperty("--cursor-y");
}

function onMove(e) {
  if (document.documentElement.getAttribute("data-skin") !== SKIN) {
    if (lit) clear();
    return;
  }
  x = e.clientX;
  y = e.clientY;
  /* closest() is missing on non-Element targets; guard rather than
     assume, because pointer events can land on odd nodes. */
  hovered = e.target && e.target.closest ? e.target.closest(CARD_SELECTOR) : null;
  if (!queued) { queued = true; requestAnimationFrame(flush); }
}

export function initCursorGlow() {
  if (typeof matchMedia === "function") {
    /* No cursor to follow, or the person has asked for less movement.
       In both cases the CSS fallbacks leave a static centred wash, which
       is the intended resting state rather than a missing feature. */
    if (!matchMedia("(pointer: fine)").matches) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  }
  window.addEventListener("pointermove", onMove, { passive: true });
  window.addEventListener("pointerout", (e) => { if (!e.relatedTarget) clear(); }, { passive: true });
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clear(); });
}
