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
import { state, persist, uid, esc } from './state.js';
import { toast } from './ui.js';

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
function activeBrainstormBoard() {
  const boards = state.brainstormBoards || [];
  let b = boards.find(x => x.id === state.activeBrainstormBoard && !x.archived && !x.deleted);
  if (!b) b = boards.find(x => !x.archived && !x.deleted) || boards[0];
  if (b && state.activeBrainstormBoard !== b.id) state.activeBrainstormBoard = b.id;
  return b || null;
}
function board(boardId) {
  if (boardId === "gsi") {
    const b = activeBrainstormBoard();
    if (!b) return { strokes: [], objects: [] }; // no tabs at all (shouldn't happen — addBrainstormBoard always leaves one)
    b.objects = b.objects || [];
    return b;
  }
  state.whiteboards[boardId] = state.whiteboards[boardId] || { strokes: [], objects: [] };
  const b = state.whiteboards[boardId];
  b.objects = b.objects || []; // additive field — older saved boards predate sticky notes
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
    const key = s.id || JSON.stringify(s.points[0]) + s.color + s.points.length; // fallback for strokes saved before ids existed
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
  return { strokes, objects };
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
    s.initialized = true;
    if (boardId === "gsi") s.zoomPct = (activeBrainstormBoard() || {}).zoom || 100; // restore the active tab's own zoom on first mount
  }
  if (boardId === "gsi") renderBrainstormTabs();
  sizeCanvas(boardId);
}

// Same "measured while hidden" concern as everywhere else a canvas or
// textarea gets sized in this app — call this again once the board's
// page is actually visible, not just once at initial construction.
export function resizeWhiteboardIfVisible(boardId) {
  const s = inst(boardId);
  if (s.canvas && s.canvas.offsetParent !== null) sizeCanvas(boardId);
}

function sizeCanvas(boardId) {
  const s = inst(boardId);
  if (!s.canvas) return;
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

function pointToNorm(canvas, evt) {
  const box = canvas.getBoundingClientRect();
  // Both axes divided by width (not height) — see file header.
  return { x: (evt.clientX - box.left) / box.width, y: (evt.clientY - box.top) / box.width };
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
  if (!confirm("Clear this whiteboard? This can't be undone.")) return;
  b.strokes = []; b.objects = [];
  persist(); redraw(boardId); renderObjects(boardId);
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
  if (boardId === "gsi") {
    const b = activeBrainstormBoard();
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
function onFullscreenChanged(boardId, container) {
  const isFull = getFullscreenElement() === container || container.classList.contains("wb-fallback-fullscreen");
  const btn = document.getElementById(id(boardId, "wbFullscreenBtn"));
  if (btn) btn.classList.toggle("on", isFull);
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
  const obj = { id: uid(), x: normX, y: normY, w, h, text: "", color: STICKY_COLORS[0], updatedAt: Date.now() };
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
  const objs = board(boardId).objects.filter(o => !o.deleted); // tombstones stay in state for sync, never in the DOM

  // TEMPORARY — remove once sync is confirmed reliable across devices.
  console.log(`[sticky-sync] ${boardId}: rendering ${objs.length} note(s)`);

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
      if (textEl && document.activeElement !== textEl && textEl.textContent !== o.text) {
        textEl.textContent = o.text; // never touch the text node of the note currently being edited
      }
      el.querySelectorAll(".wb-sticky-color").forEach(b => b.classList.toggle("on", b.dataset.color === o.color));
    }
    el.classList.toggle("selected", o.id === selectedStickyId);
  });

  // Only notes that are gone (deleted, or dropped entirely) still need
  // their DOM node removed.
  Object.keys(existingEls).forEach(objId => { if (!keepIds.has(objId)) existingEls[objId].remove(); });
}

function stickyHtml(o, w) {
  const px = o.x * w, py = o.y * w, pw = o.w * w, ph = o.h * w;
  const selected = o.id === selectedStickyId;
  return `
    <div class="wb-sticky ${selected ? "selected" : ""}" data-obj-id="${o.id}"
      style="left:${px}px;top:${py}px;width:${pw}px;height:${ph}px;background:${o.color}">
      <div class="wb-sticky-drag-handle" title="Drag to move"></div>
      <div class="wb-sticky-text" contenteditable="true" data-placeholder="Type something…">${esc(o.text)}</div>
      <button class="wb-sticky-delete" title="Delete note">✕</button>
      <div class="wb-sticky-toolbar">
        ${STICKY_COLORS.map(c => `<button class="wb-sticky-color ${o.color === c ? "on" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}
      </div>
      <div class="wb-sticky-resize-handle" title="Drag to resize"></div>
    </div>`;
}

function attachStickyHandlers(boardId, objId, canvasWidth) {
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
  const textEl = el.querySelector(".wb-sticky-text");
  textEl.addEventListener("pointerdown", (evt) => evt.stopPropagation()); // typing shouldn't start a drag
  const saveText = () => { const o = getObj(); if (o) { o.text = textEl.textContent; o.updatedAt = Date.now(); persist(); } };
  textEl.addEventListener("input", saveText);
  textEl.addEventListener("blur", saveText);

  // Drag — only from the dedicated handle, kept separate from the text
  // area so dragging and editing can never be ambiguous with each other.
  const dragHandle = el.querySelector(".wb-sticky-drag-handle");
  dragHandle.addEventListener("pointerdown", (evt) => {
    evt.preventDefault(); evt.stopPropagation();
    selectedStickyId = objId; el.classList.add("selected");
    try { dragHandle.setPointerCapture(evt.pointerId); } catch (e) { /* rare — harmless to skip */ }
    const startX = evt.clientX, startY = evt.clientY;
    const o = getObj(); const startLeft = o.x * canvasWidth, startTop = o.y * canvasWidth;
    const onMove = (mv) => {
      mv.preventDefault(); // finger dragging the handle shouldn't also scroll the page
      const nx = (startLeft + (mv.clientX - startX)) / canvasWidth;
      const ny = (startTop + (mv.clientY - startY)) / canvasWidth;
      el.style.left = (nx * canvasWidth) + "px";
      el.style.top = (ny * canvasWidth) + "px";
      o.x = Math.max(0, nx); o.y = Math.max(0, ny);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const o2 = getObj(); if (o2) o2.updatedAt = Date.now();
      persist();
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
    try { resizeHandle.setPointerCapture(evt.pointerId); } catch (e) { /* rare — harmless to skip */ }
    const startX = evt.clientX, startY = evt.clientY;
    const o = getObj(); const startW = o.w * canvasWidth, startH = o.h * canvasWidth;
    const onMove = (mv) => {
      mv.preventDefault(); // finger dragging the handle shouldn't also scroll the page
      const nw = Math.min(STICKY_MAX * canvasWidth, Math.max(STICKY_MIN * canvasWidth, startW + (mv.clientX - startX)));
      const nh = Math.min(STICKY_MAX * canvasWidth, Math.max(STICKY_MIN * canvasWidth, startH + (mv.clientY - startY)));
      el.style.width = nw + "px"; el.style.height = nh + "px";
      o.w = nw / canvasWidth; o.h = nh / canvasWidth;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const o2 = getObj(); if (o2) o2.updatedAt = Date.now();
      persist();
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
    const o = getObj();
    if (o) { o.deleted = true; o.updatedAt = Date.now(); }
    if (selectedStickyId === objId) selectedStickyId = null;
    persist();
    el.remove();
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
let openTabMenuId = null;

function nextUntitledName() {
  const taken = new Set((state.brainstormBoards || []).filter(b => !b.deleted).map(b => b.name));
  if (!taken.has("Untitled")) return "Untitled";
  let n = 2;
  while (taken.has(`Untitled ${n}`)) n++;
  return `Untitled ${n}`;
}

export function addBrainstormBoard() {
  if (!state.brainstormBoards) state.brainstormBoards = [];
  const obj = {
    id: "bb_" + uid(), name: nextUntitledName(), archived: false,
    strokes: [], objects: [], zoom: 100, pan: { x: 0, y: 0 },
    createdAt: Date.now(), updatedAt: Date.now()
  };
  state.brainstormBoards.push(obj);
  switchBrainstormBoard(obj.id);
}

export function switchBrainstormBoard(tabId) {
  const b = (state.brainstormBoards || []).find(x => x.id === tabId && !x.deleted);
  if (!b) return;
  state.activeBrainstormBoard = tabId;
  selectedStickyId = null; // a note selected on the previous tab shouldn't carry over
  persist(false); // which tab is active is local UI state, not a content edit — see persist()'s own note on this distinction
  renderBrainstormTabs();
  setZoom("gsi", b.zoom || 100); // also runs sizeCanvas, which repaints strokes + sticky notes from the newly active board
}

function startRenameBrainstormTab(tabId) {
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
    const b = (state.brainstormBoards || []).find(x => x.id === tabId);
    if (commit && b) {
      const v = nameEl.textContent.trim();
      if (v) { b.name = v; b.updatedAt = Date.now(); persist(); }
    }
    renamingTabId = null;
    renderBrainstormTabs();
  };
  const onKeydown = (evt) => {
    if (evt.key === "Enter") { evt.preventDefault(); finish(true); }
    else if (evt.key === "Escape") { evt.preventDefault(); finish(false); }
  };
  const onBlur = () => finish(true); // clicking outside saves, per spec
  nameEl.addEventListener("keydown", onKeydown);
  nameEl.addEventListener("blur", onBlur);
}

function toggleBrainstormTabMenu(tabId) {
  openTabMenuId = openTabMenuId === tabId ? null : tabId;
  document.querySelectorAll(".wb-tab-menu").forEach(m => m.classList.toggle("open", m.dataset.tabId === openTabMenuId));
}
function closeBrainstormTabMenu() {
  openTabMenuId = null;
  document.querySelectorAll(".wb-tab-menu.open").forEach(m => m.classList.remove("open"));
}
document.addEventListener("pointerdown", (evt) => {
  if (evt.target.closest(".wb-tab-menu") || evt.target.closest(".wb-tab-menu-btn")) return;
  if (openTabMenuId) closeBrainstormTabMenu();
});

export function duplicateBrainstormBoard(tabId) {
  const src = (state.brainstormBoards || []).find(x => x.id === tabId && !x.deleted);
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
  state.brainstormBoards.push(clone);
  switchBrainstormBoard(clone.id);
  toast(`Duplicated "${src.name}"`);
}

export function archiveBrainstormBoard(tabId) {
  const boards = state.brainstormBoards || [];
  const b = boards.find(x => x.id === tabId && !x.deleted);
  if (!b) return;
  const remaining = boards.filter(x => x.id !== tabId && !x.archived && !x.deleted);
  if (!remaining.length) { toast("Can't archive the only open tab — add another one first"); return; }
  b.archived = true; b.updatedAt = Date.now();
  const wasActive = state.activeBrainstormBoard === tabId;
  persist();
  if (wasActive) switchBrainstormBoard(remaining[0].id); else renderBrainstormTabs();
  toast(`Archived "${b.name}"`);
}

// The tab-bar "Delete" is deliberately the same safe archive underneath
// — one accidental tap here shouldn't be able to permanently destroy a
// board's drawings. It only differs from Archive in asking for
// confirmation first, since "Delete" reads as more final to whoever's
// using it. Truly permanent removal only happens from the Archived
// Boards manager's own "Delete Permanently", below.
export function deleteBrainstormBoardFromTabBar(tabId) {
  const b = (state.brainstormBoards || []).find(x => x.id === tabId && !x.deleted);
  if (!b) return;
  if (!confirm(`Delete "${b.name}"? It moves to Archived Boards, where you can restore it or delete it permanently.`)) return;
  archiveBrainstormBoard(tabId);
}

export function openBrainstormArchive() {
  const modal = document.getElementById("wbArchiveModalBg");
  if (!modal) return;
  modal.classList.add("open");
  renderBrainstormArchiveList();
}
export function closeBrainstormArchive() {
  const modal = document.getElementById("wbArchiveModalBg");
  if (modal) modal.classList.remove("open");
}
function renderBrainstormArchiveList() {
  const box = document.getElementById("wbArchiveList");
  if (!box) return;
  const archived = (state.brainstormBoards || []).filter(b => b.archived && !b.deleted);
  box.innerHTML = archived.map(b => `
    <div class="gsi-archive-row">
      <span class="gsi-archive-text">${esc(b.name)}</span>
      <div class="gsi-archive-actions">
        <button class="gsi-archive-restore" onclick="restoreBrainstormBoard('${b.id}')">↺ Restore</button>
        <button class="gsi-archive-remove" onclick="deleteBrainstormBoardPermanently('${b.id}')" title="Delete permanently">✕</button>
      </div>
    </div>`).join("") || `<p class="hint" style="padding:12px 0">No archived boards — boards you archive from a tab's ⋮ menu will appear here.</p>`;
}
export function restoreBrainstormBoard(tabId) {
  const b = (state.brainstormBoards || []).find(x => x.id === tabId);
  if (!b) return;
  b.archived = false; b.updatedAt = Date.now();
  persist();
  renderBrainstormArchiveList();
  renderBrainstormTabs();
  toast(`Restored "${b.name}"`);
}
export function deleteBrainstormBoardPermanently(tabId) {
  const b = (state.brainstormBoards || []).find(x => x.id === tabId);
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
  renderBrainstormTabs();
  toast(`Deleted "${b.name}"`);
}

function renderBrainstormTabs() {
  const list = document.getElementById("wbTabsList");
  if (!list) return;
  if (renamingTabId) return; // don't blow away an in-progress inline rename with a rebuild

  const boards = (state.brainstormBoards || []).filter(b => !b.archived && !b.deleted);
  if (!boards.length) { addBrainstormBoard(); return; } // always leaves at least one open tab; recurses exactly once
  if (!boards.some(b => b.id === state.activeBrainstormBoard)) state.activeBrainstormBoard = boards[0].id;

  list.innerHTML = boards.map(b => `
    <div class="wb-tab ${b.id === state.activeBrainstormBoard ? "active" : ""}" data-tab-id="${b.id}">
      <span class="wb-tab-name" data-tab-id="${b.id}">${esc(b.name)}</span>
      <button class="wb-tab-menu-btn" title="Tab options" data-tab-id="${b.id}">⋮</button>
      <div class="wb-tab-menu" data-tab-id="${b.id}">
        <button data-action="rename">Rename</button>
        <button data-action="duplicate">Duplicate</button>
        <button data-action="archive">Archive</button>
        <button class="danger" data-action="delete">Delete</button>
      </div>
    </div>`).join("");

  list.querySelectorAll(".wb-tab").forEach(el => {
    const tabId = el.dataset.tabId;
    el.addEventListener("click", (evt) => {
      if (evt.target.closest(".wb-tab-menu") || evt.target.closest(".wb-tab-menu-btn")) return;
      if (evt.target.isContentEditable) return; // mid-rename — a stray click shouldn't switch tabs
      switchBrainstormBoard(tabId);
    });
    const nameEl = el.querySelector(".wb-tab-name");
    nameEl.addEventListener("dblclick", (evt) => { evt.stopPropagation(); startRenameBrainstormTab(tabId); }); // desktop
    let pressTimer = null;
    nameEl.addEventListener("pointerdown", (evt) => {
      if (evt.pointerType !== "touch") return;
      pressTimer = setTimeout(() => startRenameBrainstormTab(tabId), 550); // mobile long-press
    });
    const cancelPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    nameEl.addEventListener("pointerup", cancelPress);
    nameEl.addEventListener("pointercancel", cancelPress);
    nameEl.addEventListener("pointermove", cancelPress);

    el.querySelector(".wb-tab-menu-btn").addEventListener("click", (evt) => { evt.stopPropagation(); toggleBrainstormTabMenu(tabId); });
    el.querySelectorAll(".wb-tab-menu button").forEach(btn => {
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        closeBrainstormTabMenu();
        const action = btn.dataset.action;
        if (action === "rename") startRenameBrainstormTab(tabId);
        else if (action === "duplicate") duplicateBrainstormBoard(tabId);
        else if (action === "archive") archiveBrainstormBoard(tabId);
        else if (action === "delete") deleteBrainstormBoardFromTabBar(tabId);
      });
    });
  });

  if (openTabMenuId) {
    const menu = list.querySelector(`.wb-tab-menu[data-tab-id="${openTabMenuId}"]`);
    if (menu) menu.classList.add("open"); else openTabMenuId = null;
  }

  const archiveBtn = document.getElementById("wbTabsArchiveBtn");
  if (archiveBtn) {
    const n = (state.brainstormBoards || []).filter(b => b.archived && !b.deleted).length;
    archiveBtn.textContent = `🗄 Archived${n ? ` (${n})` : ""}`;
  }
  if (document.getElementById("wbArchiveModalBg")?.classList.contains("open")) renderBrainstormArchiveList();
}
