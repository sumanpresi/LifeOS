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

/* ---- which sections are unfolded ----
   Per-device in localStorage, like every other view preference here: it
   describes one screen's shape, not the notebook's contents, so it has no
   business syncing or bumping the document rev. The section you are in is
   always treated as open — collapsing the one you are reading would hide
   the page you are looking at. */
const NB_OPEN_KEY = "lifeos-nb-open";
function openSectionSet() {
  try { return new Set(JSON.parse(localStorage.getItem(NB_OPEN_KEY) || "[]")); }
  catch (_) { return new Set(); }
}
function saveOpenSections(set) {
  try { localStorage.setItem(NB_OPEN_KEY, JSON.stringify([...set])); } catch (_) {}
}
function isSectionOpen(id, activeId) {
  return id === activeId || openSectionSet().has(id);
}
export function toggleNotebookSectionOpen(id) {
  const sec = activeNbSection();
  const set = openSectionSet();
  /* Folding the active section would leave its open page invisible in the
     tree, so folding it moves the selection out of it first — to the next
     section along, which is what the person is evidently heading for. */
  if (sec && sec.id === id && !set.has(id)) {
    const nb = ensureNotebook();
    const other = nb.sections.find(x => x.id !== id);
    if (other) { set.delete(id); saveOpenSections(set); switchNotebookSection(other.id); return; }
  }
  if (set.has(id)) set.delete(id); else set.add(id);
  saveOpenSections(set);
  renderNotebook();
}

/* Adding a page to a named section, rather than to "whichever section the
   header happens to be showing". Switches to that section first so the new
   page opens where it was asked for. */
export function addNotebookPageTo(sectionId) {
  const nb = ensureNotebook();
  if (nb.activeSection !== sectionId && nb.sections.some(s => s.id === sectionId)) {
    const set = openSectionSet(); set.add(sectionId); saveOpenSections(set);
    switchNotebookSection(sectionId);
  }
  addNotebookPage();
}

/* On a narrow screen the tree and the editor cannot both have the room
   they want, so the tree folds away and the editor takes the width. */
const NB_TREE_KEY = "lifeos-nb-tree";
export function isNotebookTreeHidden() {
  try { return localStorage.getItem(NB_TREE_KEY) === "hidden"; } catch (_) { return false; }
}
export function toggleNotebookTree(force) {
  const hide = typeof force === "boolean" ? force : !isNotebookTreeHidden();
  try { localStorage.setItem(NB_TREE_KEY, hide ? "hidden" : "shown"); } catch (_) {}
  applyNotebookTreeState();
}
function applyNotebookTreeState() {
  const page = document.getElementById("page-notebook");
  if (page) page.classList.toggle("nb-tree-hidden", isNotebookTreeHidden());
  const btn = document.getElementById("nbTreeToggle");
  if (btn) {
    const hidden = isNotebookTreeHidden();
    btn.setAttribute("aria-label", hidden ? "Show sections" : "Hide sections");
    btn.setAttribute("aria-pressed", hidden ? "true" : "false");
  }
}

export function renderNotebook() {
  const nb = ensureNotebook();
  const sec = activeNbSection();
  if (sec && nb.activeSection !== sec.id) nb.activeSection = sec.id;

  /* ---- one tree, sections with their pages nested ----

     This replaced two side-by-side columns. Two columns spent roughly
     420px of width permanently on lists that are mostly empty space, and
     the pages column could only ever show one section's pages, so the
     relationship between a page and its section was implied by which
     column it sat in rather than shown. A tree costs one column, shows
     that relationship directly, and hands the difference to the editor —
     which is the part actually being used. */
  const page = activeNbPage(sec);
  if (page && sec.activePage !== page.id) sec.activePage = page.id;

  const secList = document.getElementById("nbSectionList");
  /* The rebuild is skipped while a rename input inside it has focus, so
     the field isn't yanked out from under the cursor. Selecting a row
     doesn't put focus in here (rows are plain tap targets), so `.active`
     is reconciled separately below against `data-id`. */
  if (secList && !renamingInside(secList)) {
    secList.innerHTML = nb.sections.map(s => {
      const open = isSectionOpen(s.id, sec.id);
      const pages = s.pages || [];
      const pageRows = open ? pages.map(p => `
        <div class="nb-row nb-row-page ${page && p.id === page.id ? "active" : ""}" data-id="${p.id}"
          onclick="switchNotebookPage('${p.id}')" ondblclick="renameOnDoubleClick('page','${p.id}')">
          ${rowName("page", p, "Untitled page")}
          <button class="nb-row-act" title="Rename page" onclick="event.stopPropagation();startNotebookRename('page','${p.id}')">✎</button>
          ${pages.length > 1 ? `<button class="nb-row-del" title="Delete page" onclick="event.stopPropagation();delNotebookPage('${p.id}')">✕</button>` : ""}
        </div>`).join("") : "";
      /* "+ Add page" belongs to the section it adds to, so it lives inside
         that section rather than in a header that had to name which
         section it meant. */
      const addRow = open
        ? `<button class="nb-add-page-row" onclick="event.stopPropagation();addNotebookPageTo('${s.id}')">+ Add page</button>`
        : "";
      return `
      <div class="nb-sec" data-sec="${s.id}">
        <div class="nb-row nb-row-sec ${s.id === sec.id ? "active" : ""}" data-id="${s.id}"
          onclick="switchNotebookSection('${s.id}')" ondblclick="renameOnDoubleClick('sec','${s.id}')">
          <span class="nb-color-bar" style="background:${NB_COLORS[s.color % NB_COLORS.length]}"></span>
          <button class="nb-twisty ${open ? "is-open" : ""}" aria-expanded="${open}"
            title="${open ? "Collapse" : "Expand"} section"
            onclick="event.stopPropagation();toggleNotebookSectionOpen('${s.id}')">▶</button>
          ${rowName("sec", s, "Untitled section")}
          <button class="nb-row-act" title="Rename section" onclick="event.stopPropagation();startNotebookRename('sec','${s.id}')">✎</button>
          ${nb.sections.length > 1 ? `<button class="nb-row-del" title="Delete section" onclick="event.stopPropagation();delNotebookSection('${s.id}')">✕</button>` : ""}
        </div>
        ${open ? `<div class="nb-sec-pages">${pageRows}${addRow}</div>` : ""}
      </div>`;
    }).join("");
  }
  if (secList) {
    secList.querySelectorAll(".nb-row-sec").forEach(r => r.classList.toggle("active", r.dataset.id === sec.id));
    secList.querySelectorAll(".nb-row-page").forEach(r => r.classList.toggle("active", !!page && r.dataset.id === page.id));
  }
  if (nbRenaming) {
    const inp = document.querySelector(".nb-row-input");
    if (inp && document.activeElement !== inp) { inp.focus(); inp.select(); }
    else if (!inp) nbRenaming = null; // the row it belonged to is gone
  }
  applyNotebookTreeState();
  /* The editor now says which section the open page belongs to, since
     there is no longer a column header doing that. */
  const crumb = document.getElementById("nbCrumb");
  if (crumb) crumb.textContent = sec ? sec.name : "";

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
