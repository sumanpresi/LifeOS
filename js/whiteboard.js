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
import { state, persist } from './state.js';

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
      <canvas class="whiteboard-canvas" id="wbCanvas${i}-${boardId}" data-page="${i}"></canvas>
    </div>`).join("");
  const s = inst(boardId);
  s.pageEls.length = 0;
  for (let i = 0; i < PAGE_COUNT; i++) {
    const canvas = document.getElementById(`wbCanvas${i}-${boardId}`);
    const entry = { canvas, ctx: null, dpr: 1 };
    s.pageEls.push(entry);
    attachPointerHandlers(boardId, canvas, i);
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
  canvas.addEventListener("pointerup", () => onPointerUp(boardId, pageIndex));
  canvas.addEventListener("pointercancel", () => onPointerUp(boardId, pageIndex));
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
  canvas.setPointerCapture(evt.pointerId);
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
  const prevPoint = s.currentStroke.points[s.currentStroke.points.length - 1];
  const newPoint = pointToNorm(canvas, evt);
  s.currentStroke.points.push(newPoint);
  const entry = s.pageEls[pageIndex];
  if (!entry.ctx) return;
  drawSegment(entry.ctx, prevPoint, newPoint, entry.canvas.width / entry.dpr, s.currentStroke);
}
function onPointerUp(boardId, pageIndex) {
  const s = inst(boardId);
  if (!s.drawing || !s.currentStroke) return;
  s.drawing = false;
  if (s.currentStroke.points.length > 1) {
    pages(boardId)[pageIndex].strokes.push(s.currentStroke);
    persist(); // auto-save on every completed stroke
  }
  s.currentStroke = null;
  s.currentPageIndex = null;
}

export function selectPenTool(boardId) { inst(boardId).activeTool = "pen"; renderToolbarState(boardId); }
export function selectEraserTool(boardId) { inst(boardId).activeTool = "eraser"; renderToolbarState(boardId); }
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
  scope.querySelectorAll(".whiteboard-canvas").forEach(c => {
    c.style.cursor = !s.activeTool ? "not-allowed" : s.activeTool === "eraser" ? "cell" : "crosshair";
  });
}
