/* A real, rendering rich-text editor (Quill.js — free, open source, no
   API key) for anywhere a plain textarea isn't enough: bold/italic/
   underline/strikethrough, sub/superscript, font family & size, text
   colour & highlight, bullet/numbered lists, indent, alignment, and line
   spacing — matching the core of a Word-style toolbar. A few Word-only
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

const instances = {}; // containerId -> quill instance

const FONTS = ["arial", "times-new-roman", "georgia", "verdana", "courier-new", "trebuchet-ms", "comic-sans-ms", "impact"];
const LINE_HEIGHTS = ["1", "1.15", "1.5", "2", "2.5", "3"];

const TOOLBAR = [
  [{ font: FONTS }, { size: ["small", false, "large", "huge"] }],
  ["bold", "italic", "underline", "strike"],
  [{ script: "sub" }, { script: "super" }],
  [{ color: [] }, { background: [] }],
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
export function mountRichEditor(containerId, getInitialHtml, onChange) {
  if (instances[containerId]) return instances[containerId];
  const el = document.getElementById(containerId);
  if (!el || typeof Quill === "undefined") return null;

  registerCustomFormats();

  const quill = new Quill(el, { theme: "snow", modules: { toolbar: TOOLBAR } });
  const initial = getInitialHtml();
  if (initial) quill.clipboard.dangerouslyPasteHTML(initial);
  addLineHeightControl(quill);

  let timer = null;
  quill.on("text-change", () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(quill.root.innerHTML), 500);
  });

  instances[containerId] = quill;
  return quill;
}

export function unmountRichEditor(containerId) {
  delete instances[containerId];
}

export function getRichEditor(containerId) {
  return instances[containerId] || null;
}
