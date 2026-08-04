/* Allowlist sanitizer for every piece of stored HTML in LifeOS.
   
   Rich content (journal entries, section notes, meeting minutes, packing
   notes, sticky notes) is stored as HTML, round-trips through Supabase,
   and is written back into the page with innerHTML or Quill's
   dangerouslyPasteHTML. That is only safe if the HTML is constrained —
   and it can arrive from places other than this app's own toolbar: a
   paste from a web page carries whatever markup that page had, and a
   synced record could in principle be anything.
   
   The approach is an allowlist, not a blocklist: anything not explicitly
   permitted is removed. Blocklists lose, because the attack surface is
   every tag and attribute a browser will ever support.
   
   Parsing uses DOMParser rather than assigning to a detached div's
   innerHTML. Neither executes <script>, but innerHTML on an element can
   still start fetches for things like <img src>, and an onerror handler
   can fire off the back of that. DOMParser builds an inert document
   where nothing loads and nothing runs. */

const ALLOWED_TAGS = new Set([
  "P", "BR", "DIV", "SPAN",
  "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "SUB", "SUP",
  "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE",
  "A", "HR", "LABEL",
  "TABLE", "THEAD", "TBODY", "TR", "TD", "TH"
]);

/* `class` is allowed on block elements because the editors encode
   structure in classes rather than inline style: Quill uses ql-* for
   alignment, indent, size and font, and sticky-note checklists use wb-*
   for the checkbox rows. Both prefixes are the app's own, and the filter
   below permits nothing else, so a class can't reach for styling defined
   anywhere outside those two namespaces.

   `contenteditable` and `data-checked` are permitted on SPAN for one
   specific reason: a sticky-note checkbox is a contenteditable="false"
   span carrying its own tick state. Strip either and the checkbox stops
   being a checkbox — it becomes an ordinary character that can't be
   ticked and behaves oddly when edited. Both values are validated below
   rather than passed through, since neither can execute anything but
   both change how the editor treats the element. */
const ALLOWED_ATTRS = {
  SPAN: ["style", "class", "contenteditable", "data-checked"],
  DIV: ["style", "class", "contenteditable"], P: ["style", "class"],
  LI: ["style", "class"], OL: ["class"], UL: ["class"], PRE: ["class"],
  BLOCKQUOTE: ["class"], CODE: ["class"],
  H1: ["style", "class"], H2: ["style", "class"], H3: ["style", "class"],
  H4: ["style", "class"], H5: ["style", "class"], H6: ["style", "class"],
  A: ["href", "target", "rel"],
  TD: ["colspan", "rowspan"], TH: ["colspan", "rowspan"]
};

// Only presentational properties. Notably absent: position, z-index and
// anything else that could let one note cover the rest of the interface.
const ALLOWED_STYLE_PROPS = /^(color|background-color|font-size|font-family|font-weight|font-style|text-align|text-decoration|line-height)\s*:/i;

function cleanStyle(el) {
  const safe = (el.getAttribute("style") || "").split(";")
    .map(s => s.trim())
    .filter(s => ALLOWED_STYLE_PROPS.test(s))
    // url(...) can reference remote resources; expression() is a legacy
    // IE script vector. Neither belongs in a note's formatting.
    .filter(s => !/url\s*\(|expression\s*\(/i.test(s))
    .join("; ");
  if (safe) el.setAttribute("style", safe); else el.removeAttribute("style");
}

function cleanClass(el) {
  const classes = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
  // "done" is the ticked state of a checkbox row and carries its
  // strikethrough. It's a bare, generic name, so it's only permitted
  // alongside a wb- class — that keeps stored content from reaching for
  // the identically-named .done styling used elsewhere in the app.
  const hasWb = classes.some(c => /^wb-[\w-]+$/.test(c));
  const safe = classes
    .filter(c => /^(ql|wb)-[\w-]+$/.test(c) || (hasWb && c === "done"))
    .join(" ");
  if (safe) el.setAttribute("class", safe); else el.removeAttribute("class");
}

/* contenteditable="false" is what makes a checkbox behave as one solid
   object rather than loose text. Only that exact value is kept: "true"
   and the plaintext-only variant are dropped, since neither is something
   stored content has any business asserting. */
function cleanEditable(el) {
  if ((el.getAttribute("contenteditable") || "").toLowerCase() !== "false") {
    el.removeAttribute("contenteditable");
  }
}
function cleanChecked(el) {
  const v = (el.getAttribute("data-checked") || "").toLowerCase();
  if (v !== "true" && v !== "false") el.removeAttribute("data-checked");
}

function cleanHref(el) {
  const href = (el.getAttribute("href") || "").trim();
  // Only absolute http(s) and mailto. This is what stops javascript: and
  // data: URLs, which are the usual way a link turns into code execution.
  if (!/^(https?:\/\/|mailto:)/i.test(href)) {
    el.removeAttribute("href");
    return;
  }
  el.setAttribute("target", "_blank");
  el.setAttribute("rel", "noopener noreferrer");
}

// Dropped whole rather than unwrapped — unwrapping these would spill
// their source code into the document as visible text.
const DROP_WHOLE = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE",
  "NOSCRIPT", "SVG", "MATH", "LINK", "META", "BASE", "FORM"
]);

export function sanitizeHtml(html) {
  const input = String(html ?? "");
  if (!input) return "";
  if (!input.includes("<")) return input; // plain text, nothing to strip

  const doc = new DOMParser().parseFromString(input, "text/html");

  /* Walks the live child list rather than a snapshot of it. That matters
     because unwrapping a disallowed tag hoists its children into this
     level — and those children have not been inspected yet. Iterating a
     snapshot would skip them entirely, so <svg><script>…</script></svg>
     would lose the <svg> and leave the <script> sitting in the output.
     After an unwrap, traversal resumes at the first hoisted node. */
  (function walk(node) {
    let child = node.firstChild;
    while (child) {
      let next = child.nextSibling;

      if (child.nodeType === 3) { child = next; continue; }        // text — always safe
      if (child.nodeType !== 1) { child.remove(); child = next; continue; } // comments, CDATA

      // Foreign content (SVG, MathML) reports a lower-case tagName, so
      // every comparison here has to be case-folded — this is exactly
      // how an <svg>-wrapped <script> would otherwise slip through.
      const tag = (child.tagName || "").toUpperCase();

      if (DROP_WHOLE.has(tag)) { child.remove(); child = next; continue; }

      if (!ALLOWED_TAGS.has(tag)) {
        // Unwrap: the tag goes, the words the person wrote stay.
        next = child.firstChild || next;
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        child.remove();
        child = next;
        continue;
      }

      const allowed = ALLOWED_ATTRS[tag] || [];
      Array.from(child.attributes).forEach(attr => {
        const name = attr.name.toLowerCase();
        // Every on* handler is an attribute, so this single check covers
        // onclick, onerror, onload and the rest in one go.
        if (name.startsWith("on") || !allowed.includes(name)) {
          child.removeAttribute(attr.name);
        }
      });

      if (child.hasAttribute("style")) cleanStyle(child);
      if (child.hasAttribute("class")) cleanClass(child);
      if (child.hasAttribute("contenteditable")) cleanEditable(child);
      if (child.hasAttribute("data-checked")) cleanChecked(child);
      if (tag === "A") cleanHref(child);

      walk(child);
      child = next;
    }
  })(doc.body);

  return doc.body.innerHTML;
}

/* Readable text with all markup removed — for search indexes, list
   snippets and plain-text exports. */
export function htmlToText(html) {
  const s = String(html ?? "");
  if (!s.includes("<")) return s.trim();
  const withBreaks = s
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\u2022 ")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|tr|ul|ol|pre)\s*>/gi, "\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
