/* Whiteboard — supports multiple independent instances (Overview's
   general scribble board, GSI Workspace's brainstorming board, and any
   future ones), each with its own 10 vertically-scrollable pages, its
   own tool state, and its own data under state.whiteboards[boardId].
   Built for S Pen / Apple Pencil / finger / mouse via Pointer Events.

   Every exported function takes a boardId as its first argument so the
   same module and the same fixes apply to every board rather than
   duplicating this logic per instance — the DOM ids and toolbar
   elements are all suffixed with -${boardId} to keep instances from
   colliding with each other on the same page.

   Three things here specifically fix real bugs from earlier versions:

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
      entire page re-filled and re-stroked from scratch. A stylus fires
      move events at a much higher rate than a mouse; redrawing
      everything on every one of those, and getting more expensive as a
      page accumulates strokes, was the likely cause of both rendering
      lag and the eraser visually misbehaving on high-frequency,
      high-resolution mobile input. */
import { state, persist, uid, esc } from './state.js';

const PAGE_COUNT = 10;
const COLORS = ["#1B1B1A", "#DC2626", "#2563EB", "#16A34A", "#F59E0B", "#7C3AED"];
const WIDTHS = { thin: 2, medium: 4, thick: 8 };
const ERASER_SIZES = { small: 16, large: 40 }; // deliberately much bigger than pen widths — erasing needs to cover ground fast

const instances = {}; // { [boardId]: { pageEls, initialized, drawing, currentStroke, currentPageIndex, activeTool, activeColor, activeWidthKey, activeEraserKey, zoomPct } }
function inst(boardId) {
  if (!instances[boardId]) {
    instances[boardId] = {
      pageEls: [], initialized: false, drawing: false, currentStroke: null, currentPageIndex: null,
      activeTool: null, activeColor: COLORS[0], activeWidthKey: "medium", activeEraserKey: "small", zoomPct: 100
    };
  }
  return instances[boardId];
}
function pages(boardId) {
  state.whiteboards[boardId] = state.whiteboards[boardId] || { pages: Array.from({ length: PAGE_COUNT }, () => ({ strokes: [] })) };
  return state.whiteboards[boardId].pages;
}
function objects(boardId, pageIndex) {
  const p = pages(boardId)[pageIndex];
  p.objects = p.objects || []; // additive field — older saved pages predate sticky notes
  return p.objects;
}
const id = (boardId, base) => base + "-" + boardId;

export function initWhiteboard(boardId) {
  const container = document.getElementById(id(boardId, "whiteboardPages"));
  if (!container) return;
  const s = inst(boardId);
  if (!s.initialized) {
    buildPages(boardId, container);
    window.addEventListener("resize", () => sizeAllCanvases(boardId));
    s.initialized = true;
  }
  sizeAllCanvases(boardId);
}

function buildPages(boardId, container) {
  container.innerHTML = pages(boardId).map((p, i) => `
    <div class="wb-page">
      <div class="wb-page-label">Page ${i + 1} of ${PAGE_COUNT}</div>
      <div class="wb-page-stack">
        <canvas class="whiteboard-canvas" id="wbCanvas${i}-${boardId}" data-page="${i}"></canvas>
        <div class="wb-object-layer" id="wbObjLayer${i}-${boardId}" data-page="${i}"></div>
      </div>
    </div>`).join("");
  const s = inst(boardId);
  s.pageEls.length = 0;
  for (let i = 0; i < PAGE_COUNT; i++) {
    const canvas = document.getElementById(`wbCanvas${i}-${boardId}`);
    const layer = document.getElementById(`wbObjLayer${i}-${boardId}`);
    const entry = { canvas, layer, ctx: null, dpr: 1 };
    s.pageEls.push(entry);
    attachPointerHandlers(boardId, canvas, i);
    attachLayerHandlers(boardId, layer, i);
  }
}

// Same "measured while hidden" concern as everywhere else a canvas or
// textarea gets sized in this app — call this again once the board's
// page is actually visible, not just once at initial construction.
export function resizeWhiteboardIfVisible(boardId) {
  const container = document.getElementById(id(boardId, "whiteboardPages"));
  if (container && container.offsetParent !== null) sizeAllCanvases(boardId);
}

function sizeAllCanvases(boardId) {
  inst(boardId).pageEls.forEach((entry, i) => sizeCanvas(boardId, entry, i));
}
function sizeCanvas(boardId, entry, i) {
  const box = entry.canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return; // still hidden — nothing to size yet
  // Capped rather than using the raw value — very high-resolution phones
  // can report devicePixelRatio well above 2, which multiplies the
  // canvas buffer size and the cost of every redraw for no visible
  // sharpness benefit past that point.
  entry.dpr = Math.min(window.devicePixelRatio || 1, 2);
  entry.canvas.width = box.width * entry.dpr;
  entry.canvas.height = box.height * entry.dpr;
  entry.ctx = entry.canvas.getContext("2d");
  entry.ctx.scale(entry.dpr, entry.dpr);
  redrawPage(boardId, i);
  renderObjectsForPage(boardId, i);
}

function redrawPage(boardId, i) {
  const entry = inst(boardId).pageEls[i];
  if (!entry || !entry.ctx) return;
  const w = entry.canvas.width / entry.dpr, h = entry.canvas.height / entry.dpr;
  entry.ctx.fillStyle = "#ffffff";
  entry.ctx.fillRect(0, 0, w, h);
  entry.ctx.lineCap = "round"; entry.ctx.lineJoin = "round";
  pages(boardId)[i].strokes.forEach(st => drawStroke(entry.ctx, st, w));
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
// costs one short line instead of a full-page redraw. See file header.
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

function attachPointerHandlers(boardId, canvas, pageIndex) {
  canvas.addEventListener("pointerdown", (evt) => onPointerDown(boardId, evt, canvas, pageIndex));
  canvas.addEventListener("pointermove", (evt) => onPointerMove(boardId, evt, canvas, pageIndex));
  canvas.addEventListener("pointerup", (evt) => onPointerUp(boardId, evt, canvas, pageIndex));
  canvas.addEventListener("pointercancel", (evt) => onPointerUp(boardId, evt, canvas, pageIndex));
}

function onPointerDown(boardId, evt, canvas, pageIndex) {
  const s = inst(boardId);
  if (!s.activeTool) return; // nothing selected — drawing is gated until a tool is explicitly chosen
  if (evt.pointerType === "touch") {
    // Finger and palm both report as "touch" in the Pointer Events spec —
    // excluding touch excludes both in one rule. Let it fall through as
    // a native gesture (scrolling) instead of preventDefault-ing it away.
    showTouchRejectedHint(boardId);
    return;
  }
  evt.preventDefault();
  s.drawing = true;
  s.currentPageIndex = pageIndex;
  s.currentStroke = s.activeTool === "eraser"
    ? { points: [pointToNorm(canvas, evt)], color: "#000000", width: ERASER_SIZES[s.activeEraserKey], erase: true }
    : { points: [pointToNorm(canvas, evt)], color: s.activeColor, width: WIDTHS[s.activeWidthKey], erase: false };
  try { canvas.setPointerCapture(evt.pointerId); } catch (e) { /* pointer already invalidated — rare, harmless to skip */ }
  // touch-action:pan-y (set in CSS so a finger can still scroll pages
  // now that it can't draw) lets the browser recognize native vertical
  // scroll gestures on this element based on movement direction, not
  // pointerType — a horizontal stroke has no vertical component and
  // never triggers it, but a diagonal one does, which is exactly why
  // horizontal strokes were fine and inclined ones weren't. Suppressing
  // it only while a stroke is actually in progress keeps finger-scroll
  // working normally between strokes.
  canvas.style.touchAction = "none";
  // Belt-and-suspenders: also lock the actual scrollable ancestor
  // directly. touch-action + preventDefault stop the gesture at the
  // canvas itself, but some mobile browsers can still hand a stray
  // scroll to a genuinely overflow:auto parent — locking it outright
  // for the duration of the stroke removes that path entirely.
  const scrollParent = document.getElementById(id(boardId, "wbPagesScroll"));
  if (scrollParent) scrollParent.style.overflow = "hidden";
  // A third, independent line of defense: rather than only trying to
  // prevent every possible way the page could still move, also detect
  // if it does anyway and respond correctly instead of drawing garbage.
  // Every point in a stroke is computed from the canvas's on-screen
  // position at that instant (getBoundingClientRect) — if ANYTHING
  // scrolls mid-stroke, that position is now stale, and every
  // subsequent point maps to the wrong place relative to where the pen
  // physically is. That's what "lines appearing on their own" actually
  // is: not a separate bug, but this coordinate math silently breaking
  // the moment a scroll slips through despite the locks above.
  s.strokeStartScroll = { top: scrollParent ? scrollParent.scrollTop : 0, winY: window.scrollY, winX: window.scrollX };
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
function onPointerMove(boardId, evt, canvas, pageIndex) {
  const s = inst(boardId);
  if (!s.drawing || !s.currentStroke || pageIndex !== s.currentPageIndex) return;
  evt.preventDefault(); // the missing half of the fix — pointerdown alone isn't enough to suppress a gesture recognized from the move events that follow it
  // If the canvas's position on screen has shifted since the stroke
  // started, every point from here on would map to the wrong place
  // relative to the pen — better to cleanly abandon this stroke than
  // let it draw somewhere it shouldn't.
  const scrollParent = document.getElementById(id(boardId, "wbPagesScroll"));
  const scrollMoved = s.strokeStartScroll && (
    (scrollParent && scrollParent.scrollTop !== s.strokeStartScroll.top) ||
    window.scrollY !== s.strokeStartScroll.winY || window.scrollX !== s.strokeStartScroll.winX
  );
  if (scrollMoved) { abortStroke(boardId, pageIndex); return; }
  const prevPoint = s.currentStroke.points[s.currentStroke.points.length - 1];
  const newPoint = pointToNorm(canvas, evt);
  const entry = s.pageEls[pageIndex];
  if (!entry.ctx) return;
  // Live segment always draws at full smoothness, regardless of what
  // gets stored — this only affects what's kept for saving/syncing.
  drawSegment(entry.ctx, prevPoint, newPoint, entry.canvas.width / entry.dpr, s.currentStroke);
  // A stylus can fire pointermove far more often than a mouse, and
  // storing every single one (with no minimum spacing) makes a long
  // stroke accumulate hundreds of nearly-identical points — larger
  // payload to sync for no visible difference in the stroke's shape.
  // Only keep a point once it's moved a small minimum distance from the
  // last stored one.
  const dx = newPoint.x - prevPoint.x, dy = newPoint.y - prevPoint.y;
  if (Math.sqrt(dx * dx + dy * dy) > 0.003) s.currentStroke.points.push(newPoint);
}
function abortStroke(boardId, pageIndex) {
  const s = inst(boardId);
  s.drawing = false;
  s.currentStroke = null;
  s.currentPageIndex = null;
  redrawPage(boardId, pageIndex); // wipe whatever partial/corrupted line was drawn live, back to the last saved state
  const toast = document.getElementById("toast");
  if (toast) {
    toast.textContent = "Stroke cancelled — the page moved while drawing";
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2200);
  }
}
function onPointerUp(boardId, evt, canvas, pageIndex) {
  const s = inst(boardId);
  canvas.style.touchAction = "pan-y"; // restore finger-scroll now that the stroke is done
  const scrollParent = document.getElementById(id(boardId, "wbPagesScroll"));
  if (scrollParent) scrollParent.style.overflow = "auto";
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
    pages(boardId)[pageIndex].strokes.push(s.currentStroke);
    persist(); // auto-save on every completed stroke
  }
  s.currentStroke = null;
  s.currentPageIndex = null;
}

export function selectPenTool(boardId) {
  const s = inst(boardId);
  s.activeTool = s.activeTool === "pen" ? null : "pen";
  renderToolbarState(boardId);
}
export function selectEraserTool(boardId) {
  const s = inst(boardId);
  s.activeTool = s.activeTool === "eraser" ? null : "eraser";
  renderToolbarState(boardId);
}
export function setWhiteboardColor(boardId, c) {
  const s = inst(boardId);
  s.activeColor = c;
  s.activeTool = "pen"; // choosing a color is a reasonable way to pick up the pen too, not just the dedicated Pen button
  renderToolbarState(boardId);
}
export function setWhiteboardWidth(boardId, k) { inst(boardId).activeWidthKey = k; renderToolbarState(boardId); }
export function setEraserSize(boardId, k) { inst(boardId).activeEraserKey = k; renderToolbarState(boardId); }

export function undoWhiteboardStroke(boardId) {
  // Undo applies to whichever page you're currently looking at — the one
  // most centered in the scrollable container — since there's no single
  // "active" page the way tabs would give you.
  const container = document.getElementById(id(boardId, "wbPagesScroll"));
  if (!container) return;
  const i = mostVisiblePageIndex(boardId, container);
  if (!pages(boardId)[i].strokes.length) return;
  pages(boardId)[i].strokes.pop();
  persist(); redrawPage(boardId, i);
}
export function clearWhiteboardPage(boardId) {
  const container = document.getElementById(id(boardId, "wbPagesScroll"));
  if (!container) return;
  const i = mostVisiblePageIndex(boardId, container);
  if (!pages(boardId)[i].strokes.length) return;
  if (!confirm(`Clear page ${i + 1}? This can't be undone.`)) return;
  pages(boardId)[i].strokes = [];
  persist(); redrawPage(boardId, i);
}
function mostVisiblePageIndex(boardId, container) {
  const mid = container.scrollTop + container.clientHeight / 2;
  let best = 0, bestDist = Infinity;
  inst(boardId).pageEls.forEach((entry, i) => {
    const dist = Math.abs(entry.canvas.offsetTop - mid);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}

export function zoomWhiteboardIn(boardId) { setZoom(boardId, Math.min(200, inst(boardId).zoomPct + 25)); }
export function zoomWhiteboardOut(boardId) { setZoom(boardId, Math.max(50, inst(boardId).zoomPct - 25)); }
export function resetWhiteboardZoom(boardId) { setZoom(boardId, 100); }
function setZoom(boardId, pct) {
  inst(boardId).zoomPct = pct;
  const inner = document.getElementById(id(boardId, "whiteboardPages"));
  if (inner) inner.style.width = pct + "%";
  const label = document.getElementById(id(boardId, "wbZoomLevel"));
  if (label) label.textContent = pct + "%";
  // A real width change, not a CSS transform — canvases genuinely
  // resize, so they need re-sizing and re-drawing at their new actual
  // pixel dimensions, the same pipeline already used for window resize.
  sizeAllCanvases(boardId);
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
  setTimeout(() => sizeAllCanvases(boardId), 60); // let the browser finish resizing first
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
  if (penFlyout) penFlyout.classList.toggle("open", s.activeTool === "pen");
  const eraseBtn = document.getElementById(id(boardId, "wbEraseBtn"));
  if (eraseBtn) eraseBtn.classList.toggle("on", s.activeTool === "eraser");
  const eraserSizeBox = document.getElementById(id(boardId, "wbEraserSizes"));
  if (eraserSizeBox) eraserSizeBox.classList.toggle("open", s.activeTool === "eraser");
  const stickyBtn = document.getElementById(id(boardId, "wbStickyBtn"));
  if (stickyBtn) stickyBtn.classList.toggle("on", s.activeTool === "sticky");
  scope.querySelectorAll(".whiteboard-canvas").forEach(c => {
    c.style.cursor = !s.activeTool ? "not-allowed" : s.activeTool === "eraser" ? "cell" : "crosshair";
  });
  scope.querySelectorAll(".wb-object-layer").forEach(l => {
    l.classList.toggle("creating", s.activeTool === "sticky");
  });
}

/* ================================================================
   STICKY NOTES — the first object type on the shared object layer.
   Unlike pen/eraser strokes, notes are real DOM elements: individually
   selectable, draggable, resizable, and editable after the fact, which
   canvas pixels can never be. Positions/sizes are normalized against
   canvas width, the same scheme strokes use, so notes stay correctly
   placed and correctly proportioned across zoom levels and screen sizes.
   ================================================================ */
const STICKY_COLORS = ["#FEF08A", "#FCA5A5", "#93C5FD", "#86EFAC", "#D8B4FE"];
const STICKY_DEFAULT_W = 0.15, STICKY_DEFAULT_H = 0.15;
const STICKY_MIN = 0.06;
let selectedStickyId = null;

export function selectStickyTool(boardId) {
  const s = inst(boardId);
  s.activeTool = s.activeTool === "sticky" ? null : "sticky";
  renderToolbarState(boardId);
}

function attachLayerHandlers(boardId, layer, pageIndex) {
  layer.addEventListener("pointerdown", (evt) => {
    const s = inst(boardId);
    if (s.activeTool !== "sticky") return;
    if (evt.target !== layer) return; // clicked an existing note, not empty space — let the note handle it instead
    evt.stopPropagation(); // otherwise this same event also reaches the document-level "click elsewhere deselects" listener below, undoing the selection this creates
    const box = layer.getBoundingClientRect();
    const normX = (evt.clientX - box.left) / box.width;
    const normY = (evt.clientY - box.top) / box.width;
    createSticky(boardId, pageIndex, Math.max(0, normX - STICKY_DEFAULT_W / 2), Math.max(0, normY - STICKY_DEFAULT_H / 2));
  });
}

function createSticky(boardId, pageIndex, normX, normY) {
  const obj = { id: uid(), x: normX, y: normY, w: STICKY_DEFAULT_W, h: STICKY_DEFAULT_H, text: "", color: STICKY_COLORS[0] };
  objects(boardId, pageIndex).push(obj);
  selectedStickyId = obj.id;
  persist();
  renderObjectsForPage(boardId, pageIndex);
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-obj-id="${obj.id}"] .wb-sticky-text`);
    if (el) el.focus();
  });
}

function renderObjectsForPage(boardId, pageIndex) {
  const entry = inst(boardId).pageEls[pageIndex];
  if (!entry || !entry.layer) return;
  const w = entry.canvas.width / entry.dpr; // same basis as strokes
  const objs = objects(boardId, pageIndex);
  entry.layer.innerHTML = objs.map(o => stickyHtml(o, w)).join("");
  objs.forEach(o => attachStickyHandlers(boardId, pageIndex, o.id, w));
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

function attachStickyHandlers(boardId, pageIndex, objId, canvasWidth) {
  const el = document.querySelector(`#wbObjLayer${pageIndex}-${boardId} [data-obj-id="${objId}"]`);
  if (!el) return;
  const getObj = () => objects(boardId, pageIndex).find(o => o.id === objId);

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
  const saveText = () => { const o = getObj(); if (o) { o.text = textEl.textContent; persist(); } };
  textEl.addEventListener("input", saveText);
  textEl.addEventListener("blur", saveText);

  // Drag — only from the dedicated handle, kept separate from the text
  // area so dragging and editing can never be ambiguous with each other.
  const dragHandle = el.querySelector(".wb-sticky-drag-handle");
  dragHandle.addEventListener("pointerdown", (evt) => {
    evt.preventDefault(); evt.stopPropagation();
    selectedStickyId = objId; el.classList.add("selected");
    const startX = evt.clientX, startY = evt.clientY;
    const o = getObj(); const startLeft = o.x * canvasWidth, startTop = o.y * canvasWidth;
    const onMove = (mv) => {
      const nx = (startLeft + (mv.clientX - startX)) / canvasWidth;
      const ny = (startTop + (mv.clientY - startY)) / canvasWidth;
      el.style.left = (nx * canvasWidth) + "px";
      el.style.top = (ny * canvasWidth) + "px";
      o.x = Math.max(0, nx); o.y = Math.max(0, ny);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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
    const startX = evt.clientX, startY = evt.clientY;
    const o = getObj(); const startW = o.w * canvasWidth, startH = o.h * canvasWidth;
    const onMove = (mv) => {
      const nw = Math.max(STICKY_MIN * canvasWidth, startW + (mv.clientX - startX));
      const nh = Math.max(STICKY_MIN * canvasWidth, startH + (mv.clientY - startY));
      el.style.width = nw + "px"; el.style.height = nh + "px";
      o.w = nw / canvasWidth; o.h = nh / canvasWidth;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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
      el.style.background = o.color;
      el.querySelectorAll(".wb-sticky-color").forEach(b => b.classList.toggle("on", b === btn));
      persist();
    });
  });

  // Delete
  el.querySelector(".wb-sticky-delete").addEventListener("pointerdown", (evt) => evt.stopPropagation());
  el.querySelector(".wb-sticky-delete").addEventListener("click", () => {
    const arr = objects(boardId, pageIndex);
    const idx = arr.findIndex(o => o.id === objId);
    if (idx !== -1) arr.splice(idx, 1);
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
