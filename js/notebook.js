/* Notebook: a OneNote-style space — several named Sections down the left,
   each holding several named Pages, each page a full rich-text document.
   Both section and page names are directly editable (click into the name
   field in the list, or the big title field above the page itself).

   One shared Quill instance backs the currently open page, swapped on
   navigation — the same one-editor-many-documents approach travel.js
   uses for packing-list notes. See flushNotebookPage() for why content is
   read back before the editor's contents are replaced. */
import { state, uid, esc, persist, rerender } from './state.js';
import { mountRichEditor, unmountRichEditor, getRichEditor } from './rich-text.js';
import { sanitizeHtml } from './sanitize.js';
import { moveToTrash } from './trash.js';

/* Cycled through by section creation order so each section gets a
   distinct colour strip, purely cosmetic — like OneNote's own section
   colours. */
const NB_COLORS = ["#4B5C42", "#9C5B3C", "#2F6690", "#7A5A8A", "#B08628", "#8A3E3E", "#3F7A63", "#6B4A6B"];
const NB_EDITOR = "nbPageEditor";

function ensureNotebook() {
  if (!state.notebook || !Array.isArray(state.notebook.sections) || !state.notebook.sections.length) {
    const pageId = uid();
    state.notebook = {
      sections: [{ id: uid(), name: "General", color: 0, pages: [
        { id: pageId, name: "Untitled page", html: "", createdAt: Date.now(), updatedAt: Date.now() }
      ], activePage: pageId }],
      activeSection: ""
    };
    state.notebook.activeSection = state.notebook.sections[0].id;
  }
  return state.notebook;
}

function activeNbSection() {
  const nb = ensureNotebook();
  return nb.sections.find(s => s.id === nb.activeSection) || nb.sections[0];
}
function activeNbPage(sec) {
  sec = sec || activeNbSection();
  if (!sec || !sec.pages.length) return null;
  return sec.pages.find(p => p.id === sec.activePage) || sec.pages[0];
}
function findNbPageById(id) {
  const nb = ensureNotebook();
  for (const sec of nb.sections) {
    const p = sec.pages.find(x => x.id === id);
    if (p) return p;
  }
  return null;
}

/* Which page's HTML the shared editor currently holds — null means
   nothing has been loaded into it yet this session. */
let loadedNbPageId = null;

/* Quill's change handler is debounced, so an edit can still be sitting
   unsaved when the page is switched — write it back to the page it
   belongs to first, exactly like flushPackNotes() in travel.js. */
function flushNotebookPage() {
  const q = getRichEditor(NB_EDITOR);
  if (!q || loadedNbPageId === null) return;
  const p = findNbPageById(loadedNbPageId);
  if (p && p.html !== q.root.innerHTML) { p.html = q.root.innerHTML; p.updatedAt = Date.now(); persist(); }
}

function fmtTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const datePart = d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart}   ${timePart}`;
}

export function renderNotebook() {
  const nb = ensureNotebook();
  const sec = activeNbSection();
  if (sec && nb.activeSection !== sec.id) nb.activeSection = sec.id;

  /* ---- sections column ---- */
  const secList = document.getElementById("nbSectionList");
  /* The rebuild is skipped while focus is inside this list, so a rename in
     progress isn't yanked out from under the cursor. But clicking a name is
     ALSO focus inside this list — which meant selecting a section switched
     its pages while the highlight stayed on the old one. The `.active` class
     is therefore reconciled separately, below, whether or not the list was
     redrawn; `data-id` exists so that reconciliation has something to match
     rows on without rebuilding them. */
  if (secList && !secList.contains(document.activeElement)) {
    secList.innerHTML = nb.sections.map(s => `
      <div class="nb-row ${s.id === sec.id ? "active" : ""}" data-id="${s.id}">
        <span class="nb-color-bar" style="background:${NB_COLORS[s.color % NB_COLORS.length]}"></span>
        <input type="text" class="nb-row-name" value="${esc(s.name)}" placeholder="Untitled section"
          onclick="switchNotebookSection('${s.id}')"
          onchange="renameNotebookSection('${s.id}', this.value)">
        ${nb.sections.length > 1 ? `<button class="nb-row-del" title="Delete section" onclick="event.stopPropagation();delNotebookSection('${s.id}')">✕</button>` : ""}
      </div>`).join("");
  }
  if (secList) secList.querySelectorAll(".nb-row").forEach(r => r.classList.toggle("active", r.dataset.id === sec.id));

  /* ---- pages column ---- */
  const page = activeNbPage(sec);
  if (page && sec.activePage !== page.id) sec.activePage = page.id;
  const pageList = document.getElementById("nbPageList");
  if (pageList && !pageList.contains(document.activeElement)) {
    pageList.innerHTML = (sec.pages || []).map(p => `
      <div class="nb-row ${page && p.id === page.id ? "active" : ""}" data-id="${p.id}">
        <input type="text" class="nb-row-name" value="${esc(p.name)}" placeholder="Untitled page"
          onclick="switchNotebookPage('${p.id}')"
          onchange="renameNotebookPage('${p.id}', this.value)">
        ${sec.pages.length > 1 ? `<button class="nb-row-del" title="Delete page" onclick="event.stopPropagation();delNotebookPage('${p.id}')">✕</button>` : ""}
      </div>`).join("") || `<p class="hint">No pages yet — "+ Add page" starts one.</p>`;
  }
  if (pageList) pageList.querySelectorAll(".nb-row").forEach(r => r.classList.toggle("active", !!page && r.dataset.id === page.id));
  const label = document.getElementById("nbActiveSectionLabel");
  if (label) label.textContent = sec ? sec.name : "Pages";
  const pageAddBtn = document.getElementById("nbAddPageBtn");
  if (pageAddBtn) pageAddBtn.disabled = !sec;

  /* ---- editor pane ---- */
  const titleEl = document.getElementById("nbPageTitleInput");
  if (titleEl && document.activeElement !== titleEl) titleEl.value = page ? page.name : "";
  const metaEl = document.getElementById("nbPageMeta");
  if (metaEl) metaEl.textContent = page ? fmtTimestamp(page.updatedAt || page.createdAt) : "";
  const delBtn = document.getElementById("nbPageDelBtn");
  if (delBtn) delBtn.style.display = (page && sec.pages.length > 1) ? "" : "none";

  const editorBox = document.getElementById(NB_EDITOR);
  if (!editorBox) return;
  if (!page) { editorBox.innerHTML = ""; return; }

  const quill = mountRichEditor(NB_EDITOR, () => page.html || "", html => {
    const p2 = findNbPageById(loadedNbPageId);
    if (!p2) return; // deleted from another device mid-edit
    p2.html = html;
    p2.updatedAt = Date.now();
    persist(); // rich-text.js already debounced this; rerender() here would destroy the editor mid-edit
  });
  if (!quill) return;
  quill.root.dataset.placeholder = "Start writing…";
  if (loadedNbPageId === null) { loadedNbPageId = page.id; return; }
  if (loadedNbPageId === page.id) return;
  flushNotebookPage();
  loadedNbPageId = page.id;
  // Switching pages loads HTML directly, outside mountRichEditor's own
  // (first-mount-only) sanitizing path.
  if (page.html) quill.clipboard.dangerouslyPasteHTML(sanitizeHtml(page.html));
  else quill.setText("");
}

/* ---------------- sections ---------------- */
export function addNotebookSection() {
  const nb = ensureNotebook();
  flushNotebookPage();
  const pageId = uid();
  const sec = {
    id: uid(), name: "New section", color: nb.sections.length,
    pages: [{ id: pageId, name: "Untitled page", html: "", createdAt: Date.now(), updatedAt: Date.now() }],
    activePage: pageId
  };
  nb.sections.push(sec);
  nb.activeSection = sec.id;
  loadedNbPageId = null;
  unmountRichEditor(NB_EDITOR);
  persist(); renderNotebook();
  document.querySelector("#nbSectionList .nb-row.active .nb-row-name")?.select();
}
export function switchNotebookSection(id) {
  const nb = ensureNotebook();
  if (nb.activeSection === id) return; // already open — don't rebuild the list under someone renaming it
  flushNotebookPage();
  nb.activeSection = id;
  loadedNbPageId = null;
  persist(false); renderNotebook();
}
export function renameNotebookSection(id, v) {
  const nb = ensureNotebook();
  const sec = nb.sections.find(s => s.id === id);
  if (!sec || !v.trim()) return;
  sec.name = v.trim();
  persist(); renderNotebook();
}
export function delNotebookSection(id) {
  const nb = ensureNotebook();
  if (nb.sections.length <= 1) return; // a notebook always keeps at least one section
  const sec = nb.sections.find(s => s.id === id);
  if (!sec) return;
  if (!confirm(`Delete the "${sec.name}" section and its ${sec.pages.length} page(s)? You can restore it from Trash within 30 days.`)) return;
  if (loadedNbPageId && sec.pages.some(p => p.id === loadedNbPageId)) { loadedNbPageId = null; unmountRichEditor(NB_EDITOR); }
  moveToTrash("notebookSection", sec);
  nb.sections = nb.sections.filter(s => s.id !== id);
  if (nb.activeSection === id) nb.activeSection = nb.sections[0].id;
  persist(); renderNotebook();
}

/* ---------------- pages ---------------- */
export function addNotebookPage() {
  const sec = activeNbSection();
  if (!sec) return;
  flushNotebookPage();
  const p = { id: uid(), name: "Untitled page", html: "", createdAt: Date.now(), updatedAt: Date.now() };
  sec.pages.unshift(p);
  sec.activePage = p.id;
  loadedNbPageId = null;
  unmountRichEditor(NB_EDITOR);
  persist(); renderNotebook();
  document.getElementById("nbPageTitleInput")?.select();
}
export function switchNotebookPage(id) {
  const sec = activeNbSection();
  if (!sec || sec.activePage === id) return;
  flushNotebookPage();
  sec.activePage = id;
  loadedNbPageId = null;
  persist(false); renderNotebook();
}
/* Called from the big title field above the page (renames the active
   page) and from a row in the pages list (renames that specific page). */
export function renameNotebookPage(a, b) {
  const sec = activeNbSection();
  if (!sec) return;
  const id = b === undefined ? sec.activePage : a;
  const v = b === undefined ? a : b;
  const p = sec.pages.find(x => x.id === id);
  if (!p || !v.trim()) return;
  p.name = v.trim();
  p.updatedAt = Date.now();
  persist(); renderNotebook();
}
export function delNotebookPage(id) {
  const sec = activeNbSection();
  if (!sec) return;
  if (sec.pages.length <= 1) return; // a section always keeps at least one page
  const pid = id || sec.activePage;
  const p = sec.pages.find(x => x.id === pid);
  if (!p) return;
  if (!confirm(`Delete the "${p.name || "Untitled page"}" page? You can restore it from Trash within 30 days.`)) return;
  if (loadedNbPageId === p.id) {
    const q = getRichEditor(NB_EDITOR);
    if (q) p.html = q.root.innerHTML; // trash keeps the latest text, including anything still in the debounce window
    loadedNbPageId = null;
    unmountRichEditor(NB_EDITOR);
  }
  moveToTrash("notebookPage", p, { sectionId: sec.id });
  sec.pages = sec.pages.filter(x => x.id !== pid);
  sec.activePage = sec.pages[0].id;
  persist(); renderNotebook();
}
