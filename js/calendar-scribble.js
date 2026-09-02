/* Calendar scribble — a freehand note per calendar date, drawn with
   mouse, finger, or stylus (unified via Pointer Events, the same API
   already proven for the map's long-press coordinate popup). Strokes
   are stored in normalized 0–1 coordinates so a note drawn on one
   screen size still looks right when reopened on another. */
import { state, persist, rerender } from './state.js?v=202609040200';

let activeDateKey = null;
let canvas = null, ctx = null;
let drawing = false;
let currentStroke = null;
let dpr = 1;

function getScribble(k) {
  state.calendarScribbles[k] = state.calendarScribbles[k] || { strokes: [] };
  return state.calendarScribbles[k];
}

export function openScribbleFor(dateKey) {
  activeDateKey = dateKey;
  const modal = document.getElementById("scribbleModalBg");
  const title = document.getElementById("scribbleModalTitle");
  canvas = document.getElementById("scribbleCanvas");
  if (!modal || !canvas) return;
  const fmt = new Date(dateKey + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });
  if (title) title.textContent = "Note — " + fmt;
  modal.classList.add("open");

  // Size the canvas to its actual on-screen box, accounting for device
  // pixel ratio so strokes stay crisp on high-DPI phone screens instead
  // of rendering blurry at 1x while CSS displays it larger.
  requestAnimationFrame(() => {
    const box = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    canvas.width = box.width * dpr;
    canvas.height = box.height * dpr;
    ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    redraw();
    attachPointerHandlers();
  });
}

export function closeScribbleModal() {
  const modal = document.getElementById("scribbleModalBg");
  if (modal) modal.classList.remove("open");
  detachPointerHandlers();
  activeDateKey = null;
  rerender(); // the grid behind the modal was rendered before this note existed — refresh its dot indicator
}

function redraw() {
  if (!ctx || !canvas) return;
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = "#1B1B1A"; ctx.lineWidth = 2.5;
  const s = getScribble(activeDateKey);
  s.strokes.forEach(stroke => {
    if (stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x * w, stroke.points[0].y * h);
    for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
    ctx.stroke();
  });
}

function pointToNorm(evt) {
  const box = canvas.getBoundingClientRect();
  return { x: (evt.clientX - box.left) / box.width, y: (evt.clientY - box.top) / box.height };
}

function onPointerDown(evt) {
  evt.preventDefault();
  drawing = true;
  currentStroke = { points: [pointToNorm(evt)] };
  canvas.setPointerCapture(evt.pointerId);
}
function onPointerMove(evt) {
  if (!drawing || !currentStroke) return;
  currentStroke.points.push(pointToNorm(evt));
  redraw();
  // Draw the in-progress stroke live, since it isn't committed to state yet
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.beginPath();
  ctx.moveTo(currentStroke.points[0].x * w, currentStroke.points[0].y * h);
  for (let i = 1; i < currentStroke.points.length; i++) ctx.lineTo(currentStroke.points[i].x * w, currentStroke.points[i].y * h);
  ctx.stroke();
}
function onPointerUp() {
  if (!drawing || !currentStroke) return;
  drawing = false;
  if (currentStroke.points.length > 1) {
    getScribble(activeDateKey).strokes.push(currentStroke);
    persist(); // auto-save on every completed stroke, no explicit save step
  }
  currentStroke = null;
  redraw();
}

function attachPointerHandlers() {
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
}
function detachPointerHandlers() {
  if (!canvas) return;
  canvas.removeEventListener("pointerdown", onPointerDown);
  canvas.removeEventListener("pointermove", onPointerMove);
  canvas.removeEventListener("pointerup", onPointerUp);
  canvas.removeEventListener("pointercancel", onPointerUp);
}

export function clearScribble() {
  if (!activeDateKey) return;
  if (!getScribble(activeDateKey).strokes.length) return;
  if (!confirm("Clear this note? This can't be undone.")) return;
  state.calendarScribbles[activeDateKey].strokes = [];
  persist();
  redraw();
}
