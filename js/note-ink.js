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

/* ---------- anchoring ---------- */

/* Paragraph boxes in the editor's scroll-content coordinate space, each
   carrying a short fingerprint of its text. The fingerprint is what makes
   the anchor survive editing: a paragraph's INDEX changes the moment one
   is inserted or deleted above it, so an index alone would leave the ink
   sitting on whichever paragraph inherited the number. */
function paraBoxes(editor) {
  const er = editor.getBoundingClientRect();
  return [...editor.children].map(el => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left - er.left + editor.scrollLeft,
      top: r.top - er.top + editor.scrollTop,
      width: r.width || 1,
      height: r.height,
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
function resolvePoints(s, boxes) {
  const a = s.a;
  const i = anchorIndex(a, boxes);
  if (i < 0 || !boxes[i]) return s.pts;
  const b = boxes[i];
  const k = b.width / (a.w || b.width); // how much the column has changed

  /* X scales with the column, Y does NOT.

     It is tempting to scale both by the same factor, but width and height
     move in OPPOSITE directions under reflow: narrow the column and a
     paragraph gets taller, because its text wraps onto more lines. Scaling
     the vertical offset down alongside the horizontal one dragged every
     mark up towards the top of its paragraph and squashed it flat — a
     circle round a phrase ended up a small ellipse floating above the
     first line, which is what the phone render showed.

     Only the horizontal axis reflows, so only the horizontal axis is
     scaled — both the anchor offset AND the stroke's own points. Vertical
     geometry is reproduced exactly as drawn, because nothing about it
     changed: the font is the same size on a phone as on a desktop, so a
     line of text is the same height and a mark spanning one line must
     still span one line. Scaling the shape vertically shrank a circle
     round a phrase into a flat sliver hovering above it.

     The cost is that a circle becomes an ellipse on a much narrower
     column. That is the right trade: it still encloses the same words on
     the same line, which is what the mark was for. */
  const ox = b.left + a.x * k, oy = b.top + a.y;
  const out = new Array(s.pts.length);
  for (let i = 0; i < s.pts.length; i += 2) {
    out[i] = ox + s.pts[i] * k;
    out[i + 1] = oy + s.pts[i + 1];
  }
  return out;
}
/* Line weight does not scale either: a 2.5px pen line is a 2.5px pen line
   against text that is the same size on every device. */

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
  const boxes = paraBoxes(editor);
  /* Resolved once per repaint and kept: the eraser has to hit-test against
     where strokes actually ARE on screen, not where they were drawn. */
  layer.boxes = boxes;
  layer.resolved = layer.strokes().map(s => resolvePoints(s, boxes));

  layer.strokes().forEach((s, i) => drawStroke(
    s.mode === "hl" ? hlCtx : penCtx, s, top, layer.resolved[i], s.w));
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
    penW: PEN_W,
    hlW: HL_W,
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
      w: hl ? layer.hlW : layer.penW,
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
      inkOf(n).strokes.push(anchorStroke(live, paraBoxes(editor)));
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
    const boxes = layer.boxes || paraBoxes(editor);
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
    out[i] = s.pts[i] - x0;
    out[i + 1] = s.pts[i + 1] - y0;
  }
  s.a = { p, t: b.t, x: x0 - b.left, y: y0 - b.top, w: b.width };
  s.pts = out;
  return s;
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
  const widths = layer.noteEl.querySelector(".ink-widths");
  widths?.classList.toggle("show", mode === "pen" || mode === "hl");
  if (mode === "pen" || mode === "hl") {
    renderSwatches(swatches, layer, mode);
    renderWidths(widths, layer, mode);
  }
  if (!drawing) layer.editor.focus();
}

/* The note's width is no longer touched by the presence of ink — strokes
   follow their paragraph instead of demanding a fixed column, so the page
   stays a normal responsive one on every device. Kept as a no-op hook and
   a class that CSS uses only for cursor affordances. */
function syncPageLock(noteEl, note) {
  noteEl.classList.toggle("has-ink", noteHasInk(note));
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
    <button type="button" class="ink-tool ink-done" data-tool="text" title="Back to typing">Done</button>`;
  noteEl.insertBefore(bar, noteEl.querySelector(".sec-note-body"));

  toggle.addEventListener("click", () => {
    const on = !noteEl.classList.contains("ink-open");
    noteEl.classList.toggle("ink-open", on);
    setMode(layer, on ? "pen" : "text");

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
      // the weight swatches are drawn in the live colour, so they follow it
      renderWidths(bar.querySelector(".ink-widths"), layer, layer.mode === "hl" ? "hl" : "pen");
      return;
    }
    const wq = e.target.closest(".ink-width");
    if (wq) {
      const w = parseFloat(wq.dataset.w);
      if (layer.mode === "hl") layer.hlW = w; else layer.penW = w;
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
