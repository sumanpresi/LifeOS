/* Whiteboard — a single canvas per instance (Overview's general
   scribble board, GSI Workspace's brainstorming board), each with its
   own tool state and its own data under state.whiteboards[boardId].
   Built for S Pen / Apple Pencil / finger / mouse via Pointer Events.

   This was previously 10 vertically-scrollable pages per board. That
   required wrapping them in their own internally-scrollable container —
   a second scrollable region sitting between the canvas and the page it
   lives on. On real touchscreen hardware (confirmed specifically on a
   Galaxy S26 Ultra with S Pen, on Samsung Internet), that nested region
   made gesture disambiguation ("is this drawing, or does an inner
   container want to scroll, or does the outer page") fragile. Going
   back to a single, un-nested canvas removes that region entirely.

   touch-action on the canvas is `none`, permanently, in CSS — not
   toggled by JS. An earlier version toggled it between `none` (while
   drawing) and `pan-y` (so a finger could scroll between strokes, once
   only S Pen/Apple Pencil could draw). That toggle is a real weakness:
   touch-action is read by the browser's compositor to decide gesture
   handling, and a value changed by JS *in response to* the same
   pointerdown that starts the gesture can lose that race on some
   browsers — the compositor may have already committed to allowing a
   scroll before the JS handler finishes updating the style. The
   original version of this whiteboard never toggled it at all, and
   never had this problem. With a single canvas (not 10 pages needing
   internal scroll), there's no real need left for a finger to scroll
   *inside* the canvas specifically — the page around it still scrolls
   normally — so the simpler, permanently-set value is strictly better.

   Every exported function takes a boardId as its first argument so the
   same module and the same fixes apply to every board rather than
   duplicating this logic per instance — the DOM ids and toolbar
   elements are all suffixed with -${boardId} to keep instances from
   colliding with each other on the same page.

   Three things here fix real bugs from earlier versions and still
   apply with a single canvas:

   1. The canvas paints its own white background via the 2D context
      instead of relying on CSS `background: #fff`. Samsung Browser's
      "force dark" feature (and similar browser-level dark-mode
      overrides) can invert CSS-rendered colors on a page even when the
      site itself has no dark theme — but it can't touch pixels a canvas
      draws itself, so an explicit fillRect is genuinely immune to it
      where a CSS background color isn't.

   2. Stroke points are normalized against a single reference dimension
      (width) for both X and Y, not width-for-X/height-for-Y separately,
      and the canvas uses a fixed aspect-ratio (not a fixed pixel
      height with a flexible width) so its actual shape is identical on
      every screen size. Both together are what keep a drawing's
      proportions intact — and the whole drawing present — regardless of
      what device it's viewed on.

   3. Only the newest segment is drawn on each pointermove, not the
      entire canvas re-filled and re-stroked from scratch. A stylus
      fires move events at a much higher rate than a mouse; redrawing
      everything on every one of those, and getting more expensive as
      more strokes accumulate, was the likely cause of both rendering
      lag and the eraser visually misbehaving on high-frequency,
      high-resolution mobile input. */
import { state, persist, uid, esc } from './state.js?v=202609042000';
import { openShareBoardDialog } from './share.js?v=202609042000';
import { sanitizeHtml } from './sanitize.js?v=202609042000';
import { decorateLinks, stripPreviewCards } from './link-preview.js?v=202609042000';
import { toast } from './ui.js?v=202609042000';
import { moveToTrash } from './trash.js?v=202609042000';

const COLORS = ["#1B1B1A", "#DC2626", "#2563EB", "#16A34A", "#F59E0B", "#7C3AED"];
const WIDTHS = { thin: 2, medium: 4, thick: 8 };
const ERASER_SIZES = { small: 16, large: 40 }; // deliberately much bigger than pen widths — erasing needs to cover ground fast

const instances = {}; // { [boardId]: { canvas, layer, ctx, dpr, initialized, drawing, currentStroke, activeTool, activeColor, activeWidthKey, activeEraserKey, zoomPct, touchPoints, pinching, pinchStartDist, pinchStartZoom } }
function inst(boardId) {
  if (!instances[boardId]) {
    instances[boardId] = {
      canvas: null, layer: null, ctx: null, dpr: 1, initialized: false,
      drawing: false, currentStroke: null,
      activeTool: null, activeColor: COLORS[0], activeWidthKey: "medium", activeEraserKey: "small", zoomPct: 100,
      penFlyoutOpen: false, eraserFlyoutOpen: false,
      // Pinch-zoom: a live map of every currently-touching finger, keyed
      // by pointerId, so a second finger landing can be detected
      // regardless of what the first one is doing. Separate from
      // drawing/currentStroke, since fingers never draw on this board
      // (S Pen / Apple Pencil only) — two fingers together mean zoom,
      // not a stroke.
      touchPoints: new Map(), pinching: false, pinchStartDist: 0, pinchStartZoom: 100
    };
  }
  return instances[boardId];
}
/* Surfaces that carry tabs. The GSI Brainstorming board was the only one;
   Day Of now has the same thing, with its own separate set of tabs — a
   day's scratch thinking and a project's brainstorming are different
   material, and sharing one tab strip would have made the two pages two
   views of the same board rather than two boards.

   Everything below reads the collection through this table instead of
   naming state.brainstormBoards directly, which is what lets a second
   surface exist without a second copy of the tab code. All three tabbed
   surfaces share it. */
const TAB_SURFACES = {
  gsi:   { list: "brainstormBoards", active: "activeBrainstormBoard", prefix: "bb_" },
  dayof: { list: "dayofBoards",      active: "activeDayofBoard",      prefix: "db_" },
  /* Communication's whiteboard. The surface id is still "overview" — it
     began life as the Overview page's single flat canvas, and every DOM id
     (#whiteboardCanvas-overview and friends) plus initWhiteboard("overview")
     is built from it. Renaming would touch two dozen ids to no benefit; the
     heading is what the person reads. Its old flat content in
     state.whiteboards.overview is migrated into the first tab by merge() in
     state.js, so nothing drawn before this change is lost. */
  overview: { list: "commBoards", active: "activeCommBoard", prefix: "cb_" },
};
const isTabSurface = id => Object.prototype.hasOwnProperty.call(TAB_SURFACES, id);
function tabList(surface) {
  const key = TAB_SURFACES[surface].list;
  if (!Array.isArray(state[key])) state[key] = [];
  return state[key];
}
function activeBrainstormBoard(surface = "gsi") {
  const cfg = TAB_SURFACES[surface];
  const boards = tabList(surface);
  let b = boards.find(x => x.id === state[cfg.active] && !x.archived && !x.deleted);
  if (!b) b = boards.find(x => !x.archived && !x.deleted) || boards[0];
  if (b && state[cfg.active] !== b.id) state[cfg.active] = b.id;
  return b || null;
}
function board(boardId) {
  if (isTabSurface(boardId)) {
    const b = activeBrainstormBoard(boardId);
    if (!b) return { strokes: [], objects: [], connectors: [] }; // no tabs at all (shouldn't happen — addBrainstormBoard always leaves one)
    b.objects = b.objects || [];
    b.connectors = b.connectors || [];
    return b;
  }
  state.whiteboards[boardId] = state.whiteboards[boardId] || { strokes: [], objects: [] };
  const b = state.whiteboards[boardId];
  b.objects = b.objects || []; // additive field — older saved boards predate sticky notes
  b.connectors = b.connectors || []; // additive field — older saved boards predate connector lines
  return b;
}
const id = (boardId, base) => base + "-" + boardId;

// The general sync system resolves conflicts by comparing one timestamp
// for a device's entire saved state — whichever device's overall
// timestamp is newer replaces everything, field by field, even ones
// that didn't actually change on that device. For most data that's an
// acceptable simplification; for whiteboards it silently erased real
// drawings whenever the *other* device happened to touch anything
// unrelated more recently. This merges the two boards' strokes and
// notes by id instead of letting one wholesale-replace the other, so a
// device that's behind on other data doesn't lose drawings it's ahead
// on. Exported for supabase.js to apply specifically to whiteboard data
// during reconciliation, since this app-wide default doesn't fit here.
export function mergeBoardData(a, b) {
  if (!a) return b || { strokes: [], objects: [] };
  if (!b) return a;
  const strokes = [], seenStrokes = new Set();
  [...(a.strokes || []), ...(b.strokes || [])].forEach(s => {
    /* The fallback key for id-less strokes must not depend on anything
       that legitimate maintenance can change. It used to include
       points.length — which "Reclaim space" alters by design when it
       thins redundant points. A thinned stroke and its unthinned copy on
       another device therefore hashed differently, so the merge treated
       them as two separate strokes and kept BOTH. Every sync after a
       cleanup re-added the dense originals alongside the simplified ones,
       which is why a reclaimed 625 KB document grew back past 1.4 MB.

       First point, last point and colour identify the same drawn line
       regardless of how many intermediate points survive. */
    const key = s.id || (JSON.stringify(s.points[0]) + JSON.stringify(s.points[s.points.length - 1]) + s.color);
    if (!seenStrokes.has(key)) { seenStrokes.add(key); strokes.push(s); }
  });
  // Strokes are add-only and immutable once drawn (an eraser stroke is
  // just another stroke, never a mutation of an old one), so "keep
  // whichever copy of a given id is seen first" is a safe merge for
  // them. Sticky notes are not: the same note id gets its text, color,
  // position and size edited in place over time, and a delete is
  // recorded as a tombstone (deleted:true) rather than removed outright
  // — see attachStickyHandlers' delete handler. The old version of this
  // merge used that same "first seen wins" rule for notes too, which
  // meant whichever side happened to be passed as `a` always kept its
  // own copy of a conflicting note id and silently discarded the other
  // side's edit — the actual cause of sticky notes syncing
  // inconsistently. Comparing each note's own updatedAt and keeping the
  // newer one (an edit, a move, a resize, or a delete — whichever
  // genuinely happened last) fixes that regardless of merge order.
  const objects = [];
  const newestById = new Map();
  [...(a.objects || []), ...(b.objects || [])].forEach(o => {
    const prev = newestById.get(o.id);
    if (!prev || (o.updatedAt || 0) >= (prev.updatedAt || 0)) newestById.set(o.id, o);
  });
  // Tombstones only need to survive long enough for every device to
  // have had a chance to see the delete during a sync; kept far past
  // that, they'd just grow the payload forever for no benefit.
  const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  newestById.forEach(o => {
    if (!o.deleted || Date.now() - (o.updatedAt || 0) < TOMBSTONE_MAX_AGE_MS) objects.push(o);
  });
  // Connectors just link two note ids — nothing about an existing one
  // is ever edited in place, only created or deleted — so a plain
  // union by id (like strokes) is enough; no updatedAt comparison
  // needed the way notes require.
  const connectors = [];
  const seenConnectors = new Set();
  [...(a.connectors || []), ...(b.connectors || [])].forEach(c => {
    if (!seenConnectors.has(c.id)) { seenConnectors.add(c.id); connectors.push(c); }
  });
  return { strokes, objects, connectors };
}

export function initWhiteboard(boardId) {
  const canvas = document.getElementById(id(boardId, "whiteboardCanvas"));
  if (!canvas) return;
  const s = inst(boardId);
  if (!s.initialized) {
    s.canvas = canvas;
    s.layer = document.getElementById(id(boardId, "wbObjLayer"));
    attachPointerHandlers(boardId, canvas);
    attachLayerHandlers(boardId, s.layer);
    window.addEventListener("resize", () => sizeCanvas(boardId));
    // A fixed setTimeout after the fullscreen event (see
    // onFullscreenChanged) was measuring the container before the
    // browser had necessarily finished the transition — fullscreen
    // resize timing isn't guaranteed to land within any fixed delay
    // across browsers/OS. Watching the wrapper's actual rendered size
    // directly re-syncs whenever it genuinely changes, regardless of
    // what caused it or how long the transition took.
    if (typeof ResizeObserver !== "undefined") {
      const wrap = document.getElementById(id(boardId, "wbCanvasWrap"));
      if (wrap) new ResizeObserver(() => sizeCanvas(boardId)).observe(wrap);
    }
    s.initialized = true;
    if (isTabSurface(boardId)) s.zoomPct = (activeBrainstormBoard(boardId) || {}).zoom || 100; // restore the active tab's own zoom on first mount
  }
  if (isTabSurface(boardId)) renderBrainstormTabs(boardId);
  sizeCanvas(boardId);
}

// Same "measured while hidden" concern as everywhere else a canvas or
// textarea gets sized in this app — call this again once the board's
// page is actually visible, not just once at initial construction.
/* Legacy whiteboard storage left behind by the move to tabs.

   Board content used to live in state.whiteboards, keyed by surface.
   Those surfaces are tabbed now, so board() resolves through TAB_SURFACES
   into commBoards / brainstormBoards / dayofBoards and never reads the old
   entries for them — yet they are still saved and uploaded on every sync.

   NOT all of state.whiteboards is dead: board() still falls back to it for
   any surface that ISN'T tabbed, so an entry like `personal` is live data
   and must never be touched.

   HOW "ALREADY MIGRATED" IS PROVED.

   The first version of this compared counts — 227 legacy strokes, 227 live
   strokes, therefore safe. That proves nothing: two boards can hold the
   same number of completely different drawings.

   Comparing full content is the obvious correction and is also wrong, just
   in the other direction. A sticky note is editable: the live copy of a
   migrated note has usually been changed since — in this project's own
   data every legacy note lacks the `html` field its live counterpart has,
   because the text was edited after the migration. Demanding equality
   would refuse to clean up boards that migrated perfectly well.

   Identity is the right test, and both records carry a stable id. Every
   legacy stroke and note must have a counterpart WITH THE SAME ID in the
   live board. That proves the item made the journey; whatever happened to
   it afterwards is the live copy's business, and the live copy is the one
   that wins. If a single legacy id is unaccounted for, nothing is removed. */
export function findOrphanedWhiteboards() {
  const out = [];
  Object.keys(state.whiteboards || {}).forEach(key => {
    if (!isTabSurface(key)) return;                   // not a tabbed surface — live data
    const list = state[TAB_SURFACES[key].list];
    if (!Array.isArray(list) || !list.length) return; // nothing to have migrated into

    const legacy = state.whiteboards[key] || {};
    const legacyStrokes = legacy.strokes || [];
    const legacyObjects = legacy.objects || [];

    /* Strokes and notes need different proofs.

       A STROKE is immutable — once drawn it is never edited — so identical
       content IS proof of the same stroke. That matters because 100 of the
       227 strokes in this project's own data predate stroke ids entirely;
       requiring an id would refuse to clean up a board that migrated
       perfectly, purely because the drawing is old.

       A NOTE is editable, so its content legitimately drifts after
       migration and only the id can prove identity. A note with no id
       cannot be proved and therefore blocks removal. */
    const liveStrokeIds = new Set();
    const liveStrokeFingerprints = new Set();
    const liveObjectIds = new Set();
    const fingerprint = st => JSON.stringify([st.color, st.width, !!st.erase, st.points]);
    list.forEach(b => {
      (b.strokes || []).forEach(st => {
        if (!st) return;
        if (st.id != null) liveStrokeIds.add(st.id);
        try { liveStrokeFingerprints.add(fingerprint(st)); } catch (_) {}
      });
      (b.objects || []).forEach(o => { if (o && o.id != null) liveObjectIds.add(o.id); });
    });

    const missingStrokes = legacyStrokes.filter(st => {
      if (!st) return true;
      if (st.id != null) return !liveStrokeIds.has(st.id);
      try { return !liveStrokeFingerprints.has(fingerprint(st)); } catch (_) { return true; }
    });
    const missingObjects = legacyObjects.filter(o => o?.id == null || !liveObjectIds.has(o.id));

    out.push({
      key,
      kb: Math.round(JSON.stringify(legacy).length / 1024),
      strokes: legacyStrokes.length,
      objects: legacyObjects.length,
      missing: missingStrokes.length + missingObjects.length,
      safe: missingStrokes.length === 0 && missingObjects.length === 0
    });
  });
  return out;
}

export function dropOrphanedWhiteboards() {
  const found = findOrphanedWhiteboards().filter(o => o.safe);
  let kb = 0;
  /* Deleting the key locally is not enough. The cloud, and every other
     device, still holds it — and mergeIncomingWhiteboards unions the two
     key sets, so "we don't have it, they do" reads as "they added it" and
     the 607 KB comes straight back on the next sync. That is exactly what
     happened: a reclaimed 625 KB document grew back to 1,445 KB.

     A deletion has to be recorded as a fact that syncs, not as an absence.
     This list is part of the state, so it reaches every device, and the
     merge treats a listed key as deleted no matter who still has a copy. */
  state.removedWhiteboards = Array.isArray(state.removedWhiteboards) ? state.removedWhiteboards : [];
  found.forEach(o => {
    kb += o.kb;
    delete state.whiteboards[o.key];
    if (!state.removedWhiteboards.includes(o.key)) state.removedWhiteboards.push(o.key);
  });
  return { removed: found.map(o => o.key), kb };
}

export function resizeWhiteboardIfVisible(boardId) {
  const s = inst(boardId);
  if (s.canvas && s.canvas.offsetParent !== null) sizeCanvas(boardId);
}

function sizeCanvas(boardId) {
  const s = inst(boardId);
  if (!s.canvas) return;
  // Re-measured on every resize so dragging a note lower while fullscreen
  // grows the board to keep it in view.
  const area = s.canvas.closest(".wb-canvas-area");
  if (area && (getFullscreenElement() === area || area.classList.contains("wb-fallback-fullscreen"))) {
    applyFullscreenRatio(boardId, area);
  }
  const box = s.canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return; // still hidden — nothing to size yet
  // Capped rather than using the raw value — very high-resolution phones
  // can report devicePixelRatio well above 2, which multiplies the
  // canvas buffer size and the cost of every redraw for no visible
  // sharpness benefit past that point.
  s.dpr = Math.min(window.devicePixelRatio || 1, 2);
  s.canvas.width = box.width * s.dpr;
  s.canvas.height = box.height * s.dpr;
  s.ctx = s.canvas.getContext("2d");
  s.ctx.scale(s.dpr, s.dpr);
  redraw(boardId);
  renderObjects(boardId);
  renderConnectors(boardId);
  renderStickyArchive(boardId);
}

function redraw(boardId) {
  const s = inst(boardId);
  if (!s.ctx) return;
  const w = s.canvas.width / s.dpr, h = s.canvas.height / s.dpr;
  s.ctx.fillStyle = "#ffffff";
  s.ctx.fillRect(0, 0, w, h);
  s.ctx.lineCap = "round"; s.ctx.lineJoin = "round";
  board(boardId).strokes.forEach(st => drawStroke(s.ctx, st, w));
}

// Scale is a single factor (canvas width) applied to BOTH axes — this is
// what keeps the drawing's proportions intact instead of independently
// stretching X and squeezing Y when the canvas's aspect ratio differs
// from whatever it was when the stroke was originally recorded.
function drawStroke(ctx, stroke, scaleBasis) {
  if (stroke.points.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x * scaleBasis, stroke.points[0].y * scaleBasis);
  for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x * scaleBasis, stroke.points[i].y * scaleBasis);
  ctx.stroke();
  ctx.restore();
}

// Draws just the newest segment (previous point → new point) rather than
// the whole stroke — used while actively drawing, so each pointermove
// costs one short line instead of a full redraw. See file header.
function drawSegment(ctx, p1, p2, scaleBasis, stroke) {
  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(p1.x * scaleBasis, p1.y * scaleBasis);
  ctx.lineTo(p2.x * scaleBasis, p2.y * scaleBasis);
  ctx.stroke();
  ctx.restore();
}

/* Rounded to 4 decimals at capture. These are normalised 0–1 values, so
   4 decimals is finer than one pixel on a 4K display — visually identical,
   and the difference in what gets stored is not small:

     {"x":0.4718309859154929,"y":0.2536231884057971}   47 bytes
     {"x":0.4718,"y":0.2536}                           23 bytes

   Every point of every stroke on every board is in the payload that the
   whole-state save uploads on each sync, so full float precision was
   roughly doubling the size of the largest thing in it for no visible
   gain. Only new points are affected; existing strokes keep whatever
   precision they were saved with and render the same. */
/* Ramer-Douglas-Peucker, iterative rather than recursive: a long pen
   stroke on a tablet can carry several thousand points, and the recursive
   form overflows the stack on exactly the strokes that most need
   simplifying. */
function simplifyStroke(points, eps) {
  const n = points.length;
  if (n < 3) return points;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const a = points[lo], b = points[hi];
    const dx = b.x - a.x, dy = b.y - a.y;
    const den = Math.hypot(dx, dy) || 1e-9;
    let idx = -1, dmax = eps;
    for (let i = lo + 1; i < hi; i++) {
      const d = Math.abs(dy * points[i].x - dx * points[i].y + b.x * a.y - b.y * a.x) / den;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (idx !== -1) { keep[idx] = 1; stack.push([lo, idx], [idx, hi]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

function pointToNorm(canvas, evt) {
  const box = canvas.getBoundingClientRect();
  const r = n => Math.round(n * 1e4) / 1e4;
  // Both axes divided by width (not height) — see file header.
  return { x: r((evt.clientX - box.left) / box.width), y: r((evt.clientY - box.top) / box.width) };
}

function attachPointerHandlers(boardId, canvas) {
  canvas.addEventListener("pointerdown", (evt) => onPointerDown(boardId, evt, canvas));
  canvas.addEventListener("pointermove", (evt) => onPointerMove(boardId, evt, canvas));
  canvas.addEventListener("pointerup", (evt) => onPointerUp(boardId, evt, canvas));
  canvas.addEventListener("pointercancel", (evt) => onPointerUp(boardId, evt, canvas));
}

function onPointerDown(boardId, evt, canvas) {
  const s = inst(boardId);
  if (evt.pointerType === "touch") {
    // Finger and palm both report as "touch" in the Pointer Events spec —
    // neither ever draws (S Pen / Apple Pencil only). Checked ahead of
    // the tool-selected gate below, since pinch-zoom is a viewport
    // action, not a drawing one, and should work whether or not a pen
    // tool happens to be selected. A second finger landing turns this
    // into a pinch; a single finger just shows the existing hint.
    try { canvas.setPointerCapture(evt.pointerId); } catch (e) { /* pointer already invalidated — rare, harmless to skip */ }
    s.touchPoints.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    if (s.touchPoints.size === 2) {
      evt.preventDefault();
      s.pinching = true;
      s.pinchStartDist = touchDistance(s.touchPoints);
      s.pinchStartZoom = s.zoomPct;
    } else if (s.touchPoints.size === 1) {
      showTouchRejectedHint(boardId);
    }
    return;
  }
  if (!s.activeTool) return; // nothing selected — drawing is gated until a tool is explicitly chosen
  evt.preventDefault();
  s.drawing = true;
  s.currentStroke = s.activeTool === "eraser"
    ? { id: uid(), points: [pointToNorm(canvas, evt)], color: "#000000", width: ERASER_SIZES[s.activeEraserKey], erase: true }
    : { id: uid(), points: [pointToNorm(canvas, evt)], color: s.activeColor, width: WIDTHS[s.activeWidthKey], erase: false };
  try { canvas.setPointerCapture(evt.pointerId); } catch (e) { /* pointer already invalidated — rare, harmless to skip */ }
  // touch-action:none is set permanently in CSS, not toggled — see file
  // header for why that matters for actually preventing the page from
  // moving during a stroke.
}
const touchHintShownAt = {};
function showTouchRejectedHint(boardId) {
  const now = Date.now();
  if (now - (touchHintShownAt[boardId] || 0) < 2500) return; // don't spam a toast on every finger-scroll touch
  touchHintShownAt[boardId] = now;
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = "This whiteboard only draws with S Pen or Apple Pencil — finger scrolls instead";
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2200);
}
// Straight-line distance between the two active fingers, in raw client
// pixels — only their ratio to the distance at pinch-start matters, so
// no need to normalize against canvas size the way stroke points are.
function touchDistance(pointsMap) {
  const pts = Array.from(pointsMap.values());
  if (pts.length < 2) return 0;
  const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
  return Math.sqrt(dx * dx + dy * dy);
}
function onPointerMove(boardId, evt, canvas) {
  const s = inst(boardId);
  if (evt.pointerType === "touch" && s.touchPoints.has(evt.pointerId)) {
    s.touchPoints.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    if (s.pinching && s.touchPoints.size === 2 && s.pinchStartDist > 0) {
      evt.preventDefault();
      const ratio = touchDistance(s.touchPoints) / s.pinchStartDist;
      // Snapped to the nearest 5% — the same zoomPct steps the +/-
      // buttons already use — so setZoom (which resizes the actual
      // canvas buffer and redraws) only fires on a real, visible change
      // instead of on every sub-pixel finger jitter.
      const pct = Math.max(50, Math.min(200, Math.round(s.pinchStartZoom * ratio / 5) * 5));
      if (pct !== s.zoomPct) setZoom(boardId, pct);
    }
    return;
  }
  if (!s.drawing || !s.currentStroke) return;
  evt.preventDefault(); // the missing half of the fix — pointerdown alone isn't enough to suppress a gesture recognized from the move events that follow it
  const prevPoint = s.currentStroke.points[s.currentStroke.points.length - 1];
  const newPoint = pointToNorm(canvas, evt);
  if (!s.ctx) return;
  // Live segment always draws at full smoothness, regardless of what
  // gets stored — this only affects what's kept for saving/syncing.
  drawSegment(s.ctx, prevPoint, newPoint, s.canvas.width / s.dpr, s.currentStroke);
  // A stylus can fire pointermove far more often than a mouse, and
  // storing every single one (with no minimum spacing) makes a long
  // stroke accumulate hundreds of nearly-identical points — larger
  // payload to sync for no visible difference in the stroke's shape.
  // Only keep a point once it's moved a small minimum distance from the
  // last stored one.
  const dx = newPoint.x - prevPoint.x, dy = newPoint.y - prevPoint.y;
  if (Math.sqrt(dx * dx + dy * dy) > 0.003) s.currentStroke.points.push(newPoint);
}
function onPointerUp(boardId, evt, canvas) {
  const s = inst(boardId);
  if (evt.pointerType === "touch") {
    s.touchPoints.delete(evt.pointerId);
    if (s.touchPoints.size < 2) { s.pinching = false; s.pinchStartDist = 0; }
    return;
  }
  if (!s.drawing || !s.currentStroke) return;
  s.drawing = false;
  // The throttle in onPointerMove can skip storing points that are too
  // close together — always capture the true final position here so a
  // stroke's endpoint is never lost, and so a short, quick stroke that
  // never crossed the throttle distance still ends up with 2 points
  // instead of being silently dropped for having only 1.
  const finalPoint = pointToNorm(canvas, evt);
  const lastStored = s.currentStroke.points[s.currentStroke.points.length - 1];
  if (finalPoint.x !== lastStored.x || finalPoint.y !== lastStored.y) s.currentStroke.points.push(finalPoint);
  if (s.currentStroke.points.length > 1) {
    /* Simplify before storing, not later.

       The capture filter only rejects points that are physically close to
       the previous one. It cannot tell that forty points running along a
       gentle curve describe a shape four points describe identically, so a
       stroke arrives with roughly five times the points its shape needs —
       a single short pen stroke costs about 2 KB where 0.4 KB would do.
       That is why a little drawing moved the sync size so much.

       Ramer-Douglas-Peucker drops any point lying within a tolerance of
       the line between its neighbours. At an epsilon of roughly one pixel
       the rendered line is indistinguishable. Doing it here means the
       saving applies to every stroke from the moment it is drawn, instead
       of accumulating until someone remembers to run Reclaim space.

       The endpoints are always preserved, so a stroke never shortens. */
    s.currentStroke.points = simplifyStroke(s.currentStroke.points, 0.0012);
    board(boardId).strokes.push(s.currentStroke);
    persist(); // auto-save on every completed stroke
  }
  s.currentStroke = null;
}

export function selectPenTool(boardId) {
  const s = inst(boardId);
  s.activeTool = s.activeTool === "pen" ? null : "pen";
  s.penFlyoutOpen = s.activeTool === "pen"; // selecting the tool opens its picker; deselecting closes it
  renderToolbarState(boardId);
}
export function selectEraserTool(boardId) {
  const s = inst(boardId);
  s.activeTool = s.activeTool === "eraser" ? null : "eraser";
  s.eraserFlyoutOpen = s.activeTool === "eraser";
  renderToolbarState(boardId);
}
export function setWhiteboardColor(boardId, c) {
  const s = inst(boardId);
  s.activeColor = c;
  s.activeTool = "pen"; // choosing a color is a reasonable way to pick up the pen too, not just the dedicated Pen button
  s.penFlyoutOpen = false; // collapse once a choice is actually made, rather than staying open indefinitely
  renderToolbarState(boardId);
}
export function setWhiteboardWidth(boardId, k) {
  const s = inst(boardId);
  s.activeWidthKey = k;
  s.penFlyoutOpen = false;
  renderToolbarState(boardId);
}
export function setEraserSize(boardId, k) {
  const s = inst(boardId);
  s.activeEraserKey = k;
  s.eraserFlyoutOpen = false;
  renderToolbarState(boardId);
}

export function undoWhiteboardStroke(boardId) {
  const b = board(boardId);
  if (!b.strokes.length) return;
  b.strokes.pop();
  persist(); redraw(boardId);
}
export function clearWhiteboardPage(boardId) {
  const b = board(boardId);
  if (!b.strokes.length && !b.objects.length) return;
  const noteCount = b.objects.length;
  if (!confirm(
    `Clear this whiteboard?\n\n${b.strokes.length} drawing stroke(s) and ${noteCount} sticky note(s) ` +
    `will be moved to Trash, where you can restore them for 30 days.`
  )) return;
  // This used to say "this can't be undone", and it meant it — one click
  // destroyed every stroke and every sticky note on the board with no way
  // back. The whole page contents now go to Trash as a single entry, so
  // restoring puts the board back exactly as it was.
  moveToTrash("whiteboardPage", {
    id: uid(), boardId,
    strokes: structuredClone(b.strokes),
    objects: structuredClone(b.objects),
  }, { boardId });
  b.strokes = []; b.objects = [];
  persist(); redraw(boardId); renderObjects(boardId);
  toast(`Cleared — ${noteCount} note(s) and the drawing are in Trash`);
}

export function zoomWhiteboardIn(boardId) { setZoom(boardId, Math.min(200, inst(boardId).zoomPct + 25)); }
export function zoomWhiteboardOut(boardId) { setZoom(boardId, Math.max(50, inst(boardId).zoomPct - 25)); }
export function resetWhiteboardZoom(boardId) { setZoom(boardId, 100); }
function setZoom(boardId, pct) {
  const s = inst(boardId);
  s.zoomPct = pct;
  const outer = document.getElementById(id(boardId, "wbCanvasWrap"));
  if (outer) outer.style.width = pct + "%";
  const label = document.getElementById(id(boardId, "wbZoomLevel"));
  if (label) label.textContent = pct + "%";
  if (isTabSurface(boardId)) {
    const b = activeBrainstormBoard(boardId);
    if (b && b.zoom !== pct) { b.zoom = pct; b.updatedAt = Date.now(); persist(); }
  }
  // A real width change, not a CSS transform — the canvas genuinely
  // resizes, so it needs re-sizing and re-drawing at its new actual
  // pixel dimensions, the same pipeline already used for window resize.
  sizeCanvas(boardId);
}

/* ---------- Fullscreen — most useful on mobile, where a small screen
   makes the surrounding page chrome (sidebar, other cards) cost real
   drawing space. Adapts the same cross-browser pattern already proven
   for the World Map: native Fullscreen API when available, since it's
   genuinely more space than any modal; a CSS-based fallback class when
   it isn't (older/partial browser support), so the toggle still works
   everywhere unconditionally rather than silently doing nothing. ---------- */
function getRequestFullscreen(el) {
  return el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen || null;
}
function getExitFullscreen() {
  return document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen || null;
}
function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement || null;
}
const fullscreenWired = {};
export function toggleWhiteboardFullscreen(boardId) {
  const container = document.getElementById(id(boardId, "wbCanvasArea"));
  if (!container) return;
  wireFullscreenListeners(boardId, container);

  const reqFs = getRequestFullscreen(container);
  if (!reqFs) { container.classList.toggle("wb-fallback-fullscreen"); onFullscreenChanged(boardId, container); return; }

  if (getFullscreenElement() === container) {
    const exitFs = getExitFullscreen();
    if (exitFs) exitFs.call(document);
    return;
  }
  try {
    const result = reqFs.call(container);
    if (result && typeof result.catch === "function") {
      result.catch(() => { container.classList.add("wb-fallback-fullscreen"); onFullscreenChanged(boardId, container); });
    }
  } catch (e) {
    container.classList.add("wb-fallback-fullscreen");
    onFullscreenChanged(boardId, container);
  }
}
function wireFullscreenListeners(boardId, container) {
  if (fullscreenWired[boardId]) return;
  fullscreenWired[boardId] = true;
  ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(evt => {
    document.addEventListener(evt, () => onFullscreenChanged(boardId, container));
  });
}
/* How far down the board its content actually reaches, as a fraction of
   the board's WIDTH.

   Every coordinate — sticky notes and pen strokes alike — is stored as a
   fraction of the width, for both axes (see drawStroke: one scale factor
   for x and y, so drawings keep their proportions). That means a 4:3
   board can only ever show content down to y = 0.75. Anything placed
   below that simply falls outside it.

   Out of fullscreen this went unnoticed: the note layer has no clipping,
   so notes below the board still drew over the page beneath. Going
   fullscreen clips at the screen edge, so the same notes were suddenly
   cut in half — which looks like fullscreen breaking the board when it
   is really fullscreen revealing where the board's edge always was.

   Fullscreen therefore sizes itself to the content instead of to a fixed
   4:3, so entering it shows everything rather than less. */
function contentRatio(boardId) {
  const b = board(boardId);
  let deepest = 0.75; // never shrink below the normal 4:3 shape
  (b.objects || []).forEach(o => {
    if (o.deleted) return;
    deepest = Math.max(deepest, (o.y || 0) + (o.h || 0));
  });
  (b.strokes || []).forEach(st => (st.points || []).forEach(pt => {
    if (pt && typeof pt.y === "number") deepest = Math.max(deepest, pt.y);
  }));
  // A little breathing room below the lowest item, and a ceiling so one
  // stray note dragged far down can't squash the board to a sliver.
  return Math.min(3, deepest + 0.04);
}

function applyFullscreenRatio(boardId, container) {
  if (!container) return;
  container.style.setProperty("--wb-ratio", contentRatio(boardId).toFixed(4));
}

function onFullscreenChanged(boardId, container) {
  const isFull = getFullscreenElement() === container || container.classList.contains("wb-fallback-fullscreen");
  const btn = document.getElementById(id(boardId, "wbFullscreenBtn"));
  if (btn) btn.classList.toggle("on", isFull);
  // Measured before the browser lays fullscreen out, so the board is the
  // right shape on the first frame rather than jumping a moment later.
  applyFullscreenRatio(boardId, container);
  setTimeout(() => sizeCanvas(boardId), 60); // let the browser finish resizing first
}

function renderToolbarState(boardId) {
  const s = inst(boardId);
  const scope = document.getElementById(id(boardId, "wbFloatToolbar"))?.closest(".wb-canvas-area") || document;
  scope.querySelectorAll(".wb-color-swatch").forEach(el => {
    el.classList.toggle("on", el.dataset.color === s.activeColor && s.activeTool === "pen");
  });
  scope.querySelectorAll(".wb-width-btn").forEach(el => {
    el.classList.toggle("on", el.dataset.width === s.activeWidthKey);
  });
  scope.querySelectorAll(".wb-eraser-size-btn").forEach(el => {
    el.classList.toggle("on", el.dataset.size === s.activeEraserKey);
  });
  const penBtn = document.getElementById(id(boardId, "wbPenBtn"));
  if (penBtn) penBtn.classList.toggle("on", s.activeTool === "pen");
  const penFlyout = document.getElementById(id(boardId, "wbPenFlyout"));
  if (penFlyout) penFlyout.classList.toggle("open", s.activeTool === "pen" && s.penFlyoutOpen);
  const eraseBtn = document.getElementById(id(boardId, "wbEraseBtn"));
  if (eraseBtn) eraseBtn.classList.toggle("on", s.activeTool === "eraser");
  const eraserSizeBox = document.getElementById(id(boardId, "wbEraserSizes"));
  if (eraserSizeBox) eraserSizeBox.classList.toggle("open", s.activeTool === "eraser" && s.eraserFlyoutOpen);
  const stickyBtn = document.getElementById(id(boardId, "wbStickyBtn"));
  if (stickyBtn) stickyBtn.classList.toggle("on", s.activeTool === "sticky");
  const canvas = document.getElementById(id(boardId, "whiteboardCanvas"));
  if (canvas) canvas.style.cursor = !s.activeTool ? "not-allowed" : s.activeTool === "eraser" ? "cell" : "crosshair";
  const layer = document.getElementById(id(boardId, "wbObjLayer"));
  if (layer) layer.classList.toggle("creating", s.activeTool === "sticky");
}

/* ================================================================
   STICKY NOTES — the object layer sits over the single canvas, sized
   and positioned to match it exactly. Unlike pen/eraser strokes, notes
   are real DOM elements: individually selectable, draggable, resizable,
   and editable after the fact, which canvas pixels can never be.
   Positions/sizes are normalized against canvas width, the same scheme
   strokes use, so notes stay correctly placed and proportioned across
   zoom levels and screen sizes.
   ================================================================ */
const STICKY_COLORS = ["#FEF08A", "#FCA5A5", "#93C5FD", "#86EFAC", "#D8B4FE"];
const STICKY_DEFAULT_W = 0.15, STICKY_DEFAULT_H = 0.15;
// Smaller default footprint on phones only — a full desktop-sized note
// eats a big share of a phone screen the instant it's created. Desktop
// sizing is untouched; the note still grows naturally from typed text
// (via CSS) or a manual resize on either platform.
const STICKY_DEFAULT_W_MOBILE = 0.11, STICKY_DEFAULT_H_MOBILE = 0.09;
const STICKY_MIN = 0.06;
const STICKY_MAX = 0.6; // keeps a note from being resized larger than the board is useful for
let selectedStickyId = null;

// Same breakpoint the rest of the whiteboard's mobile CSS uses (see
// @media(max-width:767px) in style.css) — kept in one place so the
// default-size decision here and the layout rules there never drift.
function isMobileViewport() { return window.matchMedia("(max-width:767px)").matches; }
function defaultStickySize() {
  return isMobileViewport() ? { w: STICKY_DEFAULT_W_MOBILE, h: STICKY_DEFAULT_H_MOBILE } : { w: STICKY_DEFAULT_W, h: STICKY_DEFAULT_H };
}

/* ---------- Rich text ----------
   Notes now store formatted content as sanitized HTML (o.html) instead
   of plain text (o.text). o.text is read once as a migration source for
   pre-existing notes and never written to again. */
const STICKY_FONTS = [
  ["Sans-serif", "-apple-system,Segoe UI,Roboto,sans-serif"],
  ["Serif", "Georgia,'Times New Roman',serif"],
  ["Mono", "'Courier New',monospace"],
  ["Fraunces", "'Fraunces',serif"],
  ["Arial", "Arial,Helvetica,sans-serif"],
  ["Calibri", "Calibri,Candara,'Segoe UI',sans-serif"],
  ["Times New Roman", "'Times New Roman',Times,serif"],
  ["Verdana", "Verdana,Geneva,sans-serif"],
  ["Trebuchet MS", "'Trebuchet MS',sans-serif"],
  ["Garamond", "Garamond,'Times New Roman',serif"],
];
const STICKY_FONT_SIZES = [8,9,10,11,12,14,16,18,20,24,28,36,48,72]; // real point sizes, applied as a span style rather than execCommand's legacy 1-7 scale (see applyStickyFontSize)
const STICKY_TEXT_COLORS = ["#1B1B1A","#DC2626","#EA580C","#CA8A04","#16A34A","#2563EB","#7C3AED","#DB2777"];
const STICKY_HILITE_COLORS = ["#FEF08A","#FCA5A5","#93C5FD","#86EFAC","#D8B4FE","#FDBA74","#F9A8D4"];

// Every note's HTML round-trips through Supabase and gets rendered on
// another device via innerHTML — this is the render-time allowlist that
// makes that safe, independent of what actually produced the HTML
// (this editor's own toolbar, a stray paste, or old/foreign data).
// Sticky notes had their own allowlist; it now delegates to the shared
// sanitizer in sanitize.js so notes, journal entries and every other
// rich field are held to one identical standard rather than two that
// drift apart. The shared version is the stricter of the two: it also
// parses inertly via DOMParser and blocks javascript:/data: hrefs.
function sanitizeStickyHtml(html) {
  return sanitizeHtml(html);
}
// Reads a note's rich content, migrating a pre-rich-text note (plain
// o.text only) into o.html exactly once. Newlines become <br> so
// existing multi-line notes don't visually collapse on upgrade.
function getStickyHtml(o) {
  if (typeof o.html === "string") return o.html;
  o.html = esc(o.text || "").replace(/\n/g, "<br>");
  return o.html;
}

export function selectStickyTool(boardId) {
  const s = inst(boardId);
  s.activeTool = s.activeTool === "sticky" ? null : "sticky";
  renderToolbarState(boardId);
}

function attachLayerHandlers(boardId, layer) {
  if (!layer) return;
  layer.addEventListener("pointerdown", (evt) => {
    const s = inst(boardId);
    if (s.activeTool !== "sticky") return;
    if (evt.target !== layer) return; // clicked an existing note, not empty space — let the note handle it instead
    evt.stopPropagation(); // otherwise this same event also reaches the document-level "click elsewhere deselects" listener below, undoing the selection this creates
    const box = layer.getBoundingClientRect();
    const { w: dw, h: dh } = defaultStickySize();
    const normX = (evt.clientX - box.left) / box.width;
    const normY = (evt.clientY - box.top) / box.width;
    createSticky(boardId, Math.max(0, normX - dw / 2), Math.max(0, normY - dh / 2));
  });
}

function createSticky(boardId, normX, normY) {
  const { w, h } = defaultStickySize();
  // updatedAt drives both sync conflict resolution (see mergeBoardData
  // in this file) and soft-delete below — every mutation to a note
  // bumps it so the two devices' copies of the same note id can be
  // compared and the newer one kept, instead of one side's edit
  // silently winning just because of merge argument order.
  const obj = { id: uid(), x: normX, y: normY, w, h, html: "", color: STICKY_COLORS[0], updatedAt: Date.now() };
  board(boardId).objects.push(obj);
  selectedStickyId = obj.id;
  persist();
  renderObjects(boardId);
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-obj-id="${obj.id}"] .wb-sticky-text`);
    if (el) el.focus();
  });
}

function renderObjects(boardId) {
  const s = inst(boardId);
  if (!s.layer || !s.canvas) return;
  const w = s.canvas.width / s.dpr; // same basis as strokes

  /* Text scales with the board, exactly as the note's box already does.

     A note's x/y/w/h are fractions of the board width, so the BOX grows
     and shrinks with the view. The text inside it was a fixed 13px, so it
     did not — which meant the same note held roughly 21 characters per
     line in the normal view and 48 in fullscreen. Its content genuinely
     reflowed depending on where you looked at it, so a note that fitted
     perfectly on one screen was clipped on the other, and switching tabs
     or entering fullscreen appeared to truncate text at random.

     Tying the font to the board width makes a note's contents identical
     everywhere: same wrapping, same number of lines, same fit. 1000px is
     an arbitrary reference width at which the text renders at its natural
     13px; every other width scales proportionally. */
  if (s.layer) s.layer.style.setProperty("--wb-text-scale", (w / 1000).toFixed(4));
  const objs = board(boardId).objects.filter(o => !o.deleted); // tombstones stay in state for sync, never in the DOM

  // Reconcile against the existing DOM instead of the previous
  // `innerHTML = …` full rebuild. That rebuild ran on every render pass
  // — including the one triggered by the window "resize" event that
  // Android fires the instant its on-screen keyboard opens — which
  // destroyed and recreated every note's DOM node, including whichever
  // one currently held focus. Losing that node closes the keyboard
  // immediately, which is exactly the "keyboard opens then instantly
  // closes" symptom. Updating existing nodes in place, and never
  // touching a note's text while it's the focused element, means a
  // remote sync or a resize can no longer interrupt an edit in progress.
  const existingEls = {};
  Array.from(s.layer.children).forEach(el => { existingEls[el.dataset.objId] = el; });
  const keepIds = new Set();

  objs.forEach(o => {
    keepIds.add(o.id);
    let el = existingEls[o.id];
    if (!el) {
      s.layer.insertAdjacentHTML("beforeend", stickyHtml(o, w));
      el = s.layer.querySelector(`[data-obj-id="${o.id}"]`);
      attachStickyHandlers(boardId, o.id, w);
    } else {
      el.style.left = (o.x * w) + "px";
      el.style.top = (o.y * w) + "px";
      el.style.width = (o.w * w) + "px";
      el.style.height = (o.h * w) + "px";
      el.style.background = o.color;
      const textEl = el.querySelector(".wb-sticky-text");
      if (textEl && document.activeElement !== textEl) {
        const safeHtml = sanitizeStickyHtml(getStickyHtml(o));
        if (textEl.innerHTML !== safeHtml) {
          textEl.innerHTML = safeHtml; // never touch the note currently being edited
          /* A note whose text is taller than its box scrolls internally.
             While editing, the browser scrolls to keep the caret visible,
             and that scroll position survives the re-render — so the note
             is left showing its middle with the first lines hidden above,
             which reads as the text having been truncated. Reset to the
             top whenever the content is replaced and nobody is typing. */
          textEl.scrollTop = 0;
        }
      }
      el.querySelectorAll(".wb-sticky-color").forEach(b => b.classList.toggle("on", b.dataset.color === o.color));
    }
    el.classList.toggle("selected", o.id === selectedStickyId);
    markStickyOverflow(el);
  });

  // Only notes that are gone (deleted, or dropped entirely) still need
  // their DOM node removed.
  Object.keys(existingEls).forEach(objId => { if (!keepIds.has(objId)) existingEls[objId].remove(); });
}

// Where a ray from a rectangle's own center toward some other point
// crosses that rectangle's boundary — the actual "snap to the note's
// edge" mechanism. Because this is recomputed from each note's current
// position/size on every render rather than a stored anchor point, a
// connector automatically stays correctly attached no matter which of
// a note's four nodes was originally dragged from, and automatically
// re-clips to a sensible edge as the note moves or resizes.
function rectEdgePoint(cx, cy, tx, ty, rx, ry, rw, rh) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = rw / 2 || 0.0001, halfH = rh / 2 || 0.0001;
  const scale = Math.min(dx !== 0 ? halfW / Math.abs(dx) : Infinity, dy !== 0 ? halfH / Math.abs(dy) : Infinity);
  return { x: cx + dx * scale, y: cy + dy * scale };
}
function renderConnectors(boardId) {
  const svg = document.getElementById(id(boardId, "wbConnectorLayer"));
  const s = inst(boardId);
  if (!svg || !s.canvas) return;
  const w = s.canvas.width / s.dpr;  // width basis — stickyHtml() uses this for BOTH o.x*w and o.y*w
  const h = s.canvas.height / s.dpr; // the canvas's actual rendered height — NOT equal to w on this 4:3 canvas
  // stickyHtml() treats o.y*w as a direct pixel offset (not a value
  // that gets its own height-based rescaling) — so for this SVG to
  // agree with where notes actually are, one viewBox unit must equal
  // exactly one real pixel in BOTH directions. That only holds if the
  // viewBox's own height matches the canvas's true height; reusing w
  // for height here (as a same-value square) was the remaining bug —
  // preserveAspectRatio:none was necessary but not sufficient on its
  // own without this.
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  // Without this, a viewBox rendered into this canvas's actual
  // (non-square, 4:3) box gets letterboxed by SVG's default
  // aspect-ratio-preserving behavior — shrunk and centered rather than
  // stretched to fill — which silently shifts every coordinate away
  // from where sticky notes actually are, since those are positioned
  // with plain CSS pixels and have no equivalent aspect-ratio
  // correction applied to them at all.
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);

  const objs = board(boardId).objects.filter(o => !o.deleted);
  const byId = {};
  objs.forEach(o => { byId[o.id] = o; });
  const conns = (board(boardId).connectors || []).filter(c => byId[c.fromId] && byId[c.toId]);

  const defs = `<defs><marker id="wbArrow-${boardId}" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto-start-reverse">
    <path d="M0,0 L9,4.5 L0,9 z" class="wb-connector-arrowhead"></path></marker></defs>`;

  const lines = conns.map(c => {
    const a = byId[c.fromId], b = byId[c.toId];
    const ar = { x: a.x * w, y: a.y * w, w: a.w * w, h: a.h * w };
    const br = { x: b.x * w, y: b.y * w, w: b.w * w, h: b.h * w };
    const acx = ar.x + ar.w / 2, acy = ar.y + ar.h / 2;
    const bcx = br.x + br.w / 2, bcy = br.y + br.h / 2;
    const p1 = rectEdgePoint(acx, acy, bcx, bcy, ar.x, ar.y, ar.w, ar.h);
    const p2 = rectEdgePoint(bcx, bcy, acx, acy, br.x, br.y, br.w, br.h);
    // A gentle quadratic curve instead of a straight line — control
    // point offset perpendicular to the p1->p2 line, scaled to the
    // line's own length so short connectors stay nearly straight and
    // long ones get a visible, natural-looking arc rather than a
    // fixed offset that would look exaggerated on a short hop.
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(50, len * 0.18);
    const ctrlX = (p1.x + p2.x) / 2 + (-dy / len) * bow;
    const ctrlY = (p1.y + p2.y) / 2 + (dx / len) * bow;
    // Midpoint of the curve itself (De Casteljau at t=0.5), not the
    // straight-line midpoint, so the delete target sits ON the curve.
    const midX = 0.25 * p1.x + 0.5 * ctrlX + 0.25 * p2.x;
    const midY = 0.25 * p1.y + 0.5 * ctrlY + 0.25 * p2.y;
    const pathD = `M ${p1.x} ${p1.y} Q ${ctrlX} ${ctrlY} ${p2.x} ${p2.y}`;
    return `<g class="wb-connector" data-connector-id="${c.id}">
      <path d="${pathD}" class="wb-connector-hit"></path>
      <path d="${pathD}" class="wb-connector-line" marker-end="url(#wbArrow-${boardId})"></path>
      <circle cx="${midX}" cy="${midY}" r="7" class="wb-connector-del" onclick="deleteConnector('${boardId}','${c.id}')"><title>Delete connector</title></circle>
    </g>`;
  }).join("");

  svg.innerHTML = defs + lines;
}
function createConnector(boardId, fromId, toId) {
  const b = board(boardId);
  const already = b.connectors.some(c => (c.fromId === fromId && c.toId === toId) || (c.fromId === toId && c.toId === fromId));
  if (already) { console.log("[connector] already connected — skipped"); return; }
  b.connectors.push({ id: uid(), fromId, toId, updatedAt: Date.now() });
  persist();
  renderConnectors(boardId);
  console.log(`[connector] connected ${fromId} -> ${toId}`);
}
export function deleteConnector(boardId, connId) {
  const b = board(boardId);
  b.connectors = (b.connectors || []).filter(c => c.id !== connId);
  persist();
  renderConnectors(boardId);
}
// Callable directly from the browser console for quick cleanup after
// testing — clearBoardConnectors('gsi') for the Brainstorming board (its
// boardId is always "gsi" regardless of which tab is active), or
// clearBoardConnectors('overview') for the Whiteboard.
export function clearBoardConnectors(boardId) {
  const b = board(boardId);
  const n = (b.connectors || []).length;
  b.connectors = [];
  persist();
  renderConnectors(boardId);
  console.log(`[connector] cleared ${n} connector(s) from ${boardId}`);
  toast(`Cleared ${n} connector${n === 1 ? "" : "s"}`);
}
// Removes any connector touching a note that's just been deleted —
// otherwise a tombstoned note would leave a dangling line pointing at
// nothing (renderConnectors already filters these defensively too, but
// cleaning them up here keeps the data itself tidy rather than relying
// solely on the render-time filter).
function pruneConnectorsForNote(boardId, noteId) {
  const b = board(boardId);
  b.connectors = (b.connectors || []).filter(c => c.fromId !== noteId && c.toId !== noteId);
}
// Checked directly against every note's actual on-screen rect rather
// than document.elementFromPoint() at the exact release pixel —
// elementFromPoint returns whatever's topmost in paint order at that
// single point, which a nearby toolbar, color swatch row, or another
// note's chrome can easily win over the note itself. A geometric
// contains-check against every candidate note is immune to all of
// that; it only cares whether the release point is inside the note's
// actual bounding box.
function findStickyNear(boardId, clientX, clientY, excludeId, maxDist) {
  const layer = document.getElementById(id(boardId, "wbObjLayer"));
  if (!layer) { console.error("[connector] object layer not found for", boardId); return null; }
  let bestId = null, bestDist = Infinity;
  layer.querySelectorAll(".wb-sticky").forEach(el => {
    if (el.dataset.objId === excludeId) return;
    const r = el.getBoundingClientRect();
    // Distance from the point to the rect's nearest edge — 0 if the
    // point is already inside it, otherwise how far outside.
    const dx = Math.max(r.left - clientX, 0, clientX - r.right);
    const dy = Math.max(r.top - clientY, 0, clientY - r.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) { bestDist = dist; bestId = el.dataset.objId; }
  });
  const threshold = maxDist ?? 500; // raised again from 280px — short drags now connect correctly (confirming the aspect-ratio fix), but long downward drags still don't, which looks like a distance/gesture issue rather than a rendering one; a generous threshold here is low-risk either way
  if (bestId && bestDist > threshold) {
    console.log(`[connector] nearest note was ${Math.round(bestDist)}px away (limit ${threshold}px) — treating as no target`);
    return null;
  }
  return bestId;
}
function startConnectorDrag(boardId, fromId, evt) {
  const s = inst(boardId);
  const svg = document.getElementById(id(boardId, "wbConnectorLayer"));
  if (!s.canvas || !svg) return;
  const canvasRect = s.canvas.getBoundingClientRect();
  const w = s.canvas.width / s.dpr;
  const toSvgCoords = (clientX, clientY) => ({
    x: (clientX - canvasRect.left) / canvasRect.width * w,
    y: (clientY - canvasRect.top) / canvasRect.height * w,
  });
  const start = toSvgCoords(evt.clientX, evt.clientY);
  const preview = document.createElementNS("http://www.w3.org/2000/svg", "line");
  preview.setAttribute("class", "wb-connector-preview");
  preview.setAttribute("x1", start.x); preview.setAttribute("y1", start.y);
  preview.setAttribute("x2", start.x); preview.setAttribute("y2", start.y);
  svg.appendChild(preview);

  const onMove = (mv) => {
    mv.preventDefault();
    const p = toSvgCoords(mv.clientX, mv.clientY);
    preview.setAttribute("x2", p.x); preview.setAttribute("y2", p.y);
    // Live hover feedback — highlights whichever note is currently a
    // valid drop target, so it's clear before releasing whether the
    // connection will actually take.
    const hoverId = findStickyNear(boardId, mv.clientX, mv.clientY, fromId);
    document.querySelectorAll(`#${id(boardId, "wbObjLayer")} .wb-sticky.wb-connect-target`).forEach(x => {
      if (x.dataset.objId !== hoverId) x.classList.remove("wb-connect-target");
    });
    if (hoverId) document.querySelector(`#${id(boardId, "wbObjLayer")} [data-obj-id="${hoverId}"]`)?.classList.add("wb-connect-target");
  };
  const finish = (upEvt) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    preview.remove();
    document.querySelectorAll(`#${id(boardId, "wbObjLayer")} .wb-connect-target`).forEach(x => x.classList.remove("wb-connect-target"));
    if (!upEvt) return; // cancelled — the gesture was interrupted, not a deliberate drop; nothing should be created
    const toId = findStickyNear(boardId, upEvt.clientX, upEvt.clientY, fromId);
    if (toId) createConnector(boardId, fromId, toId);
    else toast("Drag onto another sticky note to connect them");
  };
  const onUp = (up) => finish(up);
  const onCancel = () => finish(null);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

// ---------- Sticky note archive ----------
// A "deleted" note is a tombstone (deleted:true), kept in place for
// sync safety (see the delete handler in attachStickyHandlers) rather
// than actually removed — this view is what makes that recoverable
// from the UI. Because the tombstone stays in the SAME board/tab's own
// objects array it was created in (never moved anywhere), restoring
// one is just flipping deleted back to false — it's already sitting in
// the right place, satisfying "restore to wherever it was deleted
// from" without needing to track that separately.
function stickyPreviewText(o) {
  const tmp = document.createElement("div");
  tmp.innerHTML = sanitizeStickyHtml(getStickyHtml(o));
  const text = (tmp.textContent || "").trim();
  return text ? text.slice(0, 140) : "(empty note)";
}
export function openStickyArchive(boardId) {
  const bg = document.getElementById(id(boardId, "wbStickyArchiveModalBg"));
  if (!bg) return;
  bg.classList.add("open");
  renderStickyArchive(boardId);
}
export function closeStickyArchive(boardId) {
  document.getElementById(id(boardId, "wbStickyArchiveModalBg"))?.classList.remove("open");
}
function renderStickyArchive(boardId) {
  const archived = board(boardId).objects.filter(o => o.deleted);
  const btn = document.getElementById(id(boardId, "wbStickyArchiveBtn"));
  if (btn) btn.textContent = `🗑 Archived notes (${archived.length})`;
  const list = document.getElementById(id(boardId, "wbStickyArchiveList"));
  if (!list) return;
  list.innerHTML = archived.length ? archived.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(o => `
    <div class="gsi-archive-row">
      <span class="gsi-archive-text" style="border-left:4px solid ${o.color};padding-left:8px">${esc(stickyPreviewText(o))}</span>
      <div class="gsi-archive-actions">
        <button class="btn btn-ghost" onclick="restoreStickyNote('${boardId}','${o.id}')">↺ Restore</button>
        <button class="icon-btn" onclick="deleteStickyNotePermanently('${boardId}','${o.id}')" title="Delete permanently">✕</button>
      </div>
    </div>`).join("") : `<p class="hint" style="padding:12px 0">No archived sticky notes.</p>`;
}
export function restoreStickyNote(boardId, objId) {
  const o = board(boardId).objects.find(x => x.id === objId);
  if (!o) return;
  o.deleted = false; o.updatedAt = Date.now();
  persist();
  renderObjects(boardId); renderConnectors(boardId);
  renderStickyArchive(boardId);
  toast("Note restored");
}
export function deleteStickyNotePermanently(boardId, objId) {
  if (!confirm("Permanently delete this note? This can't be undone.")) return;
  const b = board(boardId);
  b.objects = b.objects.filter(x => x.id !== objId);
  pruneConnectorsForNote(boardId, objId);
  persist();
  renderConnectors(boardId);
  renderStickyArchive(boardId);
  toast("Deleted permanently");
}

/* Flags a note whose text doesn't fit, so it can show that there is more
   to read rather than simply ending mid-sentence. Measured after layout,
   and cheap — a single scrollHeight read per note. */
function markStickyOverflow(el) {
  const t = el?.querySelector(".wb-sticky-text");
  if (!t) return;
  requestAnimationFrame(() => {
    /* clientHeight is 0 until the element has actually been laid out, and
       a freshly inserted note is measured before that happens — which made
       "scrollHeight > clientHeight" true for every note on the board,
       including empty ones. Requiring a real measured height, and a
       tolerance wider than a rounding error, keeps the marker for notes
       that genuinely have more text than fits. */
    if (!t.clientHeight) return;
    const clipped = t.scrollHeight > t.clientHeight + 6;
    el.classList.toggle("wb-sticky-clipped", clipped);
  });
}


function stickyHtml(o, w) {
  const px = o.x * w, py = o.y * w, pw = o.w * w, ph = o.h * w;
  const selected = o.id === selectedStickyId;
  return `
    <div class="wb-sticky ${selected ? "selected" : ""}" data-obj-id="${o.id}"
      style="left:${px}px;top:${py}px;width:${pw}px;height:${ph}px;background:${o.color}">
      <div class="wb-sticky-drag-handle" title="Drag to move"></div>
      <div class="wb-sticky-text" contenteditable="true" data-placeholder="Type something…">${sanitizeStickyHtml(getStickyHtml(o))}</div>
      <button class="wb-sticky-delete" title="Delete note">✕</button>
      <div class="wb-sticky-toolbar">
        ${STICKY_COLORS.map(c => `<button class="wb-sticky-color ${o.color === c ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}
      </div>
      <div class="wb-sticky-format-toolbar">
        <div class="wb-sfmt-row wb-sfmt-core">
          <button data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <div class="wb-sfmt-color-wrap" data-cmd="foreColor">
            <button class="wb-sfmt-color-btn" title="Text color"><span class="wb-sfmt-color-swatch" style="background:#1B1B1A"></span></button>
            <div class="wb-sfmt-color-pop">
              ${STICKY_TEXT_COLORS.map(c => `<button class="wb-sfmt-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
              <label class="wb-sfmt-swatch wb-sfmt-swatch-custom" title="Custom color">🎨<input type="color" class="wb-sfmt-color-custom"></label>
            </div>
          </div>
          <select class="wb-sfmt-size" data-cmd="fontSize" title="Font size">
            ${STICKY_FONT_SIZES.map(px => `<option value="${px}" ${px === 11 ? "selected" : ""}>${px}</option>`).join("")}
          </select>
          <button data-cmd="insertUnorderedList" title="Bulleted list">• ≡</button>
          <button class="wb-sfmt-more" title="More formatting">⋯</button>
        </div>
        <div class="wb-sfmt-row wb-sfmt-extra">
          <button data-cmd="undo" title="Undo (Ctrl+Z)">↺</button>
          <button data-cmd="redo" title="Redo (Ctrl+Y)">↻</button>
          <button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <div class="wb-sfmt-color-wrap" data-cmd="hiliteColor">
            <button class="wb-sfmt-color-btn" title="Highlight color"><span class="wb-sfmt-color-swatch" style="background:#FEF08A"></span></button>
            <div class="wb-sfmt-color-pop">
              <button class="wb-sfmt-swatch" data-color="transparent" style="background:#fff" title="No highlight">✕</button>
              ${STICKY_HILITE_COLORS.map(c => `<button class="wb-sfmt-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}
              <label class="wb-sfmt-swatch wb-sfmt-swatch-custom" title="Custom color">🎨<input type="color" class="wb-sfmt-color-custom"></label>
            </div>
          </div>
          <select class="wb-sfmt-font" data-cmd="fontName" title="Font family">
            ${STICKY_FONTS.map(([label, val]) => `<option value="${val}">${label}</option>`).join("")}
          </select>
          <button data-cmd="insertOrderedList" title="Numbered list">1. ≡</button>
          <button class="wb-sfmt-checklist" title="Checkbox list">☑ list</button>
          <button data-cmd="justifyLeft" title="Align left">L</button>
          <button data-cmd="justifyCenter" title="Align center">C</button>
          <button data-cmd="justifyRight" title="Align right">R</button>
          <button data-cmd="indent" title="Indent (Tab)">→</button>
          <button data-cmd="outdent" title="Outdent (Shift+Tab)">←</button>
          <button data-cmd="removeFormat" title="Clear formatting">Tx</button>
          <button data-cmd="insertHorizontalRule" title="Divider">―</button>
          <button class="wb-sfmt-link" title="Insert link (Ctrl+K)">🔗</button>
        </div>
      </div>
      <div class="wb-sticky-resize-handle" title="Drag to resize"></div>
      <div class="wb-sticky-node wb-sticky-node-n" data-side="n" title="Drag to connect"></div>
      <div class="wb-sticky-node wb-sticky-node-e" data-side="e" title="Drag to connect"></div>
      <div class="wb-sticky-node wb-sticky-node-s" data-side="s" title="Drag to connect"></div>
      <div class="wb-sticky-node wb-sticky-node-w" data-side="w" title="Drag to connect"></div>
    </div>`;
}

// Color popovers get temporarily reparented to <body> while open (see
// the color button handler below for why), so closing one has to both
// hide it and return it to the note it belongs to — otherwise it would
// be left stranded in <body>, detached from its own note.
function closeAllStickyColorPops() {
  document.querySelectorAll(".wb-sfmt-color-pop.open").forEach(p => {
    p.classList.remove("open");
    if (p._ownerWrap) p._ownerWrap.appendChild(p);
  });
}

function attachStickyHandlers(boardId, objId, canvasWidth) {
  /* The board width passed in is the one measured when this note's
     element was first created — and that is not safe to keep using.

     A note's x/y/w/h are stored as fractions of the board width, so every
     drag and resize converts through that number. If the board was
     measured while its page was hidden, or the note was created before
     the page was ever shown, the captured value is wrong and stays wrong
     for the life of the element: renderObjects reconciles existing nodes
     rather than rebuilding them, so these handlers are never re-attached
     with a corrected width. Zoom has the same effect — it changes the
     canvas width, but a note created before the zoom kept the old one.

     The symptom is a resize that fights back: the pointer moves one
     distance and the note changes by another, or clamps early against
     limits computed from the wrong width.

     Reading the width at pointerdown instead fixes both causes. It is
     read once per gesture, not per move, so a resize still tracks
     linearly with the pointer. */
  const stickyInst = inst(boardId);
  const boardWidth = () => {
    const live = stickyInst.canvas ? stickyInst.canvas.width / stickyInst.dpr : 0;
    return live > 0 ? live : (canvasWidth || 1); // fall back only if genuinely unmeasurable
  };
  const el = document.querySelector(`#${id(boardId, "wbObjLayer")} [data-obj-id="${objId}"]`);
  if (!el) return;
  const getObj = () => board(boardId).objects.find(o => o.id === objId);

  el.addEventListener("pointerdown", (evt) => {
    evt.stopPropagation(); // don't let this also trigger the layer's "create new note" handler
    selectedStickyId = objId;
    el.classList.add("selected");
    document.querySelectorAll(".wb-sticky.selected").forEach(other => { if (other !== el) other.classList.remove("selected"); });
  });

  // Text — contenteditable handles typing natively; just persist on blur
  // and on input, so it saves even if the user never clicks away.
  // Sanitizing happens at render time (renderObjects/stickyHtml), not on
  // every keystroke here — this is the user's own browser rendering
  // their own just-typed input, no different in risk from any other
  // text field. The one local vector for genuinely foreign markup is
  // paste, handled separately below.
  const textEl = el.querySelector(".wb-sticky-text");
  textEl.addEventListener("pointerdown", (evt) => evt.stopPropagation()); // typing shouldn't start a drag
  // Preview cards are built from the link each time, never typed, so they
  // are stripped before saving. Storing them would embed a stale copy of
  // someone else's page title in the note and stack a fresh card on top
  // of it every time the note was reopened.
  const saveHtml = () => {
    const o = getObj();
    if (o) { o.html = stripPreviewCards(textEl.innerHTML); o.updatedAt = Date.now(); persist(); }
  };

  // Fetching happens in the background; the note is usable meanwhile and
  // cards appear as they arrive. Failures are silent by design — a link
  // with no metadata just stays a plain link.
  const refreshLinkPreviews = () => { decorateLinks(textEl); };
  refreshLinkPreviews();

  // execCommand acts on the current selection, and clicking a toolbar
  // button/color-swatch would normally move focus away from the note
  // first, collapsing that selection before the command ever runs. This
  // tracks the last real selection inside this note so it can be
  // restored right before running a command, regardless of what else
  // took focus in between (a <select> or <input type=color> needs to
  // take real focus to open its native picker — pointerdown can't be
  // prevented on those the way it can on plain buttons).
  let lastRange = null;
  const saveRange = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && el.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreRange = () => {
    textEl.focus();
    if (!lastRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(lastRange);
  };
  textEl.addEventListener("mouseup", saveRange);
  textEl.addEventListener("keyup", saveRange);
  textEl.addEventListener("touchend", saveRange);

  const fmtToolbar = el.querySelector(".wb-sticky-format-toolbar");
  const updateActiveStates = () => {
    ["bold", "italic", "underline", "strikeThrough"].forEach(cmd => {
      const btn = fmtToolbar.querySelector(`button[data-cmd="${cmd}"]`);
      if (!btn) return;
      try { btn.classList.toggle("on", document.queryCommandState(cmd)); } catch (e) { /* unsupported in some browsers — harmless to skip */ }
    });
  };
  textEl.addEventListener("mouseup", updateActiveStates);
  textEl.addEventListener("keyup", updateActiveStates);

  fmtToolbar.addEventListener("pointerdown", (evt) => evt.stopPropagation()); // never let this reach the note's own drag-select logic
  fmtToolbar.querySelector(".wb-sfmt-more").addEventListener("click", () => fmtToolbar.classList.toggle("expanded"));

  // Plain command buttons (bold, italic, lists, align, indent, etc.) —
  // preventDefault on pointerdown keeps focus (and the selection) on
  // the note's text the entire time, so the click handler right after
  // can run execCommand immediately with no restoreRange() needed.
  fmtToolbar.querySelectorAll("button[data-cmd]").forEach(btn => {
    btn.addEventListener("pointerdown", (evt) => evt.preventDefault());
    btn.addEventListener("click", () => {
      document.execCommand(btn.dataset.cmd, false, null);
      saveHtml(); updateActiveStates();
    });
  });
  // Color pickers and the font/size selects genuinely need to take
  // focus to open their native UI, so the selection has to be
  // explicitly restored afterward instead of just never losing it.
  // fontSize/fontName both hit the same real bug: execCommand for
  // either only knows how to produce legacy <font size="X">/<font
  // face="X"> tags, and <font> was deliberately never added to the
  // sticky note sanitizer's allowlist — so the change would apply
  // instantly, then silently vanish the next time the note's HTML got
  // sanitized (on save or reload). The fix is the standard workaround:
  // use execCommand as a temporary marker, then immediately replace
  // whatever <font> it produced with an equivalent <span style="...">,
  // which the sanitizer does allow (font-size/font-family are both in
  // STICKY_ALLOWED_STYLE_PROPS).
  function applyFontStyle(cmd, cssProp, cssValue) {
    restoreRange();
    document.execCommand(cmd, false, cmd === "fontSize" ? "7" : "x-sticky-marker");
    const selector = cmd === "fontSize" ? 'font[size="7"]' : 'font[face="x-sticky-marker"]';
    textEl.querySelectorAll(selector).forEach(f => {
      const span = document.createElement("span");
      span.style[cssProp] = cssValue;
      while (f.firstChild) span.appendChild(f.firstChild);
      f.replaceWith(span);
    });
    saveHtml();
  }
  fmtToolbar.querySelector(".wb-sfmt-size").addEventListener("pointerdown", saveRange);
  fmtToolbar.querySelector(".wb-sfmt-size").addEventListener("change", (e) => applyFontStyle("fontSize", "fontSize", e.target.value + "px"));
  fmtToolbar.querySelector(".wb-sfmt-font").addEventListener("pointerdown", saveRange);
  fmtToolbar.querySelector(".wb-sfmt-font").addEventListener("change", (e) => applyFontStyle("fontName", "fontFamily", e.target.value));
  fmtToolbar.querySelectorAll(".wb-sfmt-color-wrap").forEach(wrap => {
    const cmd = wrap.dataset.cmd;
    const btn = wrap.querySelector(".wb-sfmt-color-btn");
    const pop = wrap.querySelector(".wb-sfmt-color-pop");
    pop._ownerWrap = wrap; // so closeAllStickyColorPops() can put it back where it came from
    const swatchEl = btn.querySelector(".wb-sfmt-color-swatch");
    const applyColor = (color) => {
      restoreRange();
      const sel = window.getSelection();
      // A collapsed selection (just a blinking cursor, nothing
      // highlighted) has no range worth wrapping — fall back to
      // "select everything" so a color always visibly applies to
      // something rather than silently doing nothing.
      if (!sel.rangeCount || sel.isCollapsed) {
        const r = document.createRange();
        r.selectNodeContents(textEl);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      try {
        const range = sel.getRangeAt(0);
        const cssProp = cmd === "foreColor" ? "color" : "backgroundColor";
        const span = document.createElement("span");
        span.style[cssProp] = color === "transparent" ? "transparent" : color;
        // extractContents+insertNode instead of range.surroundContents —
        // surroundContents throws if the range partially crosses an
        // existing element's boundary (e.g. a selection starting inside
        // a <b> tag and ending outside it), which is routine in rich
        // text that already has other formatting applied. This approach
        // works for any selection shape.
        const frag = range.extractContents();
        span.appendChild(frag);
        range.insertNode(span);
        sel.removeAllRanges();
        const after = document.createRange();
        after.selectNodeContents(span);
        sel.addRange(after);
        saveHtml();
      } catch (err) {
        console.error("[sticky-color] threw an error while applying:", err);
      }
      if (color !== "transparent") swatchEl.style.background = color;
      closeAllStickyColorPops();
    };
    btn.addEventListener("pointerdown", (evt) => {
      evt.preventDefault();
      saveRange();
      const wasOpen = pop.classList.contains("open");
      closeAllStickyColorPops();
      if (wasOpen) return; // it was already open — that click just closes it
      // Reparented to <body> before positioning, and this is the whole
      // point: .wb-sticky has a CSS `filter` and the format toolbar has
      // `backdrop-filter`, and EITHER of those makes that element the
      // containing block for a position:fixed descendant. So the
      // popover's "fixed" coordinates were being measured from the
      // note's own top-left corner instead of the viewport's, landing
      // it far away from its own button. Moving it out from under both
      // ancestors makes position:fixed behave normally again.
      document.body.appendChild(pop);
      pop.classList.add("open");
      const r = btn.getBoundingClientRect();
      const popW = pop.offsetWidth || 108, popH = pop.offsetHeight || 90;
      // Flip to stay on screen if the button is near an edge.
      const left = Math.min(r.left, window.innerWidth - popW - 8);
      const top = (r.bottom + 4 + popH > window.innerHeight) ? (r.top - popH - 4) : (r.bottom + 4);
      pop.style.left = Math.max(8, left) + "px";
      pop.style.top = Math.max(8, top) + "px";
    });
    wrap.querySelectorAll(".wb-sfmt-swatch[data-color]").forEach(sw => {
      sw.addEventListener("pointerdown", (evt) => evt.preventDefault());
      sw.addEventListener("click", () => applyColor(sw.dataset.color));
    });
    const customInput = wrap.querySelector(".wb-sfmt-color-custom");
    customInput.addEventListener("pointerdown", (evt) => { evt.stopPropagation(); saveRange(); });
    customInput.addEventListener("input", () => applyColor(customInput.value));
  });
  document.addEventListener("pointerdown", (evt) => {
    if (!evt.target.closest(".wb-sfmt-color-wrap") && !evt.target.closest(".wb-sfmt-color-pop")) closeAllStickyColorPops();
  });
  // Checkbox list — not a native execCommand; inserts a custom block
  // whose checkbox is contenteditable="false" (so clicking it toggles
  // state instead of placing a text cursor inside it) and toggled via
  // the delegated click handler on textEl below.
  fmtToolbar.querySelector(".wb-sfmt-checklist").addEventListener("pointerdown", (evt) => evt.preventDefault());
  /* The line the caret is on, rather than the note as a whole. Used to
     turn *that* line into a checkbox row instead of creating a new one. */
  function caretLineBlock() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const n = sel.anchorNode;
    const e = n ? (n.nodeType === 1 ? n : n.parentElement) : null;
    if (!e || !textEl.contains(e)) return null;
    const block = e.closest("div,p,li,h1,h2,h3,h4,blockquote");
    return block && block !== textEl && textEl.contains(block) ? block : null;
  }
  function caretAfter(node) {
    const sel = window.getSelection();
    const r = document.createRange();
    if (node.nodeType === 3) r.setStart(node, node.length); else r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    textEl.focus();
    saveRange();
  }

  fmtToolbar.querySelector(".wb-sfmt-checklist").addEventListener("click", () => {
    /* This used to run execCommand("insertHTML") with a <div>. Two things
       went wrong with that, and they're the two complaints about it:

       • Inserting a block element splits the line the caret is on, so with
         the caret at the start of a line the checkbox landed on a new line
         ABOVE the text it was meant to mark.
       • After the insert the caret ends up after the whole inserted block,
         not inside it, so typing continued on the next line rather than
         next to the checkbox.

       Both go away by not inserting a block at all: the line the caret is
       already on is turned into a checkbox row, and the caret is then
       placed explicitly after the spacer that follows the box. A caret
       cannot sit "inside" a contenteditable=false element, so that spacer
       is what makes a typing position next to the box exist at all. */
    restoreRange();
    const existing = (() => {
      const sel = window.getSelection();
      const n = sel && sel.rangeCount ? sel.anchorNode : null;
      const e = n ? (n.nodeType === 1 ? n : n.parentElement) : null;
      return e && textEl.contains(e) ? e.closest(".wb-check-item") : null;
    })();

    if (existing) {
      const box = existing.querySelector(".wb-check-box");
      if (box) box.remove();
      const first = existing.firstChild;
      if (first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^[\s\u00A0]+/, "");
      existing.classList.remove("wb-check-item", "done");
      if (!existing.getAttribute("class")) existing.removeAttribute("class");
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(existing, 0); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
      textEl.focus();
    } else {
      const box = document.createElement("span");
      box.className = "wb-check-box";
      box.setAttribute("contenteditable", "false");
      box.setAttribute("data-checked", "false");
      box.textContent = "☐";
      const spacer = document.createTextNode("\u00A0");
      const line = caretLineBlock();
      /* Where the caret should end up depends on whether the line already
         has words on it. On an empty line the box is being added so
         something can be typed next to it, so that's where the caret
         goes. On a line that already reads "Reports received from ER",
         yanking the caret to the front would be the button moving the
         cursor out from under the person — the original position is kept
         instead, and it stays valid because nothing is inserted after it. */
      const lineHadText = line ? line.textContent.replace(/[\s\u00A0]/g, "") !== "" : false;
      const keep = (() => {
        const sel = window.getSelection();
        return lineHadText && sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      })();
      if (line) {
        // Mark the existing line — its text stays put, nothing new is created.
        line.classList.add("wb-check-item");
        line.insertBefore(spacer, line.firstChild);
        line.insertBefore(box, line.firstChild);
        if (keep) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(keep);
          textEl.focus();
          saveRange();
          saveHtml();
          return;
        }
      } else {
        // Text typed straight into the note with no wrapping element yet.
        const div = document.createElement("div");
        div.className = "wb-check-item";
        div.appendChild(box);
        div.appendChild(spacer);
        const sel = window.getSelection();
        if (sel && sel.rangeCount) { const r = sel.getRangeAt(0); r.collapse(true); r.insertNode(div); }
        else textEl.appendChild(div);
      }
      caretAfter(spacer);
    }
    saveHtml();
  });
  const insertLink = () => {
    restoreRange();
    const url = prompt("Link URL:", "https://");
    if (!url) return;
    restoreRange();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      document.execCommand("insertHTML", false, `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">🔗 Open link</a>`);
      refreshLinkPreviews();
    } else {
      document.execCommand("createLink", false, url);
    }
    saveHtml();
  };
  fmtToolbar.querySelector(".wb-sfmt-link").addEventListener("pointerdown", (evt) => evt.preventDefault());
  fmtToolbar.querySelector(".wb-sfmt-link").addEventListener("click", insertLink);

  // Checkbox toggling — delegated so it works for every checklist item
  // in the note, including ones added after this listener was attached.
  textEl.addEventListener("click", (evt) => {
    const box = evt.target.closest(".wb-check-box");
    if (!box) return;
    evt.preventDefault();
    const on = box.dataset.checked === "true";
    box.dataset.checked = on ? "false" : "true";
    box.textContent = on ? "☐" : "☑";
    const item = box.closest(".wb-check-item");
    if (item) item.classList.toggle("done", !on);
    saveHtml();
  });

  // Auto-detects bare URLs and turns them into real links — run only on
  // blur (not per keystroke), since rewriting text nodes mid-typing is
  // exactly the kind of thing that fights a contenteditable's cursor
  // position and makes typing feel broken.
  const autoLinkOnBlur = () => {
    const urlRe = /(https?:\/\/[^\s<]+)/g;
    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement && n.parentElement.closest("a")) continue;
      urlRe.lastIndex = 0;
      if (urlRe.test(n.nodeValue)) targets.push(n);
    }
    targets.forEach(node => {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let lastIndex = 0, m; urlRe.lastIndex = 0;
      while ((m = urlRe.exec(text))) {
        if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
        const a = document.createElement("a");
        a.href = m[0]; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = "🔗 Open link";
        frag.appendChild(a);
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
      node.parentNode.replaceChild(frag, node);
    });
  };

  // Paste — the one local vector for genuinely foreign markup (an
  // external site's formatting, or worse), so it's sanitized on the way
  // in rather than relying solely on the render-time sanitize.
  textEl.addEventListener("paste", (evt) => {
    evt.preventDefault();
    const cd = evt.clipboardData || window.clipboardData;
    const html = cd.getData("text/html");
    const clean = html ? sanitizeStickyHtml(html) : esc(cd.getData("text/plain")).replace(/\n/g, "<br>");
    document.execCommand("insertHTML", false, clean);
    saveHtml();
  });

  /* ---------- removing a checkbox or an empty bullet ----------
     Neither can be deleted with Backspace on its own, for two separate
     browser reasons:

     • The checkbox is a contenteditable="false" span. Backspace beside a
       non-editable inline element is left to the browser, and browsers
       either ignore it or require selecting the element first — so the
       key appears to do nothing at all.
     • An empty list item has no character in front of the caret to
       remove, so Backspace has nothing to act on and the bullet stays.

     Both are handled explicitly below. Backspace is only intercepted
     when it would otherwise do nothing; in every other position it is
     left alone so normal typing and deleting are unaffected. */
  const elementAt = (node) => node ? (node.nodeType === 1 ? node : node.parentElement) : null;

  // Text between the start of `container` and the caret, ignoring the
  // checkbox itself and whitespace — i.e. "is the caret effectively at
  // the beginning of this line?"
  function nothingBeforeCaret(container, sel) {
    const r = sel.getRangeAt(0).cloneRange();
    r.selectNodeContents(container);
    try { r.setEnd(sel.anchorNode, sel.anchorOffset); }
    catch (e) { return false; } // caret isn't inside this container after all
    const holder = document.createElement("div");
    holder.appendChild(r.cloneContents());
    holder.querySelectorAll(".wb-check-box").forEach(b => b.remove());
    return holder.textContent.replace(/[\s\u00A0]/g, "") === "";
  }

  // Turns a checkbox row back into an ordinary line, keeping whatever was
  // typed on it. Deleting the row's text along with the box would be the
  // easier implementation and the wrong behaviour.
  function removeCheckbox(item) {
    const box = item.querySelector(".wb-check-box");
    if (box) box.remove();
    const first = item.firstChild;
    if (first && first.nodeType === 3) {
      first.nodeValue = first.nodeValue.replace(/^[\s\u00A0]+/, ""); // the spacer that followed the box
    }
    item.classList.remove("wb-check-item", "done");
    if (!item.getAttribute("class")) item.removeAttribute("class");
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(item, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /* Enter on a checkbox row.

     Left to the browser this does the wrong thing, and the reason is the
     layout: .wb-check-item is a flex row so the box and the text sit
     side by side and wrapped text lines up under itself. Pressing Enter
     splits the line by inserting a new element INSIDE that row — and a
     new child of a flex row is laid out beside its siblings, not below
     them. So the caret appears to jump sideways, which reads as a tab.

     Handling it here also lets the key do the more useful thing. On a row
     with text, Enter starts another checkbox row, the way a checklist
     behaves everywhere else. On an empty one it removes the checkbox and
     returns the line to normal text, which is the way out of the list —
     without that, a checklist would be a one-way door. Shift+Enter is
     left alone so a soft line break inside one item is still possible. */
  function handleEnterInCheckItem(evt) {
    if (evt.shiftKey) return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    const el = elementAt(sel.anchorNode);
    if (!el || !textEl.contains(el)) return false;
    const item = el.closest(".wb-check-item");
    if (!item) return false;

    evt.preventDefault();

    /* "Empty" means empty of *typed* text. item.textContent includes the
       box's own ☐ glyph, so measuring the row directly would find every
       row non-empty and the way out of the list would never trigger. */
    const typed = (() => {
      const clone = item.cloneNode(true);
      clone.querySelectorAll(".wb-check-box").forEach(b => b.remove());
      return clone.textContent.replace(/[\s\u00A0]/g, "");
    })();
    if (typed === "") {
      removeCheckbox(item); // nothing written on this row — step out of the list
      saveHtml();
      return true;
    }

    // Whatever sits after the caret moves down to the new row, so Enter
    // in the middle of a line splits it rather than discarding the tail.
    const range = sel.getRangeAt(0);
    const tailRange = range.cloneRange();
    tailRange.selectNodeContents(item);
    tailRange.setStart(range.endContainer, range.endOffset);
    const tail = tailRange.extractContents();
    // If the caret was somehow before the box, the box would travel with
    // the tail and the row would end up with two.
    tail.querySelectorAll(".wb-check-box").forEach(b => b.remove());

    const next = document.createElement("div");
    next.className = "wb-check-item";
    const box = document.createElement("span");
    box.className = "wb-check-box";
    box.setAttribute("contenteditable", "false");
    box.setAttribute("data-checked", "false");
    box.textContent = "☐";
    const spacer = document.createTextNode("\u00A0");
    next.appendChild(box);
    next.appendChild(spacer);
    next.appendChild(tail);
    item.parentNode.insertBefore(next, item.nextSibling);
    caretAfter(spacer);
    saveHtml();
    return true;
  }

  function handleBackspace(evt) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false; // a real selection deletes normally
    const el = elementAt(sel.anchorNode);
    if (!el || !textEl.contains(el)) return false;

    const item = el.closest(".wb-check-item");
    if (item && nothingBeforeCaret(item, sel)) {
      evt.preventDefault();
      removeCheckbox(item);
      saveHtml();
      return true;
    }
    const li = el.closest("li");
    if (li && li.textContent.replace(/[\s\u00A0]/g, "") === "" && !li.querySelector(".wb-check-box")) {
      evt.preventDefault();
      // Toggling the same list command off is what removes the bullet and
      // returns the line to normal flow.
      const ordered = li.parentElement && li.parentElement.tagName === "OL";
      document.execCommand(ordered ? "insertOrderedList" : "insertUnorderedList");
      saveHtml();
      return true;
    }
    return false;
  }

  textEl.addEventListener("keydown", (evt) => {
    const mod = evt.ctrlKey || evt.metaKey;
    const k = evt.key.toLowerCase();
    if (evt.key === "Enter" && !mod) {
      if (handleEnterInCheckItem(evt)) return;
    }
    if ((evt.key === "Backspace" || evt.key === "Delete") && !mod) {
      if (handleBackspace(evt)) return;
    }
    if (mod && k === "b") { evt.preventDefault(); document.execCommand("bold"); saveHtml(); updateActiveStates(); }
    else if (mod && k === "i") { evt.preventDefault(); document.execCommand("italic"); saveHtml(); updateActiveStates(); }
    else if (mod && k === "u") { evt.preventDefault(); document.execCommand("underline"); saveHtml(); updateActiveStates(); }
    else if (mod && k === "k") { evt.preventDefault(); insertLink(); }
    else if (evt.key === "Tab") { evt.preventDefault(); document.execCommand(evt.shiftKey ? "outdent" : "indent"); saveHtml(); }
    // Ctrl+Z / Ctrl+Y are left to the browser's native contenteditable
    // undo stack — preventDefault-ing those here would break it instead
    // of improving it.
  });

  textEl.addEventListener("input", saveHtml);
  textEl.addEventListener("blur", () => {
    autoLinkOnBlur(); saveHtml(); refreshLinkPreviews();
    /* No auto-fit here any more. Growing a note to fit its text looked
       right in whichever view it was measured in and wrong everywhere
       else — see the note on --wb-text-scale in renderObjects. Scaling the
       text with the board removes the need for it entirely. */
  });
  const openStickyLink = (evt) => {
    const a = evt.target.closest("a");
    if (a && a.href) { evt.preventDefault(); evt.stopPropagation(); window.open(a.href, "_blank", "noopener,noreferrer"); }
  };
  textEl.addEventListener("pointerdown", openStickyLink);
  textEl.addEventListener("click", openStickyLink); // kept as a fallback for any environment where pointerdown isn't supported

  // Drag — only from the dedicated handle, kept separate from the text
  // area so dragging and editing can never be ambiguous with each other.
  const dragHandle = el.querySelector(".wb-sticky-drag-handle");
  dragHandle.addEventListener("pointerdown", (evt) => {
    evt.preventDefault(); evt.stopPropagation();
    selectedStickyId = objId; el.classList.add("selected");
    document.querySelectorAll(".wb-sticky.selected").forEach(other => { if (other !== el) other.classList.remove("selected"); });
    try { dragHandle.setPointerCapture(evt.pointerId); } catch (e) { /* rare — harmless to skip */ }
    const startX = evt.clientX, startY = evt.clientY;
    const cw = boardWidth(); // measured now, not when the note was built
    const o = getObj(); const startLeft = o.x * cw, startTop = o.y * cw;
    const onMove = (mv) => {
      mv.preventDefault(); // finger dragging the handle shouldn't also scroll the page
      const nx = (startLeft + (mv.clientX - startX)) / cw;
      const ny = (startTop + (mv.clientY - startY)) / cw;
      el.style.left = (nx * cw) + "px";
      el.style.top = (ny * cw) + "px";
      o.x = Math.max(0, nx); o.y = Math.max(0, ny);
      renderConnectors(boardId);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const o2 = getObj(); if (o2) o2.updatedAt = Date.now();
      persist();
      renderConnectors(boardId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Resize — bottom-right corner handle, minimum size enforced so a note
  // can never be dragged down to nothing.
  const resizeHandle = el.querySelector(".wb-sticky-resize-handle");
  resizeHandle.addEventListener("pointerdown", (evt) => {
    evt.preventDefault(); evt.stopPropagation();
    selectedStickyId = objId; el.classList.add("selected");
    document.querySelectorAll(".wb-sticky.selected").forEach(other => { if (other !== el) other.classList.remove("selected"); });
    try { resizeHandle.setPointerCapture(evt.pointerId); } catch (e) { /* rare — harmless to skip */ }
    const startX = evt.clientX, startY = evt.clientY;
    const cw = boardWidth(); // measured now, not when the note was built
    const o = getObj(); const startW = o.w * cw, startH = o.h * cw;
    const onMove = (mv) => {
      mv.preventDefault(); // finger dragging the handle shouldn't also scroll the page
      const nw = Math.min(STICKY_MAX * cw, Math.max(STICKY_MIN * cw, startW + (mv.clientX - startX)));
      const nh = Math.min(STICKY_MAX * cw, Math.max(STICKY_MIN * cw, startH + (mv.clientY - startY)));
      el.style.width = nw + "px"; el.style.height = nh + "px";
      o.w = nw / cw; o.h = nh / cw;
      renderConnectors(boardId);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const o2 = getObj(); if (o2) o2.updatedAt = Date.now();
      persist();
      renderConnectors(boardId);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Color swatches
  el.querySelectorAll(".wb-sticky-color").forEach(btn => {
    btn.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    btn.addEventListener("click", () => {
      const o = getObj(); if (!o) return;
      o.color = btn.dataset.color;
      o.updatedAt = Date.now();
      el.style.background = o.color;
      el.querySelectorAll(".wb-sticky-color").forEach(b => b.classList.toggle("on", b === btn));
      persist();
    });
  });

  // Delete — a tombstone (deleted:true + updatedAt), not a splice. A
  // hard splice here only removes the note locally; if the other device
  // hadn't yet pulled this delete and pushes an edit of its own first,
  // the plain union-by-id merge in mergeBoardData would have no record
  // that this id was ever removed and would silently bring it back.
  // Keeping a timestamped tombstone lets merge compare it against a
  // concurrent edit the same way it compares any other conflicting
  // change, so whichever one is actually newer wins. renderObjects
  // already filters deleted:true notes out of what's drawn.
  el.querySelector(".wb-sticky-delete").addEventListener("pointerdown", (evt) => evt.stopPropagation());
  el.querySelector(".wb-sticky-delete").addEventListener("click", () => {
    closeAllStickyColorPops(); // this button stops propagation, so the usual outside-click close never runs
    const o = getObj();
    if (o) { o.deleted = true; o.updatedAt = Date.now(); }
    if (selectedStickyId === objId) selectedStickyId = null;
    persist();
    el.remove();
    renderConnectors(boardId); // connectors touching this note are filtered out while it's deleted, not pruned — see deleteStickyNotePermanently for the actual prune point
    renderStickyArchive(boardId);
  });

  // Connector nodes — dragging from one of a note's four small handles
  // to another note creates a connector between them. The actual line
  // rendering (renderConnectors above) always clips to each note's
  // nearest edge automatically, so which of the four nodes was grabbed
  // only matters for starting the gesture, not for where the line
  // visually ends up.
  el.querySelectorAll(".wb-sticky-node").forEach(node => {
    node.addEventListener("pointerdown", (evt) => {
      evt.preventDefault(); evt.stopPropagation();
      selectedStickyId = objId; el.classList.add("selected");
      document.querySelectorAll(".wb-sticky.selected").forEach(other => { if (other !== el) other.classList.remove("selected"); });
      try { node.setPointerCapture(evt.pointerId); } catch (e) { /* rare — harmless to skip */ }
      startConnectorDrag(boardId, objId, evt);
    });
  });
}

// Clicking anywhere outside a note deselects it (hides its toolbar/handle).
document.addEventListener("pointerdown", (evt) => {
  if (evt.target.closest(".wb-sticky")) return;
  if (selectedStickyId) {
    selectedStickyId = null;
    document.querySelectorAll(".wb-sticky.selected").forEach(el => el.classList.remove("selected"));
  }
});

/* ================================================================
   BRAINSTORMING TABS — multiple independent Brainstorming boards,
   switched like browser tabs. Only the GSI board ("gsi") gets tabs;
   Overview's "Whiteboard" is untouched and still reads
   state.whiteboards.overview exactly as it always has. See board()
   above: board('gsi') now resolves to whichever entry in
   state.brainstormBoards is active, so drawing, erasing, undo, and
   sticky notes all become per-tab automatically without any changes
   of their own — they already only ever went through board(boardId).

   Pan position: there is no panning feature anywhere in this app
   today (only zoom). Each tab still carries a `pan` field so a real
   pan feature could read/write it later without another migration,
   but nothing currently moves it — this is a placeholder, not a
   working pan implementation.

   Redo: doesn't exist for this whiteboard (only undoWhiteboardStroke,
   a single-step "undo last stroke," does) — not fabricated here.
   ================================================================ */
let renamingTabId = null;
/* One archive modal serves both boards, so it has to remember which one
   opened it — otherwise Restore would put a Day Of tab back onto the GSI
   board, where it would appear to have vanished. */
let archiveSurface = "gsi";
let openTabMenuId = null;

function nextUntitledName(surface) {
  const taken = new Set(tabList(surface).filter(b => !b.deleted).map(b => b.name));
  if (!taken.has("Untitled")) return "Untitled";
  let n = 2;
  while (taken.has(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

export function addBrainstormBoard(surface = "gsi") {
  const obj = {
    id: TAB_SURFACES[surface].prefix + uid(), name: nextUntitledName(surface), archived: false,
    strokes: [], objects: [], zoom: 100, pan: { x: 0, y: 0 },
    createdAt: Date.now(), updatedAt: Date.now()
  };
  tabList(surface).push(obj);
  switchBrainstormBoard(obj.id, surface);
}

export function switchBrainstormBoard(tabId, surface = "gsi") {
  const b = tabList(surface).find(x => x.id === tabId && !x.deleted);
  if (!b) return;
  state[TAB_SURFACES[surface].active] = tabId;
  selectedStickyId = null; // a note selected on the previous tab shouldn't carry over
  /* Notes are reconciled against the existing DOM rather than rebuilt, so
     an element can be reused for a note that happens to share an id across
     tabs — carrying its scroll position with it and showing the new note
     from the middle. Clearing here means every tab opens at the top of
     each note. */
  const layer = inst(surface).layer;
  if (layer) layer.querySelectorAll(".wb-sticky-text").forEach(t => { t.scrollTop = 0; });
  persist(false); // which tab is active is local UI state, not a content edit — see persist()'s own note on this distinction
  renderBrainstormTabs(surface);
  setZoom(surface, b.zoom || 100); // also runs sizeCanvas, which repaints strokes + sticky notes from the newly active board
}

function startRenameBrainstormTab(tabId, surface = "gsi") {
  closeBrainstormTabMenu();
  const nameEl = document.querySelector(`.wb-tab-name[data-tab-id="${tabId}"]`);
  if (!nameEl) return;
  renamingTabId = tabId;
  nameEl.contentEditable = "true";
  nameEl.focus();
  try {
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  } catch (e) { /* selection API quirks — harmless if this doesn't select everything */ }

  const finish = (commit) => {
    nameEl.removeEventListener("keydown", onKeydown);
    nameEl.removeEventListener("blur", onBlur);
    nameEl.contentEditable = "false";
    const b = tabList(surface).find(x => x.id === tabId);
    if (commit && b) {
      const v = nameEl.textContent.trim();
      if (v) { b.name = v; b.updatedAt = Date.now(); persist(); }
    }
    renamingTabId = null;
    renderBrainstormTabs(surface);
  };
  const onKeydown = (evt) => {
    if (evt.key === "Enter") { evt.preventDefault(); finish(true); }
    else if (evt.key === "Escape") { evt.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true); // clicking outside saves, per spec
  nameEl.addEventListener("keydown", onKeydown);
  nameEl.addEventListener("blur", onBlur);
}

/* THE TAB ⋮ FLYOUT LIVES ON <body>, NOT INSIDE THE TAB.

   As a child of .wb-tab it was at the mercy of every ancestor between it
   and the page. .wb-tabs is a horizontal scroller (overflow-x:auto), and
   per spec scrolling one axis clips the other — overflow-y computes to
   auto, not visible. Above that, .card carries both backdrop-filter and
   container-type:inline-size, and each of those establishes a containing
   block for fixed-position descendants, so even position:fixed would have
   stayed trapped inside the card.

   Chasing which ancestor was responsible is the wrong fight, because the
   answer changes with any future styling of the card or the tab strip.
   Appending the flyout to <body> and positioning it from the button's
   viewport rect ends the whole class of problem: no ancestor overflow,
   stacking context, filter or containment can reach it.

   It is also then rebuild-proof. renderBrainstormTabs() replaces the tab
   strip's innerHTML on every render; a menu parked inside a tab was
   destroyed mid-interaction by any state change. */

const TAB_MENU_ACTIONS = [
  { action: "rename",    label: "Rename" },
  { action: "share",     label: "Copy link to this board" },
  { action: "duplicate", label: "Duplicate" },
  { action: "archive",   label: "Archive" },
  { action: "delete",    label: "Delete", danger: true },
];

let tabFlyoutEl = null;
let tabFlyoutCtx = null;

function tabFlyout() {
  if (tabFlyoutEl) return tabFlyoutEl;
  tabFlyoutEl = document.createElement("div");
  tabFlyoutEl.className = "wb-tab-menu";
  tabFlyoutEl.setAttribute("role", "menu");
  tabFlyoutEl.innerHTML = TAB_MENU_ACTIONS.map(a =>
    `<button role="menuitem" ${a.danger ? 'class="danger"' : ""} data-action="${a.action}">${a.label}</button>`).join("");
  tabFlyoutEl.addEventListener("click", (evt) => {
    const btn = evt.target.closest("button[data-action]");
    if (!btn || !tabFlyoutCtx) return;
    evt.stopPropagation();
    const { tabId, surface } = tabFlyoutCtx;
    closeBrainstormTabMenu();
    const action = btn.dataset.action;
    if (action === "rename") startRenameBrainstormTab(tabId, surface);
    else if (action === "share") shareBrainstormBoard(tabId, surface);
    else if (action === "duplicate") duplicateBrainstormBoard(tabId, surface);
    else if (action === "archive") archiveBrainstormBoard(tabId, surface);
    else if (action === "delete") deleteBrainstormBoardFromTabBar(tabId, surface);
  });
  document.body.appendChild(tabFlyoutEl);
  return tabFlyoutEl;
}

/* Right-aligned under the ⋮ button, then pulled back inside the viewport.
   The last tab in a scrolled strip sits hard against the right edge, and
   on a phone the menu is wider than the space left beside it — without
   the clamp it would render off-screen, which looks identical to the bug
   this replaced. Flips above the button when there is no room below. */
function positionTabFlyout(btn) {
  const m = tabFlyout();
  const r = btn.getBoundingClientRect();
  const pad = 8;
  m.style.visibility = "hidden";
  m.classList.add("open");
  const mw = m.offsetWidth, mh = m.offsetHeight;

  let left = r.right - mw;
  left = Math.min(left, window.innerWidth - mw - pad);
  left = Math.max(pad, left);

  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - pad) {
    const above = r.top - 4 - mh;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - mh - pad);
  }
  m.style.left = left + "px";
  m.style.top = top + "px";
  m.style.visibility = "";
}

function toggleBrainstormTabMenu(tabId, surface = "gsi", btn = null) {
  if (openTabMenuId === tabId) { closeBrainstormTabMenu(); return; }
  openTabMenuId = tabId;
  tabFlyoutCtx = { tabId, surface };
  const anchor = btn || document.querySelector(`.wb-tab-menu-btn[data-tab-id="${tabId}"]`);
  if (!anchor) { closeBrainstormTabMenu(); return; }
  positionTabFlyout(anchor);
}

function closeBrainstormTabMenu() {
  openTabMenuId = null;
  tabFlyoutCtx = null;
  tabFlyoutEl?.classList.remove("open");
}

/* Scrolling or resizing moves the button out from under a fixed flyout,
   so it closes rather than hovering somewhere meaningless. Capture phase
   catches scrolls inside the tab strip, not just the window. */
window.addEventListener("scroll", () => { if (openTabMenuId) closeBrainstormTabMenu(); }, true);
window.addEventListener("resize", () => { if (openTabMenuId) closeBrainstormTabMenu(); });
document.addEventListener("keydown", (evt) => { if (evt.key === "Escape" && openTabMenuId) closeBrainstormTabMenu(); });

document.addEventListener("pointerdown", (evt) => {
  if (evt.target.closest(".wb-tab-menu") || evt.target.closest(".wb-tab-menu-btn")) return;
  if (openTabMenuId) closeBrainstormTabMenu();
});

/* Hands the board's id, name and surface to the share module. Only the id
   travels in the link — the board itself is never copied anywhere, which
   is what keeps the link private to this account. */
export function shareBrainstormBoard(tabId, surface) {
  const tab = tabList(surface).find(b => b.id === tabId);
  openShareBoardDialog(tabId, tab ? tab.name : "Board", surface);
}

export function duplicateBrainstormBoard(tabId, surface = "gsi") {
  const src = tabList(surface).find(x => x.id === tabId && !x.deleted);
  if (!src) return;
  const clone = {
    id: "bb_" + uid(), name: src.name + " copy", archived: false,
    // Fresh ids on every stroke and note — reusing the source's ids
    // would make the sync merge treat this tab's content as literally
    // the same strokes/notes as the original tab's the next time both
    // sync, corrupting both instead of producing two independent tabs.
    strokes: (src.strokes || []).map(s => ({ ...s, id: uid() })),
    objects: (src.objects || []).filter(o => !o.deleted).map(o => ({ ...o, id: uid(), updatedAt: Date.now() })),
    zoom: src.zoom || 100,
    pan: src.pan ? { ...src.pan } : { x: 0, y: 0 },
    createdAt: Date.now(), updatedAt: Date.now()
  };
  tabList(surface).push(clone);
  switchBrainstormBoard(clone.id);
  toast(`Duplicated "${src.name}"`);
}

export function archiveBrainstormBoard(tabId, surface = "gsi") {
  const boards = tabList(surface) || [];
  const b = boards.find(x => x.id === tabId && !x.deleted);
  if (!b) return;
  const remaining = boards.filter(x => x.id !== tabId && !x.archived && !x.deleted);
  if (!remaining.length) { toast("Can't archive the only open tab — add another one first"); return; }
  b.archived = true; b.updatedAt = Date.now();
  const wasActive = state[TAB_SURFACES[surface].active] === tabId;
  persist();
  if (wasActive) switchBrainstormBoard(remaining[0].id); else renderBrainstormTabs(surface);
  toast(`Archived "${b.name}"`);
}

// The tab-bar "Delete" is deliberately the same safe archive underneath
// — one accidental tap here shouldn't be able to permanently destroy a
// board's drawings. It only differs from Archive in asking for
// confirmation first, since "Delete" reads as more final to whoever's
// using it. Truly permanent removal only happens from the Archived
// Boards manager's own "Delete Permanently", below.
export function deleteBrainstormBoardFromTabBar(tabId, surface = "gsi") {
  const b = tabList(surface).find(x => x.id === tabId && !x.deleted);
  if (!b) return;
  if (!confirm(`Delete "${b.name}"? It moves to Archived Boards, where you can restore it or delete it permanently.`)) return;
  archiveBrainstormBoard(tabId);
}

export function openBrainstormArchive(surface = "gsi") {
  archiveSurface = surface;
  const modal = document.getElementById("wbArchiveModalBg");
  if (!modal) return;
  modal.classList.add("open");
  renderBrainstormArchiveList();
}
export function closeBrainstormArchive(surface = "gsi") {
  const modal = document.getElementById("wbArchiveModalBg");
  if (modal) modal.classList.remove("open");
}
function renderBrainstormArchiveList() {
  const box = document.getElementById("wbArchiveList");
  if (!box) return;
  const archived = tabList(surface).filter(b => b.archived && !b.deleted);
  box.innerHTML = archived.map(b => `
    <div class="gsi-archive-row">
      <span class="gsi-archive-text">${esc(b.name)}</span>
      <div class="gsi-archive-actions">
        <button class="gsi-archive-restore" onclick="restoreBrainstormBoard('${b.id}','${archiveSurface}')">↺ Restore</button>
        <button class="gsi-archive-remove" onclick="deleteBrainstormBoardPermanently('${b.id}','${archiveSurface}')" title="Delete permanently">✕</button>
      </div>
    </div>`).join("") || `<p class="hint" style="padding:12px 0">No archived boards — boards you archive from a tab's ⋮ menu will appear here.</p>`;
}
export function restoreBrainstormBoard(tabId, surface = "gsi") {
  const b = tabList(surface).find(x => x.id === tabId);
  if (!b) return;
  b.archived = false; b.updatedAt = Date.now();
  persist();
  renderBrainstormArchiveList();
  renderBrainstormTabs(surface);
  toast(`Restored "${b.name}"`);
}
export function deleteBrainstormBoardPermanently(tabId, surface = "gsi") {
  const b = tabList(surface).find(x => x.id === tabId);
  if (!b) return;
  if (!confirm(`Permanently delete "${b.name}"? This can't be undone.`)) return;
  // Tombstoned (deleted:true), not spliced out — same reasoning as the
  // sticky-note delete above: splicing only removes it locally, and if
  // the other device hadn't yet pulled this delete before pushing an
  // unrelated change of its own, a plain array merge would have no
  // record the tab was ever removed and would bring it back.
  // mergeIncomingBrainstormBoards (supabase.js) prunes old tombstones.
  b.deleted = true; b.updatedAt = Date.now();
  persist();
  renderBrainstormArchiveList();
  renderBrainstormTabs(surface);
  toast(`Deleted "${b.name}"`);
}

function renderBrainstormTabs(surface) {
  const list = document.getElementById(id(surface, "wbTabsList"));
  if (!list) return;
  if (renamingTabId) return; // don't blow away an in-progress inline rename with a rebuild

  const boards = tabList(surface).filter(b => !b.archived && !b.deleted);
  if (!boards.length) { addBrainstormBoard(surface); return; } // always leaves at least one open tab; recurses exactly once
  if (!boards.some(b => b.id === state[TAB_SURFACES[surface].active])) state[TAB_SURFACES[surface].active] = boards[0].id;

  list.innerHTML = boards.map(b => `
    <div class="wb-tab ${b.id === state[TAB_SURFACES[surface].active] ? "active" : ""}" data-tab-id="${b.id}">
      <span class="wb-tab-name" data-tab-id="${b.id}">${esc(b.name)}</span>
      <button class="wb-tab-menu-btn" title="Tab options" data-tab-id="${b.id}">⋮</button>
    </div>`).join("");

  list.querySelectorAll(".wb-tab").forEach(el => {
    const tabId = el.dataset.tabId;
    el.addEventListener("click", (evt) => {
      if (evt.target.closest(".wb-tab-menu") || evt.target.closest(".wb-tab-menu-btn")) return;
      if (evt.target.isContentEditable) return; // mid-rename — a stray click shouldn't switch tabs
      switchBrainstormBoard(tabId, surface);
    });
    const nameEl = el.querySelector(".wb-tab-name");
    nameEl.addEventListener("dblclick", (evt) => { evt.stopPropagation(); startRenameBrainstormTab(tabId, surface); }); // desktop
    let pressTimer = null;
    nameEl.addEventListener("pointerdown", (evt) => {
      if (evt.pointerType !== "touch") return;
      pressTimer = setTimeout(() => startRenameBrainstormTab(tabId, surface), 550); // mobile long-press
    });
    const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    nameEl.addEventListener("pointerup", cancelPress);
    nameEl.addEventListener("pointercancel", cancelPress);
    nameEl.addEventListener("pointermove", cancelPress);

    const menuBtn = el.querySelector(".wb-tab-menu-btn");
    menuBtn.addEventListener("click", (evt) => { evt.stopPropagation(); toggleBrainstormTabMenu(tabId, surface, menuBtn); });
  });

  /* The flyout lives on <body>, so a re-render doesn't destroy it — but it
     does replace the ⋮ button it was positioned against. Re-anchor to the
     new button, or close if that tab is gone. */
  if (openTabMenuId) {
    const btn = list.querySelector(`.wb-tab-menu-btn[data-tab-id="${openTabMenuId}"]`);
    if (btn) positionTabFlyout(btn); else closeBrainstormTabMenu();
  }

  const archiveBtn = document.getElementById(id(surface, "wbTabsArchiveBtn"));
  if (archiveBtn) {
    const n = tabList(surface).filter(b => b.archived && !b.deleted).length;
    archiveBtn.textContent = `🗄 Archived${n ? ` (${n})` : ""}`;
  }
  if (document.getElementById("wbArchiveModalBg")?.classList.contains("open")) renderBrainstormArchiveList();
}

