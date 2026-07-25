/* Whiteboard — a single persistent freehand canvas on Overview for
   scribbling ideas, built for S Pen / Apple Pencil / finger / mouse via
   Pointer Events (the same unified API already proven for the calendar's
   per-date scribble notes). Unlike the calendar's minimal one-tool
   version, this one carries real tools — color, eraser, thickness, undo —
   since those were explicitly asked for here. Strokes are stored in
   normalized 0–1 coordinates so the drawing rescales correctly if the
   canvas is ever a different size (e.g. after a window resize or on a
   different device), rather than distorting or clipping. */
import { state, persist } from './state.js';

const COLORS = ["#1B1B1A", "#DC2626", "#2563EB", "#16A34A", "#F59E0B", "#7C3AED"];
const WIDTHS = { thin: 2, medium: 4, thick: 8 };

let canvas = null, ctx = null, dpr = 1;
let drawing = false;
let currentStroke = null;
let activeColor = COLORS[0];
let activeWidthKey = "medium";
let eraseMode = false;
let initialized = false;

function board() { return state.whiteboard; }

export function initWhiteboard() {
  canvas = document.getElementById("whiteboardCanvas");
  if (!canvas) return;
  if (!initialized) {
    attachPointerHandlers();
    window.addEventListener("resize", sizeCanvas);
    initialized = true;
  }
  sizeCanvas();
  renderToolbarState();
}

// Called whenever Overview becomes the visible page — sizing a canvas
// while its page is hidden reads a 0×0 box (the same "measured while
// hidden" issue already hit and fixed for GSI/Overview title fields and
// the calendar's month grid), so this needs to re-run on navigation, not
// just once at initial page load.
export function resizeWhiteboardIfVisible() {
  if (canvas && canvas.offsetParent !== null) sizeCanvas();
}

function sizeCanvas() {
  if (!canvas) return;
  const box = canvas.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return; // still hidden — nothing to size yet
  dpr = window.devicePixelRatio || 1;
  canvas.width = box.width * dpr;
  canvas.height = box.height * dpr;
  ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  redraw();
}

function redraw() {
  if (!ctx || !canvas) return;
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  board().strokes.forEach(s => drawStroke(s, w, h));
}

function drawStroke(stroke, w, h) {
  if (stroke.points.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x * w, stroke.points[0].y * h);
  for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
  ctx.stroke();
  ctx.restore();
}

function pointToNorm(evt) {
  const box = canvas.getBoundingClientRect();
  return { x: (evt.clientX - box.left) / box.width, y: (evt.clientY - box.top) / box.height };
}

function onPointerDown(evt) {
  evt.preventDefault();
  drawing = true;
  currentStroke = { points: [pointToNorm(evt)], color: activeColor, width: WIDTHS[activeWidthKey], erase: eraseMode };
  canvas.setPointerCapture(evt.pointerId);
}
function onPointerMove(evt) {
  if (!drawing || !currentStroke) return;
  currentStroke.points.push(pointToNorm(evt));
  const w = canvas.width / dpr, h = canvas.height / dpr;
  drawStroke(currentStroke, w, h); // draw the in-progress stroke live — it isn't committed to state yet
}
function onPointerUp() {
  if (!drawing || !currentStroke) return;
  drawing = false;
  if (currentStroke.points.length > 1) {
    board().strokes.push(currentStroke);
    persist(); // auto-save on every completed stroke
  }
  currentStroke = null;
}
function attachPointerHandlers() {
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
}

export function setWhiteboardColor(c) {
  activeColor = c; eraseMode = false;
  renderToolbarState();
}
export function setWhiteboardWidth(k) {
  activeWidthKey = k;
  renderToolbarState();
}
export function toggleWhiteboardEraser() {
  eraseMode = !eraseMode;
  renderToolbarState();
}
export function undoWhiteboardStroke() {
  if (!board().strokes.length) return;
  board().strokes.pop();
  persist(); redraw();
}
export function clearWhiteboard() {
  if (!board().strokes.length) return;
  if (!confirm("Clear the whole whiteboard? This can't be undone.")) return;
  board().strokes = [];
  persist(); redraw();
}

function renderToolbarState() {
  document.querySelectorAll(".wb-color-swatch").forEach(el => {
    el.classList.toggle("on", el.dataset.color === activeColor && !eraseMode);
  });
  document.querySelectorAll(".wb-width-btn").forEach(el => {
    el.classList.toggle("on", el.dataset.width === activeWidthKey);
  });
  const eraseBtn = document.getElementById("wbEraseBtn");
  if (eraseBtn) eraseBtn.classList.toggle("on", eraseMode);
  if (canvas) canvas.style.cursor = eraseMode ? "cell" : "crosshair";
}
