/* A real, rendering rich-text editor (Quill.js — free, open source, no
   API key) for anywhere a plain textarea isn't enough: bold/italic/
   underline/strikethrough, sub/superscript, font family & size, text
   colour & highlight, bullet/numbered lists, indent, and alignment —
   matching the core of a Word-style toolbar. A few Word-only concepts
   (multilevel list numbering schemes, A–Z list sorting, the paragraph-
   marks toggle, paragraph shading/borders) aren't things any web rich-
   text editor exposes as standard buttons, so those aren't included.

   Content is stored as HTML. Existing plain-text content (from before
   this editor existed) loads in as-is — safe, no data loss, it just
   won't retroactively "become" rich text.

   Instances are cached by container id and reused rather than recreated,
   since Quill lives in a real DOM node — recreating it on every render
   (the same mistake this app already hit once with its Leaflet maps)
   would wipe out an active editing session and its cursor position. */

const instances = {}; // containerId -> quill instance

const TOOLBAR = [
  [{ font: [] }, { size: ["small", false, "large", "huge"] }],
  ["bold", "italic", "underline", "strike"],
  [{ script: "sub" }, { script: "super" }],
  [{ color: [] }, { background: [] }],
  [{ list: "ordered" }, { list: "bullet" }],
  [{ indent: "-1" }, { indent: "+1" }],
  [{ align: [] }],
  ["clean"]
];

/* Create (or reuse) a Quill editor in `containerId`. `getInitialHtml` is
   only consulted the FIRST time (new instance) so re-render passes never
   clobber what's currently being typed. `onChange(html)` fires debounced
   as the user edits. */
export function mountRichEditor(containerId, getInitialHtml, onChange) {
  if (instances[containerId]) return instances[containerId];
  const el = document.getElementById(containerId);
  if (!el || typeof Quill === "undefined") return null;

  const quill = new Quill(el, { theme: "snow", modules: { toolbar: TOOLBAR } });
  const initial = getInitialHtml();
  if (initial) quill.clipboard.dangerouslyPasteHTML(initial);

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
