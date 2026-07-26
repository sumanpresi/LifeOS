/* Whiteboard — 10 independent, vertically-scrollable pages for
   scribbling ideas on Overview, built for S Pen / Apple Pencil / finger /
   mouse via Pointer Events.

   Two things here specifically fix real bugs from the previous version:

   1. The canvas paints its own white background via the 2D context
      instead of relying on CSS `background: #fff`. Samsung Browser's
      "force dark" feature (and similar browser-level dark-mode
      overrides) can invert CSS-rendered colors on a page even when the
      site itself has no dark theme — but it can't touch pixels a canvas
      draws itself, so an explicit fillRect is genuinely immune to it
      where a CSS background color isn't.

   2. Stroke points are normalized against a single reference dimension
      (width) for both X and Y, not width-for-X/height-for-Y separately.
      The canvas is CSS width:100% with a fixed height, so its aspect
      ratio changes across screen sizes — normalizing each axis against
      its own dimension meant redrawing on a differently-shaped canvas
      stretched or squeezed the drawing. Scaling both axes by the same
      factor preserves the original proportions instead. */
import { state, persist } from './state.js';

const PAGE_COUNT = 10;
const COLORS = ["#1B1B1A", "#DC2626", "#2563EB", "#16A34A", "#F59E0B", "#7C3AED"];
const WIDTHS = { thin: 2, medium: 4, thick: 8 };
const ERASER_SIZES = { small: 16, large: 40 }; // deliberately much bigger than pen widths — erasing needs to cover ground fast

let activeTool = null; // null | "pen" | "eraser" — nothing selected by default, so drawing is gated until a tool is explicitly chosen
let activeColor = COLORS[0];
let activeWidthKey = "medium";
let activeEraserKey = "small";

const pageEls = []; // [{canvas, ctx, dpr}] per page, index-aligned with state.whiteboard.pages
let initialized = false;
let drawing = false;
let currentStroke = null;
let currentPageIndex = null;

function pages() { return state.whiteboard.pages; }

export function initWhiteboard() {
  const container = document.getElementById("whiteboardPages");
  if (!container) return;
  if (!initialized) {
    buildPages(container);
    window.addEventListener("resize", sizeAllCanvases);
    initialized = true;
  }
  sizeAllCanvases();
}

function buildPages(container) {
  container.innerHTML = pages().map((p, i) => `
    <div class="wb-page">
      <div class="wb-page-label">Page ${i + 1} of ${PAGE_COUNT}</div>
      <canvas class="whiteboard-canvas" id="wbCanvas${i}" data-page="${i}"></canvas>
    </div>`).join("");
  pageEls.length = 0;
  for (let i = 0; i < PAGE_COUNT; i++) {
    const canvas = document.getElementById("wbCanvas" + i);
    const entry = { canvas, ctx: null, dpr: 1 };
    pageEls.push(entry);
    attachPointerHandlers(canvas, i);
  }
}

// Same "measured while hidden" concern as everywhere else a canvas or
// textarea gets sized in this app — call this again once Overview is
// actually visible, not just once at initial construction.
export function resizeWhiteboardIfVisible() {
  const container = document.getElementById("whiteboardPages");
  if (container && container.offsetParent !== null) sizeAllCanvases();
}

function sizeAllCanvases() {
  pageEls.forEach((entry, i) => sizeCanvas(entry, i));
}
function sizeCanvas(entry, i) {
  const box = entry.canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return; // still hidden — nothing to size yet
  entry.dpr = window.devicePixelRatio || 1;
  entry.canvas.width = box.width * entry.dpr;
  entry.canvas.height = box.height * entry.dpr;
  entry.ctx = entry.canvas.getContext("2d");
  entry.ctx.scale(entry.dpr, entry.dpr);
  redrawPage(i);
}

function redrawPage(i) {
  const entry = pageEls[i];
  if (!entry.ctx) return;
  const w = entry.canvas.width / entry.dpr, h = entry.canvas.height / entry.dpr;
  // Explicit fill, not CSS background — see the file header for why.
  entry.ctx.fillStyle = "#ffffff";
  entry.ctx.fillRect(0, 0, w, h);
  entry.ctx.lineCap = "round"; entry.ctx.lineJoin = "round";
  pages()[i].strokes.forEach(s => drawStroke(entry.ctx, s, w));
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

function pointToNorm(canvas, evt) {
  const box = canvas.getBoundingClientRect();
  // Both axes divided by width (not height) — matches how drawStroke
  // scales back out, so a point recorded at x=200,y=100 on a 400-wide
  // canvas is 0.5, 0.25, and replaying it against any canvas width
  // reconstructs the same proportions rather than the same fraction of
  // whatever that canvas's (possibly different-ratio) height happens to be.
  return { x: (evt.clientX - box.left) / box.width, y: (evt.clientY - box.top) / box.width };
}

function attachPointerHandlers(canvas, pageIndex) {
  canvas.addEventListener("pointerdown", (evt) => onPointerDown(evt, canvas, pageIndex));
  canvas.addEventListener("pointermove", (evt) => onPointerMove(evt, canvas, pageIndex));
  canvas.addEventListener("pointerup", () => onPointerUp(pageIndex));
  canvas.addEventListener("pointercancel", () => onPointerUp(pageIndex));
}

function onPointerDown(evt, canvas, pageIndex) {
  if (!activeTool) return; // nothing selected — drawing is gated until a tool is explicitly chosen
  evt.preventDefault();
  drawing = true;
  currentPageIndex = pageIndex;
  currentStroke = activeTool === "eraser"
    ? { points: [pointToNorm(canvas, evt)], color: "#000000", width: ERASER_SIZES[activeEraserKey], erase: true }
    : { points: [pointToNorm(canvas, evt)], color: activeColor, width: WIDTHS[activeWidthKey], erase: false };
  canvas.setPointerCapture(evt.pointerId);
}
function onPointerMove(evt, canvas, pageIndex) {
  if (!drawing || !currentStroke || pageIndex !== currentPageIndex) return;
  currentStroke.points.push(pointToNorm(canvas, evt));
  const entry = pageEls[pageIndex];
  if (!entry.ctx) return;
  // Redraw the whole page each move rather than just stroking the new
  // segment — simplest way to keep an in-progress eraser stroke showing
  // correctly against everything already on the page beneath it.
  redrawPage(pageIndex);
  drawStroke(entry.ctx, currentStroke, entry.canvas.width / entry.dpr);
}
function onPointerUp(pageIndex) {
  if (!drawing || !currentStroke) return;
  drawing = false;
  if (currentStroke.points.length > 1) {
    pages()[pageIndex].strokes.push(currentStroke);
    persist(); // auto-save on every completed stroke
  }
  currentStroke = null;
  currentPageIndex = null;
}

export function selectPenTool() {
  activeTool = "pen";
  renderToolbarState();
}
export function selectEraserTool() {
  activeTool = "eraser";
  renderToolbarState();
}
export function setWhiteboardColor(c) {
  activeColor = c;
  activeTool = "pen"; // choosing a color is a reasonable way to pick up the pen too, not just the dedicated Pen button
  renderToolbarState();
}
export function setWhiteboardWidth(k) {
  activeWidthKey = k;
  renderToolbarState();
}
export function setEraserSize(k) {
  activeEraserKey = k;
  renderToolbarState();
}
export function undoWhiteboardStroke() {
  // Undo applies to whichever page you're currently looking at — the one
  // most centered in the scrollable container — since there's no single
  // "active" page the way tabs would give you.
  const container = document.getElementById("whiteboardPages");
  if (!container) return;
  const i = mostVisiblePageIndex(container);
  if (!pages()[i].strokes.length) return;
  pages()[i].strokes.pop();
  persist(); redrawPage(i);
}
export function clearWhiteboardPage() {
  const container = document.getElementById("whiteboardPages");
  if (!container) return;
  const i = mostVisiblePageIndex(container);
  if (!pages()[i].strokes.length) return;
  if (!confirm(`Clear page ${i + 1}? This can't be undone.`)) return;
  pages()[i].strokes = [];
  persist(); redrawPage(i);
}
function mostVisiblePageIndex(container) {
  const mid = container.scrollTop + container.clientHeight / 2;
  let best = 0, bestDist = Infinity;
  pageEls.forEach((entry, i) => {
    const dist = Math.abs(entry.canvas.offsetTop - mid);
    if (dist < bestDist) { bestDist = dist; best = i; }
  });
  return best;
}

function renderToolbarState() {
  document.querySelectorAll(".wb-color-swatch").forEach(el => {
    el.classList.toggle("on", el.dataset.color === activeColor && activeTool === "pen");
  });
  document.querySelectorAll(".wb-width-btn").forEach(el => {
    el.classList.toggle("on", el.dataset.width === activeWidthKey);
  });
  document.querySelectorAll(".wb-eraser-size-btn").forEach(el => {
    el.classList.toggle("on", el.dataset.size === activeEraserKey);
  });
  const penBtn = document.getElementById("wbPenBtn");
  if (penBtn) penBtn.classList.toggle("on", activeTool === "pen");
  const eraseBtn = document.getElementById("wbEraseBtn");
  if (eraseBtn) eraseBtn.classList.toggle("on", activeTool === "eraser");
  const eraserSizeBox = document.getElementById("wbEraserSizes");
  if (eraserSizeBox) eraserSizeBox.style.display = activeTool === "eraser" ? "flex" : "none";
  document.querySelectorAll(".whiteboard-canvas").forEach(c => {
    c.style.cursor = !activeTool ? "not-allowed" : activeTool === "eraser" ? "cell" : "crosshair";
  });
}
