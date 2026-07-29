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
  renderConnectors(boardId);
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

/* ---------- Rich text ----------
   Notes now store formatted content as sanitized HTML (o.html) instead
   of plain text (o.text). o.text is read once as a migration source for
   pre-existing notes and never written to again. */
const STICKY_FONTS = [["Sans-serif","-apple-system,Segoe UI,Roboto,sans-serif"],["Serif","Georgia,'Times New Roman',serif"],["Mono","'Courier New',monospace"],["Fraunces","'Fraunces',serif"]];
const STICKY_FONT_SIZES = [["S","2"],["M","3"],["L","5"],["XL","6"]]; // legacy execCommand fontSize scale (1-7)

// Every note's HTML round-trips through Supabase and gets rendered on
// another device via innerHTML — this is the render-time allowlist that
// makes that safe, independent of what actually produced the HTML
// (this editor's own toolbar, a stray paste, or old/foreign data).
const STICKY_ALLOWED_TAGS = new Set(["B","STRONG","I","EM","U","S","STRIKE","SPAN","DIV","P","BR","UL","OL","LI","A","HR","LABEL"]);
const STICKY_ALLOWED_ATTRS = { SPAN: ["style"], DIV: ["class"], A: ["href","target","rel"], LI: ["class"] };
const STICKY_ALLOWED_STYLE_PROPS = /^(color|background-color|font-size|font-family|text-align)\s*:/i;
function sanitizeStickyHtml(html) {
  const root = document.createElement("div");
  root.innerHTML = html || "";
  (function walk(node) {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === 3) return; // plain text — always safe
      if (child.nodeType !== 1) { node.removeChild(child); return; } // comments etc.
      if (!STICKY_ALLOWED_TAGS.has(child.tagName)) {
        while (child.firstChild) node.insertBefore(child.firstChild, child); // unwrap, keep the content
        node.removeChild(child);
        return;
      }
      const allowedAttrs = STICKY_ALLOWED_ATTRS[child.tagName] || [];
      Array.from(child.attributes).forEach(attr => {
        if (!allowedAttrs.includes(attr.name.toLowerCase())) child.removeAttribute(attr.name);
      });
      if (child.tagName === "SPAN" && child.hasAttribute("style")) {
        const safe = child.getAttribute("style").split(";").map(s => s.trim())
          .filter(s => STICKY_ALLOWED_STYLE_PROPS.test(s)).join(";");
        if (safe) child.setAttribute("style", safe); else child.removeAttribute("style");
      }
      if (child.tagName === "A") {
        const href = child.getAttribute("href") || "";
        if (!/^https?:\/\//i.test(href)) child.removeAttribute("href");
        else { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
      }
      walk(child);
    });
  })(root);
  return root.innerHTML;
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
      if (textEl && document.activeElement !== textEl) {
        const safeHtml = sanitizeStickyHtml(getStickyHtml(o));
        if (textEl.innerHTML !== safeHtml) textEl.innerHTML = safeHtml; // never touch the note currently being edited
      }
      el.querySelectorAll(".wb-sticky-color").forEach(b => b.classList.toggle("on", b.dataset.color === o.color));
    }
    el.classList.toggle("selected", o.id === selectedStickyId);
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
  const w = s.canvas.width / s.dpr; // same basis stickyHtml() uses for both x and y
  svg.setAttribute("viewBox", `0 0 ${w} ${w}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", w);

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
  if (already) return;
  b.connectors.push({ id: uid(), fromId, toId, updatedAt: Date.now() });
  persist();
  renderConnectors(boardId);
}
export function deleteConnector(boardId, connId) {
  const b = board(boardId);
  b.connectors = (b.connectors || []).filter(c => c.id !== connId);
  persist();
  renderConnectors(boardId);
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
  const threshold = maxDist ?? 120; // generous — this is meant to be forgiving, not pixel-precise
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
          <input type="color" class="wb-sfmt-color" data-cmd="foreColor" title="Text color" value="#1B1B1A">
          <select class="wb-sfmt-size" data-cmd="fontSize" title="Font size">
            ${STICKY_FONT_SIZES.map(([label, val]) => `<option value="${val}" ${val === "3" ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <button data-cmd="insertUnorderedList" title="Bulleted list">• ≡</button>
          <button class="wb-sfmt-more" title="More formatting">⋯</button>
        </div>
        <div class="wb-sfmt-row wb-sfmt-extra">
          <button data-cmd="undo" title="Undo (Ctrl+Z)">↺</button>
          <button data-cmd="redo" title="Redo (Ctrl+Y)">↻</button>
          <button data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <input type="color" class="wb-sfmt-color" data-cmd="hiliteColor" title="Highlight color" value="#FEF08A">
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
  // Sanitizing happens at render time (renderObjects/stickyHtml), not on
  // every keystroke here — this is the user's own browser rendering
  // their own just-typed input, no different in risk from any other
  // text field. The one local vector for genuinely foreign markup is
  // paste, handled separately below.
  const textEl = el.querySelector(".wb-sticky-text");
  textEl.addEventListener("pointerdown", (evt) => evt.stopPropagation()); // typing shouldn't start a drag
  const saveHtml = () => { const o = getObj(); if (o) { o.html = textEl.innerHTML; o.updatedAt = Date.now(); persist(); } };

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
  fmtToolbar.querySelectorAll(".wb-sfmt-color, select[data-cmd]").forEach(ctrl => {
    ctrl.addEventListener("pointerdown", saveRange);
    ctrl.addEventListener(ctrl.tagName === "SELECT" ? "change" : "input", () => {
      restoreRange();
      document.execCommand(ctrl.dataset.cmd, false, ctrl.value);
      saveHtml();
    });
  });
  // Checkbox list — not a native execCommand; inserts a custom block
  // whose checkbox is contenteditable="false" (so clicking it toggles
  // state instead of placing a text cursor inside it) and toggled via
  // the delegated click handler on textEl below.
  fmtToolbar.querySelector(".wb-sfmt-checklist").addEventListener("pointerdown", (evt) => evt.preventDefault());
  fmtToolbar.querySelector(".wb-sfmt-checklist").addEventListener("click", () => {
    document.execCommand("insertHTML", false, '<div class="wb-check-item"><span class="wb-check-box" contenteditable="false" data-checked="false">☐</span>\u00A0</div>');
    saveHtml();
  });
  const insertLink = () => {
    restoreRange();
    const url = prompt("Link URL:", "https://");
    if (!url) return;
    restoreRange();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      document.execCommand("insertHTML", false, `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
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
        a.href = m[0]; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = m[0];
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

  textEl.addEventListener("keydown", (evt) => {
    const mod = evt.ctrlKey || evt.metaKey;
    const k = evt.key.toLowerCase();
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
  textEl.addEventListener("blur", () => { autoLinkOnBlur(); saveHtml(); });

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
      renderConnectors(boardId);
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
      renderConnectors(boardId);
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
    pruneConnectorsForNote(boardId, objId);
    persist();
    el.remove();
    renderConnectors(boardId);
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
