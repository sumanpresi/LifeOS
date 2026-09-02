/* A real, rendering rich-text editor (Quill.js — free, open source, no
   API key) for anywhere a plain textarea isn't enough: bold/italic/
   underline/strikethrough, sub/superscript, font family & size, text
   colour & highlight, hyperlinks, bullet/numbered lists, indent, alignment,
   and line spacing — matching the core of a Word-style toolbar. A few Word-only
   concepts (multilevel list numbering schemes, A–Z list sorting, the
   paragraph-marks toggle, paragraph shading/borders) aren't things any
   web rich-text editor exposes as standard buttons, so those aren't
   included.

   Fonts: web-safe common names (Arial, Times New Roman, Georgia, etc.)
   rather than Word/Microsoft-licensed fonts like Calibri, which aren't
   guaranteed to be installed on every device or render consistently
   across platforms the way these are.

   Content is stored as HTML. Existing plain-text content (from before
   this editor existed) loads in as-is — safe, no data loss, it just
   won't retroactively "become" rich text.

   Instances are cached by container id and reused rather than recreated,
   since Quill lives in a real DOM node — recreating it on every render
   (the same mistake this app already hit once with its Leaflet maps)
   would wipe out an active editing session and its cursor position. */

import { sanitizeHtml } from './sanitize.js?v=202609040600';

const instances = {}; // containerId -> quill instance

const FONTS = ["arial", "times-new-roman", "georgia", "verdana", "courier-new", "trebuchet-ms", "comic-sans-ms", "impact"];
const LINE_HEIGHTS = ["1", "1.15", "1.5", "2", "2.5", "3"];

const TOOLBAR = [
  [{ font: FONTS }, { size: ["small", false, "large", "huge"] }],
  ["bold", "italic", "underline", "strike"],
  [{ script: "sub" }, { script: "super" }],
  [{ color: [] }, { background: [] }],
  ["link"],
  [{ list: "ordered" }, { list: "bullet" }],
  [{ indent: "-1" }, { indent: "+1" }],
  [{ align: [] }],
  ["clean"]
];

let registered = false;
function registerCustomFormats() {
  if (registered || typeof Quill === "undefined") return;
  registered = true;
  try {
    const FontAttributor = Quill.import("attributors/class/font");
    FontAttributor.whitelist = FONTS;
    Quill.register(FontAttributor, true);

    const Parchment = Quill.import("parchment");
    const LineHeightStyle = new Parchment.StyleAttributor("lineheight", "line-height", {
      scope: Parchment.Scope.BLOCK,
      whitelist: LINE_HEIGHTS
    });
    Quill.register(LineHeightStyle, true);
  } catch (e) { /* if the registration API ever shifts again, editors still work — just without these two extras */ }
}

function addLineHeightControl(quill) {
  try {
    const toolbarModule = quill.getModule("toolbar");
    const bar = toolbarModule && toolbarModule.container;
    if (!bar) return;

    const wrap = document.createElement("span");
    wrap.className = "ql-formats";
    const select = document.createElement("select");
    select.className = "ql-lineheight-select";
    select.title = "Line spacing";
    select.innerHTML = `<option value="">Line spacing</option>` +
      LINE_HEIGHTS.map(v => `<option value="${v}">${v}</option>`).join("");
    select.onchange = () => { if (select.value) quill.format("lineheight", select.value); select.value = ""; };
    wrap.appendChild(select);
    bar.appendChild(wrap);
  } catch (e) { /* the line-spacing control is an extra, not core — the editor itself must still work */ }
}

/* Create (or reuse) a Quill editor in `containerId`. `getInitialHtml` is
   only consulted the FIRST time (new instance) so re-render passes never
   clobber what's currently being typed. `onChange(html)` fires debounced
   as the user edits. */
/* `onDirty` (optional) fires on the FIRST user keystroke of an edit,
   before the 500ms debounce — the window where the text exists only
   inside Quill and nothing else in the app knows it is there. Sync uses
   it to hold off; without it that window looks identical to idle. */
export function mountRichEditor(containerId, getInitialHtml, onChange, onDirty) {
  if (instances[containerId]) return instances[containerId];
  const el = document.getElementById(containerId);
  if (!el || typeof Quill === "undefined") return null;

  registerCustomFormats();

  const quill = new Quill(el, { theme: "snow", modules: { toolbar: TOOLBAR } });
  // Both directions are sanitized. Inbound, because stored HTML may
  // predate this check or have arrived from another device; outbound,
  // because a paste from a web page brings that page's markup with it
  // and this is the last point before it reaches storage.
  setEditorHtml(quill, getInitialHtml());
  addLineHeightControl(quill);

  let timer = null;
  quill.on("text-change", (delta, oldDelta, source) => {
    // Loading existing content via dangerouslyPasteHTML above also fires
    // this event (source 'api'), not just genuine typing (source 'user').
    // Reacting to both would mean simply *opening* a meeting to read it
    // triggers a save — silently bumping the sync timestamp as if it had
    // been edited, which is exactly the mechanism behind the multi-device
    // sync bug fixed earlier in this project. Only 'user' should count.
    if (source !== "user") return;
    if (onDirty) { try { onDirty(); } catch (e) { console.warn("[editor] onDirty failed", e); } }
    clearTimeout(timer);
    timer = setTimeout(() => onChange(sanitizeHtml(quill.root.innerHTML)), 500);
  });

  instances[containerId] = quill;
  return quill;
}

/* Dropping the cached instance is not enough on its own. Quill mounts by
   converting the container into `.ql-container` and inserting its toolbar
   as a SIBLING immediately before it — so if the same container is mounted
   again later (Notebook's "+ Add page", travel.js's delPackList), the new
   Quill stacks a second toolbar and swallows the old editor's DOM as the
   new document's starting content. The next keystroke then saves the
   previous page's text into the new page. Verified, not theorised: a
   second `new Quill(el)` on the same node yields 2 toolbars and inherits
   the first document's text.

   So teardown puts the node back the way it was found — Quill's own
   classes stripped, its children gone, the toolbar removed — leaving any
   classes the app put there (mm-rich-editor, nb-rich-editor) intact. */
/* Loads HTML into an editor WITHOUT taking focus.

   quill.clipboard.dangerouslyPasteHTML() — the obvious call, and the one
   this replaced — ends by calling setSelection() internally, which focuses
   the editor. On a desktop that is invisible. On a phone or a folding
   phone, focus means the on-screen keyboard, so an editor merely being
   RENDERED, or a notebook page being switched, threw up the keyboard over
   half the screen without anyone asking to type. setContents() with a
   converted delta loads exactly the same content and leaves focus alone.

   Verified against Quill 2: dangerouslyPasteHTML moves focus into the
   editor; setContents(clipboard.convert(...)) does not, and produces the
   same text. */
export function setEditorHtml(quill, html) {
  if (!quill) return;
  const clean = sanitizeHtml(html || "");
  if (!clean) { quill.setText("", "silent"); return; }
  quill.setContents(quill.clipboard.convert({ html: clean }), "silent");
}

export function unmountRichEditor(containerId) {
  delete instances[containerId];
  const el = document.getElementById(containerId);
  if (!el) return;
  const bar = el.previousElementSibling;
  if (bar && bar.classList && bar.classList.contains("ql-toolbar")) bar.remove();
  Array.from(el.classList).forEach(c => { if (c.startsWith("ql-")) el.classList.remove(c); });
  el.innerHTML = "";
}

export function getRichEditor(containerId) {
  return instances[containerId] || null;
}
