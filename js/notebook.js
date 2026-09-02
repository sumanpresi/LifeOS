/* Notebook: a OneNote-style space — several named Sections down the left,
   each holding several named Pages, each page a full rich-text document.
   Both section and page names are directly editable (click into the name
   field in the list, or the big title field above the page itself).

   One shared Quill instance backs the currently open page, swapped on
   navigation — the same one-editor-many-documents approach travel.js
   uses for packing-list notes. See flushNotebookPage() for why content is
   read back before the editor's contents are replaced. */
import { state, uid, esc, persist, rerender } from './state.js?v=202609040600';
import { mountRichEditor, unmountRichEditor, getRichEditor, setEditorHtml } from './rich-text.js?v=202609040600';
import { moveToTrash } from './trash.js?v=202609040600';
import { registerBusyCheck } from './ui.js?v=202609040600';

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
/* The section a page belongs to, searched across ALL sections.

   Everything below used to look only inside the ACTIVE section, which was
   fine when the tree could show one section's pages at a time. Now several
   sections can be unfolded at once, so a page you can see and click is
   often not in the selected section — and clicking it did nothing at all,
   because the lookup never found it. */
function findNbSectionOfPage(id) {
  const nb = ensureNotebook();
  return nb.sections.find(sec => (sec.pages || []).some(p => p.id === id)) || null;
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
  /* Renaming used to select the thing being renamed. By the same rule as
     above that is wrong: putting a name on a page in another section is
     not a request to stop editing the one you are in. The row is visible
     in the tree either way, so nothing needs to move. */
  if (kind === "sec") {
    const set = openSectionSet();
    if (!set.has(id)) { set.add(id); saveOpenSections(set); } // keep its pages in view
  }
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
/* Open purely because it is in the set — NOT because it happens to be the
   active section.

   Treating the active section as implicitly open meant it was open while
   absent from the set, and the twisty then had to special-case it: the
   first click on it moved the selection to another section (expanding
   THAT one's pages) and only a second click folded the one actually
   clicked. Which is the bug — the triangle did something other than what
   it points at.

   Selecting a section adds it to the set instead, so "open" has exactly
   one meaning and the twisty is a plain toggle. Folding the section you
   are reading is allowed: the page stays open in the editor, it is just
   no longer listed, which is what folding a tree node means everywhere
   else. */
function isSectionOpen(id) {
  return openSectionSet().has(id);
}
/* A device that has never touched the tree starts with the section it is
   in unfolded, rather than with everything shut. */
function ensureOpenSeed(activeId) {
  try {
    if (activeId && localStorage.getItem(NB_OPEN_KEY) === null) {
      saveOpenSections(new Set([activeId]));
    }
  } catch (_) {}
}
function toggleSectionFold(id) {
  const set = openSectionSet();
  if (set.has(id)) set.delete(id); else set.add(id);
  saveOpenSections(set);
  renderNotebook();
}

/* ONE behaviour for the whole section row, triangle included.

   Splitting them meant the triangle folded without selecting while the
   name selected without folding, so which of the two things happened
   depended on where in the row you landed. Now:

     • a section you are NOT in  → move into it and unfold it
     • the section you ARE in    → fold it, or unfold it again

   So the first click always takes you somewhere, and clicking the same
   section again is what closes it. The triangle does exactly this too —
   it stays as the indicator of open/closed, but it can no longer disagree
   with the row it sits in. */
export function notebookSectionClick(id) {
  /* A SECTION CLICK ONLY FOLDS OR UNFOLDS. It does not move the selection.

     Moving it meant that glancing at another section's contents pulled the
     editor away from the page being written in, and there was no way to
     just look. Opening a page is the deliberate act, so that is what
     changes what you are editing; a section click merely shows or hides
     what is inside it. */
  toggleSectionFold(id);
}
// Kept as the named fold action for anything that wants it directly.
export const toggleNotebookSectionOpen = toggleSectionFold;

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
/* Two keys, because the tree is two different things at the two widths:
   a column you keep, and an overlay you dismiss. Sharing one key meant
   closing the overlay on a folded phone also closed the column when that
   same browser was maximised — and on a desktop there is no control to
   reopen it. Separate keys, so each width remembers its own state. */
const NB_TREE_KEY_WIDE = "lifeos-nb-tree";
const NB_TREE_KEY_NARROW = "lifeos-nb-tree-narrow";
const nbTreeKey = () => (nbNarrow() ? NB_TREE_KEY_NARROW : NB_TREE_KEY_WIDE);
/* Narrow means the tree is an OVERLAY rather than a column, so it must
   start closed there — a panel covering the page on arrival would be the
   opposite of the point. On a wide screen the tree is a column that costs
   little, so it starts open. Same key either way: it is per-device, and a
   phone and a desktop are different devices. */
function nbNarrow() {
  try { return !!(window.matchMedia && window.matchMedia("(max-width:1100px)").matches); }
  catch (_) { return false; }
}
export function isNotebookTreeHidden() {
  try {
    const v = localStorage.getItem(nbTreeKey());
    if (v === null) return nbNarrow(); // never chosen at this width
    return v === "hidden";
  } catch (_) { return false; }
}
export function toggleNotebookTree(force) {
  const hide = typeof force === "boolean" ? force : !isNotebookTreeHidden();
  try { localStorage.setItem(nbTreeKey(), hide ? "hidden" : "shown"); } catch (_) {}
  applyNotebookTreeState();
}
function applyNotebookTreeState() {
  const page = document.getElementById("page-notebook");
  if (page) page.classList.toggle("nb-tree-hidden", isNotebookTreeHidden());
  const hidden = isNotebookTreeHidden();
  const btn = document.getElementById("nbTreeToggle");
  if (btn) {
    btn.setAttribute("aria-label", hidden ? "Show sections" : "Hide sections");
    btn.setAttribute("aria-pressed", hidden ? "true" : "false");
  }
  const chip = document.getElementById("nbSecChip");
  if (chip) chip.setAttribute("aria-expanded", hidden ? "false" : "true");
}

/* Selecting a page from the overlay should get the overlay out of the way
   — you picked a page in order to write in it. Only page selection does
   this: browsing sections keeps the panel up, and renaming must not close
   the panel the rename field is sitting in, which is why this is a
   separate entry point from switchNotebookPage() rather than a change to
   it. */
export function notebookPageClick(id) {
  switchNotebookPage(id);
  if (nbNarrow() && !isNotebookTreeHidden()) toggleNotebookTree(true);
}

export function renderNotebook() {
  const nb = ensureNotebook();
  const sec = activeNbSection();
  if (sec && nb.activeSection !== sec.id) nb.activeSection = sec.id;
  ensureOpenSeed(sec && sec.id);

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
      const open = isSectionOpen(s.id);
      const pages = s.pages || [];
      const pageRows = open ? pages.map(p => `
        <div class="nb-row nb-row-page ${page && p.id === page.id ? "active" : ""}" data-id="${p.id}"
          onclick="notebookPageClick('${p.id}')" ondblclick="renameOnDoubleClick('page','${p.id}')">
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
          onclick="notebookSectionClick('${s.id}')" ondblclick="renameOnDoubleClick('sec','${s.id}')">
          <span class="nb-color-bar" style="background:${NB_COLORS[s.color % NB_COLORS.length]}"></span>
          <button class="nb-twisty ${open ? "is-open" : ""}" aria-expanded="${open}"
            title="${s.id === sec.id ? (open ? "Collapse section" : "Expand section") : "Open section"}"
            onclick="event.stopPropagation();notebookSectionClick('${s.id}')">▶</button>
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
  /* The chip in the top bar names the section you are in, standing in for
     the tree while the tree is closed. */
  const chipName = document.getElementById("nbSecChipName");
  if (chipName) chipName.textContent = sec ? (sec.name || "Untitled section") : "Sections";
  const chipDot = document.getElementById("nbSecDot");
  if (chipDot && sec) chipDot.style.background = NB_COLORS[sec.color % NB_COLORS.length];
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
  /* Selecting a section unfolds it — including when it is already the
     selected one, so tapping the name of a section you folded brings its
     pages back without having to find the triangle. */
  const set = openSectionSet();
  const wasFolded = !set.has(id);
  if (wasFolded) { set.add(id); saveOpenSections(set); }
  if (nb.activeSection === id) {
    if (wasFolded) renderNotebook();
    return; // already selected — don't rebuild the list under someone renaming it
  }
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
  const nb = ensureNotebook();
  const owner = findNbSectionOfPage(id);
  if (!owner) return;
  if (nb.activeSection === owner.id && owner.activePage === id) return;
  nbRenaming = null; // see switchNotebookSection()
  flushNotebookPage();
  owner.activePage = id;
  /* OPENING A PAGE is what moves the selection — including across
     sections. Clicking a section only unfolds it; the selection stays
     with whatever you were writing in until you actually choose a page. */
  if (nb.activeSection !== owner.id) {
    nb.activeSection = owner.id;
    const set = openSectionSet();
    if (!set.has(owner.id)) { set.add(owner.id); saveOpenSections(set); }
  }
  // loadedNbPageId is not cleared — see switchNotebookSection().
  persist(false); renderNotebook();
}
/* Called from the big title field above the page (renames the active
   page) and from a row in the pages list (renames that specific page). */
export function renameNotebookPage(a, b) {
  const v = b === undefined ? a : b;
  let p;
  if (b === undefined) {
    const sec = activeNbSection();          // the big title field: the open page
    if (!sec) return;
    p = sec.pages.find(x => x.id === sec.activePage);
  } else {
    p = findNbPageById(a);                  // a row in the tree, in any section
  }
  if (!p || !v.trim()) return;
  p.name = v.trim();
  p.updatedAt = Date.now();
  persist(); renderNotebook();
}
export function delNotebookPage(id) {
  const active = activeNbSection();
  const pid = id || (active && active.activePage);
  if (!pid) return;
  const sec = findNbSectionOfPage(pid); // may be a section other than the open one
  if (!sec) return;
  if (sec.pages.length <= 1) return; // a section always keeps at least one page
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
