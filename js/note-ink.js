/* ============================================================
   Freehand ink over a note — the OneNote behaviour
   ============================================================
   Ink is a separate layer floating over the text, not something living
   inside the text. You circle a word, underline a phrase, draw an arrow
   in the margin, and the marks stay exactly where you put them.

   THE COORDINATE PROBLEM, and the deal this makes with it.

   Ink is absolute; text is relative. Marks are stored at fixed positions
   in the note's own page space, but the words underneath move whenever
   the text rewraps — and text rewraps whenever the column width changes.
   The same note is 794px in a card and 1100px in full screen, so a circle
   drawn around "Marcus Aurelius" on the desktop would land around a
   different phrase on the phone, or nothing at all.

   No amount of cleverness fixes that: an arrow pointing at the gap
   between two words has no anchor in the text to attach to. So the deal
   is the one OneNote itself makes — THE PAGE HAS A FIXED WIDTH. Once a
   note contains ink its column locks to PAGE_W and stops reflowing, on
   every device and in full screen too. The text wraps identically
   everywhere, so the ink keeps meaning what it meant. A screen narrower
   than the page scrolls sideways rather than rewrapping.

   The consequence to be honest about: editing text ABOVE existing ink
   pushes the words down and leaves the marks behind. OneNote behaves the
   same way for the same reason. Ink annotates a page as it was.

   WHERE THE STROKES LIVE
   In the note itself (`note.ink`), never in its HTML. The sanitizer's
   allowlist has no SVG or canvas — deliberately, see the <svg><script>
   note in sanitize.js — and this needs no exception to it: strokes are
   plain numbers in state, rendered to a canvas at runtime.

   The stroke shape deliberately matches whiteboard.js so the two can
   share a mental model (and, if it ever matters, code).
   ============================================================ */
import { state, uid, persist } from './state.js';
import { toast } from './ui.js';

/* The locked column width, and the reference the stored coordinates mean.
   794px is A4 at 96dpi, which is what the non-ink note already used. */
export const PAGE_W = 794;

const PEN_COLORS = ["#2b2a24", "#c0392b", "#1f6feb", "#1d8348", "#b7791f"];
/* A highlighter multiplies with what is under it, so its colour has to be
   pale enough to leave the text readable through it. The pen palette is
   the opposite — dark, saturated — and reusing it turned a highlight into
   a black bar over the words. */
const HL_COLORS = ["#ffe066", "#a7f3d0", "#bfdbfe", "#fbcfe8", "#fed7aa"];
const PEN_W = 2.5;
const HL_W = 16;
const ERASER_R = 14;

/* One live layer per mounted editor, keyed by the editor's element id.
   Rebuilt whenever renderSectionNotes rebuilds the note. */
const layers = new Map();

function inkOf(note) {
  if (!note.ink || typeof note.ink !== "object") note.ink = { strokes: [], removed: [] };
  if (!Array.isArray(note.ink.strokes)) note.ink.strokes = [];
  if (!Array.isArray(note.ink.removed)) note.ink.removed = [];
  return note.ink;
}
export function noteHasInk(note) {
  return !!(note && note.ink && Array.isArray(note.ink.strokes) && note.ink.strokes.length);
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

function drawStroke(ctx, s, scrollTop) {
  const pts = s.pts;
  if (!pts || pts.length < 2) return;
  ctx.save();
  ctx.lineCap = s.mode === "hl" ? "butt" : "round"; // a real highlighter has a flat chisel end
  ctx.lineJoin = "round";
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.w;
  strokePath(ctx, pts, scrollTop);
  ctx.stroke();
  ctx.restore();
}

function sizeCanvas(canvas, w, h, dpr) {
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
  const dpr = window.devicePixelRatio || 1;
  const w = editor.clientWidth, h = editor.clientHeight;
  const hlCtx = sizeCanvas(hlCanvas, w, h, dpr);
  const penCtx = sizeCanvas(penCanvas, w, h, dpr);

  const top = editor.scrollTop;
  const strokes = layer.strokes();
  strokes.forEach(s => drawStroke(s.mode === "hl" ? hlCtx : penCtx, s, top));
  if (layer.live) drawStroke(layer.live.mode === "hl" ? hlCtx : penCtx, layer.live, top);
}

/* ---------- erasing ---------- */

function strokeNear(s, x, y, r) {
  const pts = s.pts;
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

  const hlCanvas = document.createElement("canvas");
  hlCanvas.className = "note-ink-canvas note-ink-hl";
  const penCanvas = document.createElement("canvas");
  penCanvas.className = "note-ink-canvas note-ink-pen";
  editorWrap.appendChild(hlCanvas);
  editorWrap.appendChild(penCanvas); // pen above highlighter
  // Only the top canvas takes the pointer; the highlighter layer stays
  // inert so a stroke isn't captured twice.
  const canvas = penCanvas;

  const layer = {
    noteEl, editor, canvas, hlCanvas, penCanvas,
    mode: "text",           // text | pen | hl | eraser
    color: PEN_COLORS[0],
    hlColor: HL_COLORS[0],
    live: null,
    strokes: () => inkOf(getNote() || { }).strokes,
  };

  const toContent = e => {
    const r = editor.getBoundingClientRect();
    return { x: e.clientX - r.left + editor.scrollLeft, y: e.clientY - r.top + editor.scrollTop };
  };

  let drawing = false, penActive = false, erased = false;

  const onDown = e => {
    if (layer.mode === "text") return;
    /* Palm rejection: once a stylus has been seen on this layer, touch is
       the hand resting on the screen, not an instruction. The Fold's S Pen
       reports pointerType 'pen'. */
    if (e.pointerType === "pen") penActive = true;
    else if (penActive && e.pointerType === "touch") return;

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = toContent(e);

    if (layer.mode === "eraser") {
      drawing = true; erased = false;
      eraseAt(p.x, p.y);
      return;
    }
    drawing = true;
    const hl = layer.mode === "hl";
    layer.live = {
      id: uid(), mode: layer.mode,
      color: hl ? layer.hlColor : layer.color,
      w: hl ? HL_W : PEN_W,
      pts: [p.x, p.y],
    };
    redraw(layer);
  };

  const onMove = e => {
    if (!drawing) return;
    if (penActive && e.pointerType === "touch") return;
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
      if (layer.mode === "eraser") { eraseAt(p.x, p.y); continue; }
      const pts = layer.live.pts;
      const dx = p.x - pts[pts.length - 2], dy = p.y - pts[pts.length - 1];
      if (dx * dx + dy * dy < 1.5) continue; // thin out samples that add nothing
      pts.push(p.x, p.y);
    }
    redraw(layer);
  };

  const onUp = e => {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    const live = layer.live;
    layer.live = null;
    const n = getNote();
    if (!n) return;
    if (layer.mode === "eraser") {
      if (erased) { n.updated = Date.now(); persist(); }
      redraw(layer);
      return;
    }
    if (live && live.pts.length >= 2) {
      inkOf(n).strokes.push(live);
      n.updated = Date.now();
      persist();
      syncPageLock(noteEl, n);
    }
    redraw(layer);
  };

  function eraseAt(x, y) {
    const n = getNote();
    if (!n) return;
    const ink = inkOf(n);
    const keep = [];
    ink.strokes.forEach(s => {
      if (strokeNear(s, x, y, ERASER_R)) {
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
  canvas.addEventListener("pointercancel", onUp);

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
  syncPageLock(noteEl, note);
  redraw(layer);
  return layer;
}

export function detachNoteInk(noteEl) {
  const l = layers.get(noteEl);
  if (l) { l.destroy(); layers.delete(noteEl); }
}

/* Redraw every live layer — called after a sync replaces state, when the
   strokes on screen may be a merge of two devices' marks. */
export function redrawAllInk() {
  layers.forEach(l => { try { l.redraw(); } catch (e) { /* detached */ } });
}

function setMode(layer, mode) {
  layer.mode = mode;
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
  const swatches = layer.noteEl.querySelector(".ink-colors");
  swatches?.classList.toggle("show", mode === "pen" || mode === "hl");
  // The two tools have separate palettes and separate current colours, so
  // the row is rebuilt for whichever is live rather than shared.
  if (mode === "pen" || mode === "hl") renderSwatches(swatches, layer, mode);
  if (!drawing) layer.editor.focus();
}

/* ---------- the locked page ---------- */

/* Adding the first stroke is the moment the note's width stops being
   negotiable — see the header. Removing the last one gives it back. */
function syncPageLock(noteEl, note) {
  noteEl.classList.toggle("ink-locked", noteHasInk(note));
}

/* ---------- toolbar ---------- */

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
    <button type="button" class="ink-tool ink-done" data-tool="text" title="Back to typing">Done</button>`;
  noteEl.insertBefore(bar, noteEl.querySelector(".sec-note-body"));

  toggle.addEventListener("click", () => {
    const on = !noteEl.classList.contains("ink-open");
    noteEl.classList.toggle("ink-open", on);
    setMode(layer, on ? "pen" : "text");
    if (on && !noteHasInk(getNote())) {
      toast("Drawing locks this note's page width so the ink stays put");
    }
  });

  bar.addEventListener("click", e => {
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
