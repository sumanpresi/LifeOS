/* ============================================================
   Freehand ink over a note — the OneNote behaviour
   ============================================================
   Ink is a separate layer floating over the text, not something living
   inside the text. You circle a word, underline a phrase, draw an arrow
   in the margin, and the marks stay exactly where you put them.

   THE COORDINATE PROBLEM, and how strokes survive a reflow.

   Ink is absolute; text is relative. A mark stored at a fixed position in
   the page becomes wrong the moment the words move — and the words move
   whenever the column width changes. The same note is 1100px in full
   screen on a desktop, ~790px in a card, ~360px on a phone.

   The first version of this dealt with that by refusing to reflow: once a
   note had ink its column locked to 794px everywhere. That keeps the ink
   honest and makes the note unusable on a phone, which is what the iPhone
   screenshot showed — a 794px page in a 390px viewport, text running off
   both edges and the toolbar cut in half.

   So strokes are ANCHORED TO A PARAGRAPH instead of to the page. Each one
   records which paragraph it was drawn over, its offset from that
   paragraph's top-left corner, and how wide that paragraph was at the
   time. To draw it, the paragraph is found where it lives NOW and the
   stroke is placed relative to it, scaled by how much the column has
   changed width. Text can reflow freely: a circle round a word in
   paragraph 7 stays over paragraph 7 at any width, and the page is a
   normal responsive column again on every device.

   What this buys and what it doesn't: vertical position is exact, because
   the anchor moves with its paragraph however the text above reflows.
   Horizontal position is proportional — at half the width a mark sits at
   half the distance across — which keeps a mark over the same region of
   the same paragraph but cannot keep it over the same WORD, since at a
   different width that word is somewhere else entirely. Nothing can, short
   of refusing to reflow. Marks in the margin, underlines, circles round a
   phrase and arrows all survive; a caret wedged between two specific
   letters is approximate.

   WHERE THE STROKES LIVE
   In the note itself (`note.ink`), never in its HTML. The sanitizer's
   allowlist has no SVG or canvas — deliberately, see the <svg><script>
   note in sanitize.js — and this needs no exception to it: strokes are
   plain numbers in state, rendered to a canvas at runtime.

   The stroke shape deliberately matches whiteboard.js so the two can
   share a mental model (and, if it ever matters, code).
   ============================================================ */
import { state, uid, persist } from './state.js';
import { toast, registerBusyCheck } from './ui.js';

/* The locked column width, and the reference the stored coordinates mean.
   794px is A4 at 96dpi, which is what the non-ink note already used. */
export const PAGE_W = 794;

const PEN_COLORS = ["#2b2a24", "#c0392b", "#1f6feb", "#1d8348", "#b7791f"];
/* A highlighter multiplies with what is under it, so its colour has to be
   pale enough to leave the text readable through it. The pen palette is
   the opposite — dark, saturated — and reusing it turned a highlight into
   a black bar over the words. */
const HL_COLORS = ["#ffe066", "#a7f3d0", "#bfdbfe", "#fbcfe8", "#fed7aa"];
/* Four weights per tool, with the previous single default kept as the
   middle one so existing strokes and habits are unchanged: two finer for
   annotating between lines of text, one heavier for emphasis. The
   highlighter's set is scaled to its own job — its "fine" is still wide
   enough to cover a word. */
const PEN_WIDTHS = [1, 1.75, 2.5, 4];
const HL_WIDTHS  = [8, 12, 16, 24];
const PEN_W = PEN_WIDTHS[2]; // the long-standing default
const HL_W  = HL_WIDTHS[2];
const ERASER_R = 14;

/* One live layer per mounted editor. Rebuilt whenever renderSectionNotes
   rebuilds the note — which is often, since a sync repaint does it. */
const layers = new Map();

/* ---------- state that must OUTLIVE the layer ----------

   The layer is destroyed and recreated on every repaint, so anything held
   only in it is silently reset every time the app syncs. That produced
   two of the three faults reported from the iPad:

   - The chosen tool reverted to "text" on the next repaint, so a pen
     stroke landed on a live editor and became a text selection or a
     caret. It looked like the tool deselecting itself; it was the tool
     being rebuilt from scratch on a 15-second timer.
   - Palm rejection was armed by a per-layer flag that only became true
     after the first stylus event on THAT layer. Every repaint disarmed
     it, so the next palm touch drew before the pencil got a chance to
     re-arm it.

   Both now live at module scope, keyed by note, and survive repaints. */
const toolMemory = new Map(); // noteId -> { mode, color, hlColor, penW, hlW }

/* Whether a stylus has ever been used on this DEVICE — not this layer,
   and not this note. Once true, touch never draws again: on a tablet with
   a pencil, a finger on the glass is a palm or a pan, never ink. This is
   the single most important thing OneNote does that this didn't. */
const STYLUS_KEY = "lifeos-stylus-seen";
let stylusSeen = (() => {
  try { return localStorage.getItem(STYLUS_KEY) === "1"; } catch (e) { return false; }
})();
function markStylusSeen() {
  if (stylusSeen) return;
  stylusSeen = true;
  try { localStorage.setItem(STYLUS_KEY, "1"); } catch (e) {}
  document.body.classList.add("has-stylus");
  /* The FIRST pencil stroke is the moment a finger stops being an input
     device and becomes a way to scroll — so every live canvas has to be
     told immediately, not at the next tool change. Otherwise the finger
     spends the rest of the session unable to draw (correct) and unable to
     pan either (not correct), which is the worst of both. */
  layers.forEach(l => applyTouchPolicy(l));
  layers.forEach(l => {
    const btn = l.noteEl.querySelector(".ink-finger");
    if (btn) btn.style.display = "";
  });
}
if (stylusSeen && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => document.body.classList.add("has-stylus"));
}

/* Explicit override, the equivalent of OneNote's "Draw with touch". Needed
   on a phone with no stylus at all, and for anyone who wants to finger
   draw on a tablet despite the pencil. */
const FINGER_KEY = "lifeos-finger-draw";
let fingerDraw = (() => {
  try { return localStorage.getItem(FINGER_KEY) === "1"; } catch (e) { return false; }
})();
export function setFingerDraw(on) {
  fingerDraw = !!on;
  try { localStorage.setItem(FINGER_KEY, on ? "1" : "0"); } catch (e) {}
  document.body.classList.toggle("finger-draw", fingerDraw);
  layers.forEach(l => applyTouchPolicy(l));
}
export function touchDraws() { return fingerDraw || !stylusSeen; }

/* A stroke in progress must not be interrupted by a background repaint —
   the canvas it is being drawn on gets destroyed and the stroke goes with
   it. This is the "sometimes strokes are missed" fault: not dropped
   input, a destroyed canvas. Sync asks before pulling. */
let drawingNow = false;
export function isInking() { return drawingNow; }
/* Same channel the journal editor uses to hold off a pull while someone is
   mid-sentence. A stroke is the same kind of claim on the DOM. */
registerBusyCheck(isInking);

function inkOf(note) {
  if (!note.ink || typeof note.ink !== "object") note.ink = { strokes: [], removed: [] };
  if (!Array.isArray(note.ink.strokes)) note.ink.strokes = [];
  if (!Array.isArray(note.ink.removed)) note.ink.removed = [];
  return note.ink;
}

/* THE PAGE WIDTH AN INKED NOTE WAS WRITTEN AT.

   Proportional placement can keep a mark in the same PART of a paragraph
   across different column widths, but it can never keep it over the same
   WORD — because at a different width that word is somewhere else. The
   desktop wraps this quote after "liberty" and the Fold after "freedom",
   so a circle drawn round one phrase on one device lands on different
   words on the other. No amount of scaling fixes that; only not
   reflowing does.

   So an inked note stops reflowing, and remembers the column width it was
   written at. Every device lays the text out at that same width, wraps it
   identically, and the ink lands exactly where it was drawn — k works out
   to 1 and nothing is scaled at all.

   This is what was tried before and abandoned, because a fixed 794px page
   made a 390px phone unusable. What has changed is that zoom now exists
   and zoom does not reflow: a narrow screen fits the same page by scaling
   the whole thing, text and ink together, instead of rewrapping it. Fixed
   width plus zoom plus pan is exactly how OneNote does it. */
function inkPageWidth(note) {
  const ink = note && note.ink;
  if (!ink || !Array.isArray(ink.strokes) || !ink.strokes.length) return 0;
  if (ink.pageW > 0) return ink.pageW;
  // Ink drawn before this existed: recover the width from the strokes,
  // which have carried their paragraph's width all along.
  const widths = ink.strokes.map(st => st && st.a && st.a.w).filter(w => w > 0);
  return widths.length ? Math.round(Math.max(...widths)) : 0;
}
export function noteHasInk(note) {
  return !!(note && note.ink && Array.isArray(note.ink.strokes) && note.ink.strokes.length);
}

/* ---------- anchoring ---------- */

/* Paragraph boxes in the editor's scroll-content coordinate space, each
   carrying a short fingerprint of its text. The fingerprint is what makes
   the anchor survive editing: a paragraph's INDEX changes the moment one
   is inserted or deleted above it, so an index alone would leave the ink
   sitting on whichever paragraph inherited the number. */
function paraBoxes(editor, zoom) {
  const z = zoom || 1;
  const er = editor.getBoundingClientRect();
  return [...editor.children].map(el => {
    const r = el.getBoundingClientRect();
    return {
      left: (r.left - er.left) / z + editor.scrollLeft,
      top: (r.top - er.top) / z + editor.scrollTop,
      width: (r.width || 1) / z,
      height: r.height / z,
      t: paraKey(el.textContent),
    };
  });
}
function paraKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 48);
}

/* Find the paragraph an anchor refers to NOW. The stored index is a hint,
   not an answer: check it first, then walk outwards for the nearest
   paragraph with the same text. Nearest rather than first, so that when a
   note has several identical paragraphs (blank lines, repeated headings)
   the ink lands on the one closest to where it was, instead of jumping to
   the top of the note. */
function anchorIndex(a, boxes) {
  if (!a || a.p == null || !boxes.length) return -1;
  const p = Math.min(a.p, boxes.length - 1);
  if (a.t == null) return p;                    // drawn before fingerprints existed
  if (boxes[p] && boxes[p].t === a.t) return p; // unmoved: the common case
  for (let d = 1; d < boxes.length; d++) {
    if (boxes[p - d] && boxes[p - d].t === a.t) return p - d;
    if (boxes[p + d] && boxes[p + d].t === a.t) return p + d;
  }
  return p; // the paragraph was deleted or rewritten — hold the position
}

/* Which paragraph a point belongs to: the one it lands in, or the nearest
   one vertically when it lands in the gap between two (or out in the
   margin, where annotations often go). */
function anchorFor(boxes, x, y) {
  if (!boxes.length) return -1;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (y >= b.top && y <= b.top + b.height) return i;
    const d = y < b.top ? b.top - y : y - (b.top + b.height);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* Where a stroke's points sit on screen right now. Anchored strokes are
   resolved against their paragraph's current position and width; strokes
   from before anchoring existed keep their absolute coordinates. */
/* The stroke's own centre, cached on the stroke. Scaling happens ABOUT
   this point rather than about the stroke's first sample, which is what
   lets the shape shrink without wandering off the words it belongs to. */
const centreCache = new WeakMap();
function strokeCentre(s) {
  /* Deliberately a WeakMap and NOT a property on the stroke. A stroke
     object lives in `state`, so anything hung on it is serialised to
     localStorage and uploaded on the next sync — a cached centre would
     have quietly added two floats per stroke to a payload that was
     supposed to get smaller, not larger. The map also clears itself when
     a stroke is erased. */
  const hit = centreCache.get(s);
  if (hit) return hit;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < s.pts.length; i += 2) {
    if (s.pts[i] < x0) x0 = s.pts[i];
    if (s.pts[i] > x1) x1 = s.pts[i];
    if (s.pts[i + 1] < y0) y0 = s.pts[i + 1];
    if (s.pts[i + 1] > y1) y1 = s.pts[i + 1];
  }
  const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  centreCache.set(s, c);
  return c;
}

function resolvePoints(s, boxes) {
  const a = s.a;
  const i = anchorIndex(a, boxes);
  if (i < 0 || !boxes[i]) return s.pts;
  const b = boxes[i];
  const k = b.width / (a.w || b.width); // how much the column has changed

  /* UNIFORM SCALING, ABOUT THE STROKE'S CENTRE.

     The previous rule scaled X only and left Y exactly as drawn. That kept
     a mark spanning the same words, but it deformed everything that wasn't
     a straight line: handwriting on a 390px phone was squeezed to a third
     of its width while keeping full height, so "Social liberty" came out
     compressed and a circle came out an ellipse.

     Both axes now take the same factor, so nothing is deformed — a circle
     is a circle and handwriting keeps its hand. The two things that made
     scaling Y look wrong before are dealt with separately:

     - The stroke shrank towards the paragraph's top-left corner, because
       it scaled about its own first sample and the anchor offset scaled
       with it. Scaling about the CENTRE keeps it over the same part of the
       text as it gets smaller.
     - Its vertical POSITION moved, because a narrower paragraph is taller
       and a proportional offset inside it means something different. The
       centre's Y is therefore anchored, not scaled: the mark stays on the
       line it was drawn on, and only its size changes.

     What this trades away: on a much narrower column a circle is now a
     smaller circle sitting on the right line, rather than a full-width
     ellipse around the same words. Shape is preserved, coverage is not.
     For a note that is mostly handwriting — which is what this is for —
     that is the better half of the trade. */
  const c = strokeCentre(s);
  const cx = b.left + (a.x + c.x) * k;   // centre follows the column across
  const cy = b.top + a.y + c.y;          // ...but stays on its own line
  const out = new Array(s.pts.length);
  for (let i = 0; i < s.pts.length; i += 2) {
    out[i] = cx + (s.pts[i] - c.x) * k;
    out[i + 1] = cy + (s.pts[i + 1] - c.y) * k;
  }
  return out;
}
/* Line weight follows the same factor, with a floor: a stroke scaled to
   half size but still drawn at full thickness reads as over-inked. */
function resolveWidth(s, boxes) {
  const i = anchorIndex(s.a, boxes);
  if (i < 0 || !boxes[i] || !s.a) return s.w;
  const k = boxes[i].width / (s.a.w || boxes[i].width);
  return Math.max(0.75, s.w * k);
}

/* ---------- drawing ---------- */

function strokePath(ctx, pts, scrollTop) {
  ctx.beginPath();
  if (pts.length <= 4) { // a dot, or too short to smooth
    ctx.moveTo(pts[0], pts[1] - scrollTop);
    ctx.lineTo(pts[pts.length - 2] + 0.01, pts[pts.length - 1] - scrollTop);
    return;
  }
  ctx.moveTo(pts[0], pts[1] - scrollTop);
  /* Quadratic through the midpoints: each raw sample becomes a control
     point rather than a corner, which is what stops a fast stylus stroke
     from looking like a polygon. */
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
    ctx.quadraticCurveTo(pts[i], pts[i + 1] - scrollTop, mx, my - scrollTop);
  }
  ctx.lineTo(pts[pts.length - 2], pts[pts.length - 1] - scrollTop);
}

function drawStroke(ctx, s, scrollTop, pts, width) {
  pts = pts || s.pts;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.lineCap = s.mode === "hl" ? "butt" : "round"; // a real highlighter has a flat chisel end
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = Math.max(0.5, width == null ? s.w : width);
  strokePath(ctx, pts, scrollTop);
  ctx.stroke();
  ctx.restore();
}

function sizeCanvas(canvas, w, h, dpr, left, top) {
  /* Follow the editor's position inside the wrapper, not just its size.
     With an inked note the text column is a fixed width and may be
     centred inside a wider wrapper (full screen does exactly this), so a
     canvas pinned to 0,0 would be offset from the words it belongs to. */
  canvas.style.left = (left || 0) + "px";
  canvas.style.top = (top || 0) + "px";
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/* TWO canvases, and the reason is the whole point of a highlighter.

   A highlighter has to blend with the WORDS underneath it. Canvas
   `globalCompositeOperation = "multiply"` cannot do that: it composites
   against what is already painted on that canvas, which here is nothing
   at all — so the stroke was simply laid over the text as a translucent
   bar, dimming it instead of showing through it. The blending has to
   happen between the canvas ELEMENT and the page behind it, which means
   CSS `mix-blend-mode`, which applies to a whole element.

   One element can't be both, so: the highlighter layer blends (multiply
   on a light page, screen on a dark one — see style.css), the pen layer
   paints normally on top so ink stays crisp and opaque whatever it
   crosses. Highlighter below pen, which is also the right stacking
   order — you highlight a phrase, then circle it. */
function redraw(layer) {
  const { hlCanvas, penCanvas, editor } = layer;
  /* Backing-store scale, folding in the zoom so ink is as sharp as the
     text beside it. Capped at 3x: at 300% on a 3x-density phone an
     uncapped multiplier asks for a canvas several thousand pixels on a
     side, per layer, which mobile Safari simply refuses. */
  const dpr = Math.min(3, (window.devicePixelRatio || 1) * (layer.zoom || 1));
  const w = editor.clientWidth, h = editor.clientHeight;
  const offL = editor.offsetLeft, offT = editor.offsetTop;
  const hlCtx = sizeCanvas(hlCanvas, w, h, dpr, offL, offT);
  const penCtx = sizeCanvas(penCanvas, w, h, dpr, offL, offT);

  const top = editor.scrollTop;
  const boxes = paraBoxes(editor, layer.zoom);
  /* Resolved once per repaint and kept: the eraser has to hit-test against
     where strokes actually ARE on screen, not where they were drawn. */
  layer.boxes = boxes;
  layer.resolved = layer.strokes().map(s => resolvePoints(s, boxes));

  layer.strokes().forEach((s, i) => drawStroke(
    s.mode === "hl" ? hlCtx : penCtx, s, top, layer.resolved[i], resolveWidth(s, boxes)));
  // The stroke under the pen is already in current coordinates.
  if (layer.live) drawStroke(layer.live.mode === "hl" ? hlCtx : penCtx, layer.live, top);
}

/* ---------- erasing ---------- */

function strokeNear(s, x, y, r, pts) {
  pts = pts || s.pts;
  const pad = r + (s.w || 2) / 2;
  /* A tap leaves a one-point stroke, and a segment loop never runs on
     one. Without this a dot could be drawn but never erased. */
  if (pts.length === 2) return (x - pts[0]) ** 2 + (y - pts[1]) ** 2 <= pad * pad;
  for (let i = 0; i < pts.length - 2; i += 2) {
    // distance from (x,y) to segment i..i+1
    const x1 = pts[i], y1 = pts[i + 1], x2 = pts[i + 2], y2 = pts[i + 3];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = x1 + t * dx, py = y1 + t * dy;
    if ((x - px) ** 2 + (y - py) ** 2 <= pad * pad) return true;
  }
  return false;
}

/* ---------- the layer ---------- */

export function attachNoteInk(noteEl, getNote) {
  const editorWrap = noteEl.querySelector(".sec-note-editor");
  const editor = noteEl.querySelector(".ql-editor");
  if (!editorWrap || !editor) return null;

  const note = getNote();
  if (!note) return null;

  /* One wrapper holding the text AND both ink canvases, so a zoom is a
     single CSS transform over the lot. That is what makes zooming behave
     the way OneNote's does: text and handwriting scale in exact lockstep
     because they are the same transformed subtree, with no reflow and no
     stroke arithmetic — a mark sitting between two words stays between
     those two words at every zoom level. */
  let zoomWrap = editorWrap.querySelector(":scope > .ink-zoom");
  if (!zoomWrap) {
    zoomWrap = document.createElement("div");
    zoomWrap.className = "ink-zoom";
    /* Move whatever Quill put here, rather than looking for a
       `.ql-container` child — there isn't one. Quill 2 turns the element
       you hand it INTO the container, so `.sec-note-editor` IS
       `.ql-container`, and its children are the editor root, the
       off-screen clipboard and the link tooltip. Taking all of them keeps
       the tooltip positioned against the same box as the text it points
       at, at any zoom. */
    while (editorWrap.firstChild) zoomWrap.appendChild(editorWrap.firstChild);
    editorWrap.appendChild(zoomWrap);
  }
  const hlCanvas = document.createElement("canvas");
  hlCanvas.className = "note-ink-canvas note-ink-hl";
  const penCanvas = document.createElement("canvas");
  penCanvas.className = "note-ink-canvas note-ink-pen";
  zoomWrap.appendChild(hlCanvas);
  zoomWrap.appendChild(penCanvas); // pen above highlighter
  // Only the top canvas takes the pointer; the highlighter layer stays
  // inert so a stroke isn't captured twice.
  const canvas = penCanvas;

  const remembered = toolMemory.get(note.id) || {};
  const layer = {
    noteEl, editor, canvas, hlCanvas, penCanvas, zoomWrap,
    noteId: note.id,
    zoom: loadZoom(note.id),
    // Restored, not reset: a repaint must not put the pen down.
    mode: remembered.mode || "text",   // text | pen | hl | eraser
    color: remembered.color || PEN_COLORS[0],
    hlColor: remembered.hlColor || HL_COLORS[0],
    penW: remembered.penW || PEN_W,
    hlW: remembered.hlW || HL_W,
    live: null,
    strokes: () => inkOf(getNote() || { }).strokes,
  };

  /* Client coordinates arrive already multiplied by the zoom (they are
     post-transform), while the canvas is painted in unscaled layout
     units. Dividing here keeps one coordinate space for strokes whatever
     the zoom, so a note drawn on at 150% and viewed at 80% is identical. */
  const toContent = e => {
    const r = editor.getBoundingClientRect();
    const z = layer.zoom || 1;
    return {
      x: (e.clientX - r.left) / z + editor.scrollLeft,
      y: (e.clientY - r.top) / z + editor.scrollTop,
    };
  };

  let drawing = false, erased = false, activePointer = null;

  /* Does this pointer draw?

     pen   — always. A stylus on the glass is never anything else.
     mouse — always. There is no palm on a desktop.
     touch — only when there is no stylus on this device, or the person has
             explicitly asked for finger drawing. Otherwise a finger is a
             palm to be ignored or a hand panning the page, and letting it
             draw is exactly the fault reported: stray lines, and the page
             being selected while trying to scroll.

     Deliberately NOT "has a stylus touched this layer yet" — that was the
     old rule, and a repaint reset it. */
  const pointerDraws = e => {
    if (e.pointerType === "pen") { markStylusSeen(); return true; }
    if (e.pointerType === "touch") return touchDraws();
    return true; // mouse, or a browser that reports nothing useful
  };

  /* Panning, by hand, for pointers that aren't drawing.

     With native gestures switched off (see applyTouchPolicy) a finger
     would otherwise be inert while a tool is live — the note would be
     impossible to scroll without putting the pen away. This restores that,
     for touch only, and scrolls the window once the note itself has hit
     its limit so a drag never dead-ends. */
  let panning = null;
  const scroller = () => noteEl.querySelector(".sec-note-editor");

  const startPan = e => {
    panning = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  };

  /* INCREMENTAL, not absolute.

     The first version anchored to where the drag started and, on every
     move, handed whatever the note couldn't absorb to window.scrollBy.
     When the note had nothing left to scroll — or nothing to scroll at
     all — that leftover was the WHOLE accumulated distance, re-applied on
     every single pointermove. One slow drag therefore scrolled the window
     by the sum of a hundred ever-growing deltas and the page shot away by
     itself, which is exactly the "page moves automatically and I can't
     position it" fault.

     Each move now contributes only the distance travelled since the last
     one. The note takes what it can, the window takes the remainder, and
     a drag of N pixels moves things by N pixels however many events it
     arrives in. */
  const movePan = e => {
    if (!panning || e.pointerId !== panning.id) return;
    e.preventDefault();
    const z = layer.zoom || 1;
    const dy = (e.clientY - panning.lastY) / z;
    const dx = (e.clientX - panning.lastX) / z;
    panning.lastX = e.clientX;
    panning.lastY = e.clientY;

    /* The WINDOW scrolls, not the page. The sheet is a full A4 document
       laid out at its natural height, so `.ql-editor` has no overflow of
       its own any more — scrolling moved to `.sec-note-editor` when the
       note became a real document. Panning the editor here moved nothing
       at all. */
    const sc = scroller();
    if (sc) {
      const before = sc.scrollTop;
      sc.scrollTop = before - dy;
      const consumed = before - sc.scrollTop;     // what the window absorbed
      const leftover = dy - consumed;
      if (Math.abs(leftover) > 0.5) window.scrollBy(0, -leftover);
      sc.scrollLeft -= dx;                        // pan a magnified page sideways
    } else {
      window.scrollBy(0, -dy);
    }
    redraw(layer);
  };
  const endPan = e => {
    if (!panning || e.pointerId !== panning.id) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    panning = null;
  };

  const onDown = e => {
    if (layer.mode === "text") return;
    if (e.pointerType === "pen") markStylusSeen();
    if (!pointerDraws(e)) {
      // Not an instruction to draw — so it's a hand moving the page.
      e.preventDefault();
      startPan(e);
      return;
    }
    if (drawing) return;            // a second finger mid-stroke is a palm

    /* The barrel button erases, as it does in Samsung Notes and OneNote.
       Two ways a stylus can say "eraser": the S Pen holds its side button
       (barrel, bit 32), and a pen flipped to its eraser end reports
       button 5. Either one erases for the duration of the stroke and then
       hands the tool straight back, so it is a modifier, not a mode. */
    const eraserHeld = (e.buttons & 32) === 32 || e.button === 5;
    const modeForStroke = eraserHeld ? "eraser" : layer.mode;
    layer.strokeMode = modeForStroke;

    e.preventDefault();
    activePointer = e.pointerId;
    drawingNow = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* Safari can refuse */ }
    const p = toContent(e);

    if (modeForStroke === "eraser") {
      drawing = true; erased = false;
      eraseAt(p.x, p.y);
      return;
    }
    drawing = true;
    const hl = modeForStroke === "hl";
    layer.live = {
      id: uid(), mode: modeForStroke,
      color: hl ? layer.hlColor : layer.color,
      w: hl ? layer.hlW : layer.penW,
      pts: [p.x, p.y],
    };
    redraw(layer);
  };

  const onMove = e => {
    if (panning) { movePan(e); return; }
    if (!drawing || e.pointerId !== activePointer) return; // ignore the resting palm
    e.preventDefault();
    /* Coalesced events recover the samples the browser batched between
       frames — the difference between a smooth curve and a stair. The
       fallback is not just for old browsers: getCoalescedEvents() returns
       an EMPTY list for any event that wasn't coalesced, so trusting it
       blindly drops every point of the stroke and leaves a dot. */
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const evts = (coalesced && coalesced.length) ? coalesced : [e];
    for (const ev of evts) {
      const p = toContent(ev);
      if (layer.strokeMode === "eraser") { eraseAt(p.x, p.y); continue; }
      const pts = layer.live.pts;
      const dx = p.x - pts[pts.length - 2], dy = p.y - pts[pts.length - 1];
      if (dx * dx + dy * dy < 1.5) continue; // thin out samples that add nothing
      /* Rounded to a tenth of a pixel. Sub-pixel precision beyond that is
         invisible at any zoom and costs a dozen characters a point in the
         synced payload — with coalesced events now feeding many more
         samples per stroke, this keeps the stored size DOWN rather than
         up, which is what was asked for. */
      pts.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
    }
    redraw(layer);
  };

  const onUp = e => {
    if (panning) { endPan(e); return; }
    if (!drawing || (activePointer !== null && e.pointerId !== activePointer)) return;
    drawing = false;
    drawingNow = false;
    activePointer = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    const live = layer.live;
    layer.live = null;
    const n = getNote();
    if (!n) return;
    if (layer.strokeMode === "eraser") {
      layer.strokeMode = null;
      if (erased) { n.updated = Date.now(); persist(); }
      redraw(layer);
      return;
    }
    layer.strokeMode = null;
    if (live && live.pts.length >= 2) {
      const boxes = paraBoxes(editor, layer.zoom);
      const ink = inkOf(n);
      // The first stroke fixes the page width for this note, for good.
      if (!(ink.pageW > 0) && boxes.length) ink.pageW = Math.round(boxes[0].width);
      ink.strokes.push(anchorStroke(live, boxes));
      n.updated = Date.now();
      persist();
      syncPageLock(noteEl, n, editor);
    }
    redraw(layer);
  };

  function eraseAt(x, y) {
    const n = getNote();
    if (!n) return;
    const ink = inkOf(n);
    const boxes = layer.boxes || paraBoxes(editor, layer.zoom);
    const keep = [];
    ink.strokes.forEach((s, i) => {
      const pts = (layer.resolved && layer.resolved[i]) || resolvePoints(s, boxes);
      if (strokeNear(s, x, y, ERASER_R, pts)) {
        erased = true;
        /* A tombstone, not just a removal. Without it the next sync's
           union with a device that still has the stroke simply puts it
           back — the same resurrection problem the task merge solves with
           the trash log. */
        ink.removed.push({ id: s.id, at: Date.now() });
      } else keep.push(s);
    });
    ink.strokes = keep;
  }

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  /* pointercancel means Safari took the gesture away mid-stroke. Treat it
     as a pen-up rather than a discard: the part already drawn is real
     ink, and throwing it away is precisely the "stroke didn't register"
     complaint. */
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("lostpointercapture", onUp);

  /* touch-action:none should be enough, but iOS has historically needed
     the events killed as well before it will stop scrolling, magnifying
     and showing the callout on a long press. Non-passive, or
     preventDefault is ignored. */
  const swallow = e => { if (layer.mode !== "text") e.preventDefault(); };
  canvas.addEventListener("touchstart", swallow, { passive: false });
  canvas.addEventListener("touchmove", swallow, { passive: false });
  canvas.addEventListener("gesturestart", swallow, { passive: false });

  const onScroll = () => redraw(layer);
  editor.addEventListener("scroll", onScroll, { passive: true });
  const ro = new ResizeObserver(() => redraw(layer));
  ro.observe(editor);

  layer.destroy = () => {
    ro.disconnect();
    editor.removeEventListener("scroll", onScroll);
    hlCanvas.remove();
    penCanvas.remove();
  };
  layer.redraw = () => redraw(layer);
  layer.setMode = m => setMode(layer, m);

  layers.set(noteEl, layer);
  buildToolbar(noteEl, layer, getNote);
  setNoteZoom(layer, layer.zoom, null); // apply the remembered zoom, don't re-save it
  fitZoomIfNeeded(layer, note);
  // Put the pen bar and the live tool back exactly as they were before the
  // repaint that destroyed the previous layer.
  if (layer.mode !== "text") {
    noteEl.classList.add("ink-open");
    setMode(layer, layer.mode);
  }
  applyTouchPolicy(layer);
  syncPageLock(noteEl, note, editor);
  redraw(layer);
  return layer;
}

/* Rewrites a just-drawn stroke from page coordinates into
   paragraph-relative ones. Done at the END of the stroke rather than the
   start: drawing in live page coordinates keeps the hot path trivial, and
   the anchor only has to be right once, when it is stored. */
function anchorStroke(s, boxes) {
  const p = anchorFor(boxes, s.pts[0], s.pts[1]);
  if (p < 0) return s; // an empty note has nothing to anchor to
  const b = boxes[p];
  const x0 = s.pts[0], y0 = s.pts[1];
  const out = new Array(s.pts.length);
  for (let i = 0; i < s.pts.length; i += 2) {   // points become origin-relative
    out[i] = Math.round((s.pts[i] - x0) * 10) / 10;
    out[i + 1] = Math.round((s.pts[i + 1] - y0) * 10) / 10;
  }
  centreCache.delete(s); // points just changed; recompute on next paint
  s.a = {
    p, t: b.t,
    x: Math.round((x0 - b.left) * 10) / 10,
    y: Math.round((y0 - b.top) * 10) / 10,
    w: Math.round(b.width * 10) / 10,
  };
  s.pts = out;
  return s;
}

/* Written on every change, so the next repaint rebuilds the layer with
   the pen still in hand. */
function rememberTools(layer) {
  if (!layer.noteId) return;
  toolMemory.set(layer.noteId, {
    mode: layer.mode, color: layer.color, hlColor: layer.hlColor,
    penW: layer.penW, hlW: layer.hlW,
  });
}

export function detachNoteInk(noteEl) {
  const l = layers.get(noteEl);
  if (l) { l.destroy(); layers.delete(noteEl); }
  /* Take the pen bar and the header controls with it. Their click
     handlers close over the layer being destroyed, so leaving them behind
     leaves buttons that look live and act on a dead layer — and
     buildToolbar's "already built?" guard would then decline to replace
     them. Harmless while every detach is followed by a full DOM rebuild,
     which is why it went unnoticed; wrong the moment one isn't. */
  if (noteEl) {
    noteEl.querySelector(".ink-bar")?.remove();
    noteEl.querySelector(".ink-toggle")?.remove();
    noteEl.querySelector(".ink-zoom-ctl")?.remove();
  }
}

/* Redraw every live layer — called after a sync replaces state, when the
   strokes on screen may be a merge of two devices' marks. */
export function redrawAllInk() {
  layers.forEach(l => { try { l.redraw(); } catch (e) { /* detached */ } });
}

/* touch-action CANNOT be used to separate the pencil from the finger.

   On iOS an Apple Pencil is delivered through the same touch pipeline as a
   fingertip. `touch-action: pan-y` therefore hands the PENCIL to Safari's
   scroller: the page slid under every stroke, and Safari fired
   pointercancel partway through, which is both "the page moves with my
   pencil" and "strokes are sometimes not registered" — the same bug wearing
   two hats. It also explains why turning finger-drawing ON fixed the
   drawing: that path set `none`.

   So while any tool is live, touch-action is ALWAYS `none` — no native
   gesture at all — and panning is done by hand below for the pointers that
   are not drawing. The browser can't tell a pencil from a palm; we can. */
function applyTouchPolicy(layer) {
  layer.canvas.style.touchAction = layer.mode === "text" ? "" : "none";
}

function setMode(layer, mode) {
  layer.mode = mode;
  rememberTools(layer);
  const drawing = mode !== "text";
  layer.canvas.classList.toggle("drawing", drawing);
  layer.noteEl.classList.toggle("ink-drawing", drawing);
  /* The editor stays EDITABLE in draw mode, deliberately.

     Disabling it was the obvious way to stop a stroke from also placing a
     caret — but it takes the whole formatting toolbar down with it: bold,
     lists, colour, links and the rest all act on a selection inside a
     live editor, and against a disabled one they simply do nothing. Half
     the note's tools would go dead the moment the pen came out.

     None of that is needed. The ink canvas is stacked above the text with
     pointer-events:auto while a tool is live, so it swallows every
     pointer event before the text ever sees one — no caret is placed, no
     drag-select starts, without disabling anything. The caret is hidden
     in CSS rather than removed, so a selection made before picking up the
     pen survives, and the toolbar still acts on it. */
  layer.noteEl.querySelectorAll(".ink-tool").forEach(b => {
    b.classList.toggle("active", b.dataset.tool === mode);
  });
  applyTouchPolicy(layer);
  const swatches = layer.noteEl.querySelector(".ink-colors");
  swatches?.classList.toggle("show", mode === "pen" || mode === "hl");
  // The two tools have separate palettes and separate current colours, so
  // the row is rebuilt for whichever is live rather than shared.
  const widths = layer.noteEl.querySelector(".ink-widths");
  widths?.classList.toggle("show", mode === "pen" || mode === "hl");
  if (mode === "pen" || mode === "hl") {
    renderSwatches(swatches, layer, mode);
    renderWidths(widths, layer, mode);
  }
  if (!drawing) layer.editor.focus();
}

/* ---------- zoom ---------- */

export const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];
const ZOOM_KEY = "lifeos-note-zoom";

/* Per note, per device, and NEVER synced: how far someone has zoomed in
   is view state, like a scroll position or which tab is open. The desktop
   at 80% and the phone at 150% are both right, and neither should be
   telling the other what to do. */
function hasStoredZoom(noteId) {
  try {
    const all = JSON.parse(localStorage.getItem(ZOOM_KEY) || "{}");
    return Number(all[noteId]) > 0;
  } catch (e) { return false; }
}
function loadZoom(noteId) {
  try {
    const all = JSON.parse(localStorage.getItem(ZOOM_KEY) || "{}");
    const z = Number(all[noteId]);
    return z >= 0.25 && z <= 4 ? z : 1;
  } catch (e) { return 1; }
}
function saveZoom(noteId, z) {
  try {
    const all = JSON.parse(localStorage.getItem(ZOOM_KEY) || "{}");
    if (z === 1) delete all[noteId]; else all[noteId] = z;
    localStorage.setItem(ZOOM_KEY, JSON.stringify(all));
  } catch (e) { /* private browsing — the zoom just doesn't persist */ }
}

export function setNoteZoom(layer, z, noteId) {
  z = Math.max(0.25, Math.min(4, z));
  layer.zoom = z;
  layer.zoomWrap.style.setProperty("--z", z);
  const label = layer.noteEl.querySelector(".ink-zoom-level");
  if (label) label.textContent = Math.round(z * 100) + "%";
  if (noteId) saveZoom(noteId, z);
  redraw(layer);
}

/* The note's width is no longer touched by the presence of ink — strokes
   follow their paragraph instead of demanding a fixed column, so the page
   stays a normal responsive one on every device. Kept as a no-op hook and
   a class that CSS uses only for cursor affordances. */
/* THE DOCUMENT COORDINATE SPACE.

   Every note is an A4 sheet: 794 x 1123 at 96dpi, ratio 1:1.414. That is
   the document, and it does not change with the device — a phone, a Fold
   and a desktop are three windows onto the same page, not three page
   sizes. Zoom changes the display scale and never the coordinate space,
   so paragraph wrapping is identical everywhere and a stroke drawn on one
   device is correct on all of them.

   One exception: a note that already carries ink from before this
   existed. Its strokes were anchored against whatever column width was in
   force at the time, so re-laying that text out at 794 would rewrap it
   and slide the words out from under the handwriting. Those notes keep
   their own recorded width — ink staying where it was put matters more
   than uniformity. Every new note is A4. */
const A4_RATIO = 1.4142;

/* `pageW` and every stroke's `a.w` record the TEXT COLUMN width — the
   paragraph box — because that is what the anchoring maths compares
   against. The paper is wider than its text by its own margins, so the
   sheet's width has to add them back. Setting the sheet to the column
   width instead made the page 68px narrower than A4 and the text touch
   both edges. Padding is read from the live element rather than hardcoded,
   so the two can't drift apart. */
function docWidth(note, editor) {
  const col = inkPageWidth(note);
  if (!col) return PAGE_W;
  let pad = 68; // matches the CSS default; only used if measuring fails
  if (editor) {
    const cs = getComputedStyle(editor);
    const measured = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    if (measured > 0) pad = measured;
  }
  return Math.round(col + pad);
}

function syncPageLock(noteEl, note, editor) {
  noteEl.classList.toggle("has-ink", noteHasInk(note));
  const w = docWidth(note, editor);
  noteEl.style.setProperty("--doc-w", w + "px");
  noteEl.style.setProperty("--doc-h", Math.round(w * A4_RATIO) + "px");
}

/* Choose a zoom that shows the whole locked page, when the screen is too
   narrow for it — but only if this device has no zoom of its own for the
   note yet. A remembered choice is the person's, and is never overridden. */
function fitZoomIfNeeded(layer, note) {
  const pageW = docWidth(note, layer.editor);
  if (!pageW || hasStoredZoom(note.id)) return;
  const host = layer.noteEl.querySelector(".sec-note-editor");
  const avail = host ? host.clientWidth : 0;
  if (!avail || avail >= pageW) return;
  /* An exact ratio, not the nearest stop. The stops exist for a person
     clicking − and +; an automatic fit has one job, which is to make the
     sheet fit, and the smallest stop (50%) is still too large for a phone
     — 397px of paper in 366px of screen. Rounded down slightly so the
     edge of the page isn't flush against the edge of the screen. */
  const want = Math.max(0.2, Math.floor((avail / pageW) * 100) / 100);
  if (Math.abs(want - layer.zoom) > 0.005) setNoteZoom(layer, want, null);
}

/* ---------- toolbar ---------- */

function renderWidths(host, layer, mode) {
  if (!host) return;
  const widths = mode === "hl" ? HL_WIDTHS : PEN_WIDTHS;
  const current = mode === "hl" ? layer.hlW : layer.penW;
  const ink = mode === "hl" ? layer.hlColor : layer.color;
  host.innerHTML = widths.map(w =>
    /* The swatch shows the actual weight rather than a label: a picker
       for a line thickness should look like the line. Capped in display
       so the heaviest still fits the bar. */
    `<button type="button" class="ink-width${w === current ? " active" : ""}" data-w="${w}"
       title="${w <= 2 ? "Fine" : w <= 4 ? "Medium" : "Thick"} (${w}px)">
       <i style="height:${Math.min(w, 10)}px;background:${ink}"></i>
     </button>`).join("");
}

function renderSwatches(host, layer, mode) {
  if (!host) return;
  const colors = mode === "hl" ? HL_COLORS : PEN_COLORS;
  const current = mode === "hl" ? layer.hlColor : layer.color;
  host.innerHTML = colors.map(c =>
    `<button type="button" class="ink-color${c === current ? " active" : ""}" data-color="${c}"
      style="background:${c}" title="Colour"></button>`).join("");
}

function buildToolbar(noteEl, layer, getNote) {
  const head = noteEl.querySelector(".sec-note-head");
  if (!head || head.querySelector(".ink-toggle")) return;

  /* In the head rather than the pen bar: zooming is for reading as much as
     for drawing, and shouldn't require picking up a pen first. */
  const zoomBox = document.createElement("span");
  zoomBox.className = "ink-zoom-ctl";
  zoomBox.innerHTML = `
    <button type="button" class="ink-zoom-btn" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>
    <button type="button" class="ink-zoom-level" title="Reset to 100%" aria-label="Reset zoom">100%</button>
    <button type="button" class="ink-zoom-btn" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>`;
  head.insertBefore(zoomBox, head.querySelector(".sec-note-full"));

  zoomBox.addEventListener("click", e => {
    const n = getNote();
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.classList.contains("ink-zoom-level")) { setNoteZoom(layer, 1, n?.id); return; }
    const dir = btn.dataset.zoom === "in" ? 1 : -1;
    // Step through fixed stops rather than multiplying, so the readout is
    // always a round number and repeated clicks can't drift.
    const i = ZOOM_STEPS.findIndex(z => Math.abs(z - layer.zoom) < 0.001);
    const next = i === -1
      ? (dir > 0 ? ZOOM_STEPS.find(z => z > layer.zoom) : [...ZOOM_STEPS].reverse().find(z => z < layer.zoom))
      : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))];
    if (next) setNoteZoom(layer, next, n?.id);
  });

  const toggle = document.createElement("button");
  toggle.className = "sec-note-full ink-toggle";
  toggle.type = "button";
  toggle.title = "Draw on this note";
  toggle.setAttribute("aria-label", "Draw");
  toggle.textContent = "✎";
  head.insertBefore(toggle, head.querySelector(".sec-note-full"));

  const bar = document.createElement("div");
  bar.className = "ink-bar";
  bar.innerHTML = `
    <button type="button" class="ink-tool" data-tool="pen" title="Pen">✒</button>
    <button type="button" class="ink-tool" data-tool="hl" title="Highlighter">▮</button>
    <button type="button" class="ink-tool" data-tool="eraser" title="Eraser">⌫</button>
    <span class="ink-colors"></span>
    <span class="ink-widths"></span>
    <button type="button" class="ink-tool ink-finger" title="Draw with finger (off when a stylus is present)"
      aria-pressed="false">☝</button>
    <button type="button" class="ink-tool ink-done" data-tool="text" title="Back to typing">Done</button>`;
  noteEl.insertBefore(bar, noteEl.querySelector(".sec-note-body"));

  toggle.addEventListener("click", () => {
    const on = !noteEl.classList.contains("ink-open");
    noteEl.classList.toggle("ink-open", on);
    setMode(layer, on ? "pen" : "text");

  });

  const syncFingerBtn = () => {
    const btn = bar.querySelector(".ink-finger");
    if (!btn) return;
    btn.classList.toggle("active", touchDraws());
    btn.setAttribute("aria-pressed", touchDraws() ? "true" : "false");
    // Only worth showing once we know a stylus exists; without one, touch
    // drawing is the only option and a toggle would just be a trap.
    btn.style.display = stylusSeen ? "" : "none";
  };
  syncFingerBtn();

  bar.addEventListener("click", e => {
    if (e.target.closest(".ink-finger")) {
      setFingerDraw(!touchDraws());
      syncFingerBtn();
      toast(touchDraws() ? "Finger drawing on" : "Finger drawing off — pencil only, finger scrolls");
      return;
    }
    const tool = e.target.closest(".ink-tool");
    if (tool) {
      const m = tool.dataset.tool;
      setMode(layer, m);
      if (m === "text") noteEl.classList.remove("ink-open");
      return;
    }
    const col = e.target.closest(".ink-color");
    if (col) {
      if (layer.mode === "hl") layer.hlColor = col.dataset.color;
      else { layer.color = col.dataset.color; if (layer.mode !== "pen") setMode(layer, "pen"); }
      bar.querySelectorAll(".ink-color").forEach(b => b.classList.toggle("active", b === col));
      rememberTools(layer);
      // the weight swatches are drawn in the live colour, so they follow it
      renderWidths(bar.querySelector(".ink-widths"), layer, layer.mode === "hl" ? "hl" : "pen");
      return;
    }
    const wq = e.target.closest(".ink-width");
    if (wq) {
      const w = parseFloat(wq.dataset.w);
      if (layer.mode === "hl") layer.hlW = w; else layer.penW = w;
      rememberTools(layer);
      bar.querySelectorAll(".ink-width").forEach(b => b.classList.toggle("active", b === wq));
    }
  });
}

/* ---------- sync ---------- */

/* Union the two devices' strokes rather than letting the newer note win
   outright: two people (or one person on two devices) drawing on the same
   note are adding marks, not replacing a document. Tombstones keep an
   erased stroke erased. Mirrors mergeBoardData in whiteboard.js. */
export function mergeNoteInk(localNote, remoteNote) {
  const a = localNote?.ink, b = remoteNote?.ink;
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;

  const removed = new Map();
  [...(a.removed || []), ...(b.removed || [])].forEach(r => {
    if (r && r.id && !removed.has(r.id)) removed.set(r.id, r);
  });

  const seen = new Set();
  const strokes = [];
  [...(a.strokes || []), ...(b.strokes || [])].forEach(s => {
    if (!s || !s.id || seen.has(s.id) || removed.has(s.id)) return;
    seen.add(s.id);
    strokes.push(s);
  });

  /* Tombstones can't accumulate forever. One for a stroke neither side
     still holds has done its job — the stroke is gone from both copies —
     so drop it once it is a week old. */
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  return { strokes, removed: [...removed.values()].filter(r => (r.at || 0) > cutoff) };
}
