/* Notebook: a OneNote-style space — several named Sections down the left,
   each holding several named Pages, each page a full rich-text document.
   Both section and page names are directly editable (click into the name
   field in the list, or the big title field above the page itself).

   One shared Quill instance backs the currently open page, swapped on
   navigation — the same one-editor-many-documents approach travel.js
   uses for packing-list notes. See flushNotebookPage() for why content is
   read back before the editor's contents are replaced. */
import { state, uid, esc, persist, rerender } from './state.js';
import { mountRichEditor, unmountRichEditor, getRichEditor, setEditorHtml } from './rich-text.js';
import { moveToTrash } from './trash.js';
import { registerBusyCheck } from './ui.js';

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
/* The exact HTML the editor was last handed, or last committed back. It is
   how a change made ELSEWHERE is told apart from the editor's own text:
   if page.html no longer matches this, something other than this editor
   wrote it — a sync from another device — and the editor is out of date. */
let loadedNbHtml = null;
/* Quill normalises whatever HTML it is given, so the editor's innerHTML is
   almost never byte-identical to the stored string it was loaded from.
   Comparing the two to decide "did this change?" therefore answered yes
   every time — which meant simply RECEIVING a sync bumped updatedAt and
   the rev counter and sent a save straight back, the same false-edit shape
   the Communication iframe's old unconditional save() had. The baseline is
   the editor's own innerHTML at the moment of loading, so a comparison
   against it only reports real typing. */
let loadedNbBaseline = null;

/* True from the first keystroke of an edit until it reaches `state` 500ms
   later. In that window the text exists ONLY inside Quill: not saved, not
   synced, and invisible to Undo and Trash. Registering it as a busy check
   stops a background pull from replacing state and repainting mid-
   sentence — the journal does the same thing for the same reason. */
let nbEditorDirty = false;
export function hasUnsavedNotebookEdit() { return nbEditorDirty; }
registerBusyCheck(hasUnsavedNotebookEdit);

/* Forces a pending edit out to `state` without waiting for the debounce.
   Called before a cloud pull reads state, and before the tab backgrounds
   or closes — on mobile, timers can be frozen the moment the app goes to
   the background, so the last thing typed would otherwise never reach
   `state` at all. */
export function flushNotebookEditor() {
  flushNotebookPage();
  nbEditorDirty = false;
}

/* Quill's change handler is debounced, so an edit can still be sitting
   unsaved when the page is switched — write it back to the page it
   belongs to first, exactly like flushPackNotes() in travel.js. */
function flushNotebookPage() {
  const q = getRichEditor(NB_EDITOR);
  if (!q || loadedNbPageId === null) return;
  const p = findNbPageById(loadedNbPageId);
  const cur = q.root.innerHTML;
  if (p && cur !== loadedNbBaseline) {
    p.html = cur;
    p.updatedAt = Date.now();
    loadedNbHtml = cur;
    loadedNbBaseline = cur;
    persist();
  }
  nbEditorDirty = false;
}

function fmtTimestamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const datePart = d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart}   ${timePart}`;
}

/* Row names are a plain <span> until a rename is actually asked for.

   They used to be <input> always, and on a touch screen that made the
   list unusable: tapping a row put the caret in a text field and raised
   the keyboard instead of opening the section — there was no way to
   simply switch tabs by tapping. A span can't swallow the tap, so the
   row's own onclick is free to do the obvious thing, and renaming moved
   onto an explicit ✎ (or a double-click, on a desktop). A span also
   wraps and ellipsises, which an <input> cannot do at any width. */
let nbRenaming = null;
function rowName(kind, o, placeholder) {
  const nm = (o.name || "").trim();
  if (nbRenaming !== o.id) {
    return `<span class="nb-row-name ${nm ? "" : "is-empty"}">${esc(nm || placeholder)}</span>`;
  }
  return `<input type="text" class="nb-row-name nb-row-input" value="${esc(o.name)}" placeholder="${esc(placeholder)}"
    data-orig="${esc(o.name)}"
    onclick="event.stopPropagation()"
    onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}else if(event.key==='Escape'){this.value=this.dataset.orig;this.blur();}"
    onblur="commitNotebookRename('${kind}','${o.id}',this.value)">`;
}
/* The only thing a rebuild can destroy is a rename input the person is
   typing into. Skipping the rebuild for ANY focused element was too broad
   — after a rename committed, the ✎ button or the row still held focus
   and the list kept showing the stale input. */
function renamingInside(listEl) {
  const el = document.activeElement;
  return !!nbRenaming && !!el && listEl.contains(el) && el.classList.contains("nb-row-input");
}
/* A phone or a folding phone has no hover and no mouse, and on it a text
   field getting focus means the on-screen keyboard takes half the screen.
   So anything that focuses a field as a SIDE EFFECT — rather than because
   the person asked to type — is gated on having a real pointer. */
function coarsePointer() {
  try { return !!(window.matchMedia && window.matchMedia("(pointer:coarse)").matches); }
  catch (e) { return false; }
}

/* Two quick taps on a tab, which is just how people tap, register as a
   dblclick in the browser — and that was opening the rename field and the
   keyboard with it. Double-click stays a rename shortcut where there is a
   mouse to double-click with. */
export function renameOnDoubleClick(kind, id) {
  if (coarsePointer()) return;
  startNotebookRename(kind, id);
}

export function startNotebookRename(kind, id) {
  /* The ✎ button lives inside the list, so it holds focus at this moment
     — and the render below skips any list that contains the focused
     element. Without dropping focus first the input would never appear. */
  try { document.activeElement && document.activeElement.blur(); } catch (e) {}
  if (kind === "sec") switchNotebookSection(id); else switchNotebookPage(id);
  nbRenaming = id;
  renderNotebook();
}
export function commitNotebookRename(kind, id, v) {
  nbRenaming = null;
  if (kind === "sec") renameNotebookSection(id, v);
  else renameNotebookPage(id, v);
  renderNotebook(); // rename*() returns early on a blank value, so render unconditionally
}

export function renderNotebook() {
  const nb = ensureNotebook();
  const sec = activeNbSection();
  if (sec && nb.activeSection !== sec.id) nb.activeSection = sec.id;

  /* ---- sections column ---- */
  const secList = document.getElementById("nbSectionList");
  /* The rebuild is skipped while focus is inside this list, so a rename in
     progress isn't yanked out from under the cursor. Selecting a row no
     longer puts focus in here at all (the row is a plain tap target now),
     so the `.active` class is reconciled separately below — `data-id` is
     what that reconciliation matches rows on without rebuilding them. */
  if (secList && !renamingInside(secList)) {
    secList.innerHTML = nb.sections.map(s => `
      <div class="nb-row ${s.id === sec.id ? "active" : ""}" data-id="${s.id}"
        onclick="switchNotebookSection('${s.id}')" ondblclick="renameOnDoubleClick('sec','${s.id}')">
        <span class="nb-color-bar" style="background:${NB_COLORS[s.color % NB_COLORS.length]}"></span>
        ${rowName("sec", s, "Untitled section")}
        <button class="nb-row-act" title="Rename section" onclick="event.stopPropagation();startNotebookRename('sec','${s.id}')">✎</button>
        ${nb.sections.length > 1 ? `<button class="nb-row-del" title="Delete section" onclick="event.stopPropagation();delNotebookSection('${s.id}')">✕</button>` : ""}
      </div>`).join("");
  }
  if (secList) secList.querySelectorAll(".nb-row").forEach(r => r.classList.toggle("active", r.dataset.id === sec.id));

  /* ---- pages column ---- */
  const page = activeNbPage(sec);
  if (page && sec.activePage !== page.id) sec.activePage = page.id;
  const pageList = document.getElementById("nbPageList");
  if (pageList && !renamingInside(pageList)) {
    pageList.innerHTML = (sec.pages || []).map(p => `
      <div class="nb-row ${page && p.id === page.id ? "active" : ""}" data-id="${p.id}"
        onclick="switchNotebookPage('${p.id}')" ondblclick="renameOnDoubleClick('page','${p.id}')">
        ${rowName("page", p, "Untitled page")}
        <button class="nb-row-act" title="Rename page" onclick="event.stopPropagation();startNotebookRename('page','${p.id}')">✎</button>
        ${sec.pages.length > 1 ? `<button class="nb-row-del" title="Delete page" onclick="event.stopPropagation();delNotebookPage('${p.id}')">✕</button>` : ""}
      </div>`).join("") || `<p class="hint">No pages yet — "+ Add page" starts one.</p>`;
  }
  if (pageList) pageList.querySelectorAll(".nb-row").forEach(r => r.classList.toggle("active", !!page && r.dataset.id === page.id));
  if (nbRenaming) {
    const inp = document.querySelector(".nb-row-input");
    if (inp && document.activeElement !== inp) { inp.focus(); inp.select(); }
    else if (!inp) nbRenaming = null; // the row it belonged to is gone
  }
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
    loadedNbHtml = html;   // this editor wrote it, so it is not an outside change
    loadedNbBaseline = quill.root.innerHTML;
    nbEditorDirty = false; // committed to state — a pull is safe again
    persist(); // rich-text.js already debounced this; rerender() here would destroy the editor mid-edit
  }, () => { nbEditorDirty = true; });
  if (!quill) return;
  quill.root.dataset.placeholder = "Start writing…";
  if (loadedNbPageId === null) {
    loadedNbPageId = page.id;
    loadedNbHtml = page.html || ""; // mountRichEditor just loaded exactly this
    loadedNbBaseline = quill.root.innerHTML;
    return;
  }
  if (loadedNbPageId === page.id) {
    /* Same page still open — but a sync from another device may have
       replaced its text underneath. Without this the editor kept showing
       whatever it was showing before: the phone's edit landed in `state`
       and in the cloud, and the desktop simply never repainted it. Worse,
       the next keystroke here would have saved this stale copy back over
       it. Skipped while an edit of this device's own is still in flight —
       nobody's sentence gets pulled out from under them. */
    if ((page.html || "") !== (loadedNbHtml || "") && !nbEditorDirty) {
      setEditorHtml(quill, page.html);
      loadedNbHtml = page.html || "";
      loadedNbBaseline = quill.root.innerHTML;
    }
    return;
  }
  flushNotebookPage();
  loadedNbPageId = page.id;
  loadedNbHtml = page.html || "";
  // Switching pages loads HTML directly, outside mountRichEditor's own
  // (first-mount-only) path — via the shared helper, which sanitizes and,
  // crucially, does not steal focus. Loading a page is not a request to
  // start typing in it.
  setEditorHtml(quill, page.html);
  loadedNbBaseline = quill.root.innerHTML;
}

/* ---------------- sections ---------------- */
export function addNotebookSection() {
  const nb = ensureNotebook();
  nbRenaming = null;
  flushNotebookPage();
  const pageId = uid();
  const sec = {
    id: uid(), name: "New section", color: nb.sections.length, updatedAt: Date.now(),
    pages: [{ id: pageId, name: "Untitled page", html: "", createdAt: Date.now(), updatedAt: Date.now() }],
    activePage: pageId
  };
  nb.sections.push(sec);
  nb.activeSection = sec.id;
  loadedNbPageId = null; loadedNbHtml = null; loadedNbBaseline = null;
  unmountRichEditor(NB_EDITOR);
  persist();
  /* With a mouse, dropping straight into the rename field is convenient.
     On a touch device it means "+ Add section" summons the keyboard over
     half the screen for a name most people leave alone — so there, the
     section is simply created and ✎ renames it when that's wanted. */
  if (coarsePointer()) renderNotebook();
  else startNotebookRename("sec", sec.id);
}
export function switchNotebookSection(id) {
  const nb = ensureNotebook();
  if (nb.activeSection === id) return; // already open — don't rebuild the list under someone renaming it
  /* Leaving a rename open across navigation was why the keyboard came up
     on a plain tab tap: nbRenaming stayed set, so the row it belonged to
     kept re-rendering as an <input>, and renderNotebook's focus step kept
     putting the cursor back into it on EVERY later render. Moving away is
     the end of that rename. */
  nbRenaming = null;
  flushNotebookPage();
  nb.activeSection = id;
  /* loadedNbPageId is deliberately NOT cleared here. Clearing it told
     renderNotebook "nothing has been loaded into the editor yet", which is
     its signal to leave the editor alone — but the editor is still mounted
     and still showing the PREVIOUS page. The new page then opened holding
     the old page's text, and the first keystroke saved that text into it.
     Leaving the id alone lets renderNotebook see a real page change and do
     the swap properly. */
  persist(false); renderNotebook();
}
export function renameNotebookSection(id, v) {
  const nb = ensureNotebook();
  const sec = nb.sections.find(s => s.id === id);
  if (!sec || !v.trim()) return;
  sec.name = v.trim();
  sec.updatedAt = Date.now(); // the merge needs a per-section signal, not the document's
  persist(); renderNotebook();
}
export function delNotebookSection(id) {
  const nb = ensureNotebook();
  if (nb.sections.length <= 1) return; // a notebook always keeps at least one section
  const sec = nb.sections.find(s => s.id === id);
  if (!sec) return;
  if (!confirm(`Delete the "${sec.name}" section and its ${sec.pages.length} page(s)? You can restore it from Trash within 30 days.`)) return;
  if (loadedNbPageId && sec.pages.some(p => p.id === loadedNbPageId)) { loadedNbPageId = null; loadedNbHtml = null; loadedNbBaseline = null; unmountRichEditor(NB_EDITOR); }
  moveToTrash("notebookSection", sec);
  nb.sections = nb.sections.filter(s => s.id !== id);
  if (nb.activeSection === id) nb.activeSection = nb.sections[0].id;
  persist(); renderNotebook();
}

/* ---------------- pages ---------------- */
export function addNotebookPage() {
  const sec = activeNbSection();
  if (!sec) return;
  nbRenaming = null;
  flushNotebookPage();
  const p = { id: uid(), name: "Untitled page", html: "", createdAt: Date.now(), updatedAt: Date.now() };
  sec.pages.unshift(p);
  sec.activePage = p.id;
  loadedNbPageId = null; loadedNbHtml = null; loadedNbBaseline = null;
  unmountRichEditor(NB_EDITOR);
  persist(); renderNotebook();
  if (!coarsePointer()) {
    const t = document.getElementById("nbPageTitleInput");
    if (t) { t.focus(); t.select(); }
  }
}
export function switchNotebookPage(id) {
  const sec = activeNbSection();
  if (!sec || sec.activePage === id) return;
  nbRenaming = null; // see switchNotebookSection()
  flushNotebookPage();
  sec.activePage = id;
  // Not cleared, for the reason spelled out in switchNotebookSection().
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
    loadedNbPageId = null; loadedNbHtml = null; loadedNbBaseline = null;
    unmountRichEditor(NB_EDITOR);
  }
  moveToTrash("notebookPage", p, { sectionId: sec.id });
  sec.pages = sec.pages.filter(x => x.id !== pid);
  sec.activePage = sec.pages[0].id;
  persist(); renderNotebook();
}
