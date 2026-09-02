/* Generic life-space pages: Communication, Finance, Health, Travel, Reference.
   (Work has a dedicated GSI page in gsi.js.) */
import { state, uid, esc, persist, rerender, onStateReplaced, SECTION_META } from './state.js?v=202609040400';
import { toast } from './ui.js?v=202609040400';
import { moveToTrash } from './trash.js?v=202609040400';
import { mountRichEditor, unmountRichEditor, getRichEditor } from './rich-text.js?v=202609040400';
import { attachNoteInk, detachNoteInk, noteHasInk } from './note-ink.js?v=202609040400';

export function buildSectionPages() {
  document.getElementById("sectionPages").innerHTML =
    Object.entries(SECTION_META).map(([key, label]) => `
    <section class="page" id="page-${key}">
      <h1 class="display" style="font-size:28px;margin-bottom:14px">${label}</h1>
      <div class="grid-2">
        <div class="card"><div class="card-head"><h2>Notes</h2>
            <button class="btn btn-ghost sec-note-add" onclick="addSectionNote('${key}')">+ New note</button>
          </div>
          <div class="card-body">
            <div class="sec-notes" id="secNotes-${key}"></div>
          </div>
        </div>
        <div class="card"><div class="card-head"><h2>Links</h2></div>
          <div class="card-body">
            <div class="link-grid" id="secLinks-${key}" style="grid-template-columns:1fr"></div>
            <div class="add-inline">
              <input type="text" id="secLinkTitle-${key}" placeholder="Title">
              <input type="text" id="secLinkUrl-${key}" placeholder="https://…">
              <button class="btn btn-ghost" onclick="addSectionLink('${key}')">Add</button>
            </div>
          </div>
        </div>
      </div>
    </section>`).join("");
}

/* ---------- Notes: a list of individually-titled rich-text notes ----------
   Each note is a collapsible card with its own Quill editor (rich-text.js),
   mirroring how meeting minutes work in gsi.js. Only expanded notes carry a
   live editor, so a section with twenty notes doesn't pay for twenty
   instances. */
function noteList(key) {
  const sec = state.sections[key];
  if (!sec) return null;
  if (!Array.isArray(sec.noteList)) sec.noteList = [];
  return sec.noteList;
}
function noteEditorId(key, id) { return `secnote-${key}-${id}`; }
function noteById(key, id) { return (noteList(key) || []).find(x => x.id === id) || null; }

/* Cheap 32-bit content fingerprint. Only needs to change when the text
   changes — it is a cache key, not a checksum. */
function hash(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}

/* Set while a render pass is reacting to state that arrived from another
   device, so the read-back above knows not to overwrite it. */
let remoteJustArrived = false;
onStateReplaced(() => {
  remoteJustArrived = true;
  // Force the next pass to re-evaluate rather than trust a stale cache key.
  document.querySelectorAll(".sec-notes").forEach(box => delete box.dataset.sig);
});
/* Full screen for a single note.

   Implemented by toggling a class on the note's own element rather than
   moving it into a modal: Quill holds live references to its DOM, so
   relocating a mounted editor tears down its selection and undo history.
   A fixed-position class keeps the same element exactly where it is in
   the tree and only changes how it is painted. */
export function toggleNoteFullscreen(btn) {
  const note = btn.closest(".sec-note");
  if (!note) return;
  const on = note.classList.toggle("note-fullscreen");
  document.body.classList.toggle("note-fullscreen-open", on);
  btn.textContent = on ? "⤡" : "⤢";
  btn.title = on ? "Exit full screen (Esc)" : "Full screen (Esc to exit)";

  if (on) { note.querySelector(".ql-editor")?.focus(); return; }

  /* Coming back OUT, rebuild the note rather than trusting the classes to
     unwind cleanly.

     Going full screen changes the element from a block in a column into a
     fixed-position flex container, and Quill measures and caches layout as
     it goes. Removing the classes restores the CSS but not whatever the
     editor worked out while it was in the other shape — which left the
     toolbar clipped and the page collapsed to a strip.

     renderSectionNotes reads each editor's content back before it unmounts,
     so nothing typed is lost; it is the same path a normal re-render takes.
     Deferred a frame so the class removal has been painted first. */
  const box = note.closest("[id^='secNotes-']");
  const key = box?.id.replace("secNotes-", "");
  if (!key) return;
  /* renderSectionNotes skips work when its cache key is unchanged — and
     leaving full screen changes only the layout, never the content, so the
     key is identical and the rebuild would be skipped precisely when it is
     needed. Clearing the key forces the pass to run. */
  delete box.dataset.sig;
  /* The caret is normally still inside the editor on the way out, and
     renderSectionNotes deliberately defers a rebuild while someone is
     typing — so without dropping focus first, the rebuild would be
     postponed until the next click and the broken layout would persist
     until then. Blurring commits the content through the editor's own
     change handler, exactly as clicking away would. */
  if (box.contains(document.activeElement)) document.activeElement.blur();
  requestAnimationFrame(() => renderSectionNotes(key, { force: true }));
}

/* Esc is what people reach for, and there is no browser chrome here to
   offer a way out. Attached once, at module load. */
document.addEventListener("keydown", evt => {
  if (evt.key !== "Escape") return;
  const open = document.querySelector(".sec-note.note-fullscreen");
  if (!open) return;
  evt.preventDefault();
  open.querySelector(".sec-note-full")?.click();
});

export function renderSectionNotes(key, opts = {}) {
  const box = document.getElementById("secNotes-" + key);
  const list = noteList(key);
  if (!box || !list) return;

  /* Notes behave like tabs: exactly one is ever "open" (active) at a time,
     shown in a single content area below a row of tab buttons, instead of
     every open note stacking full-height cards down the page. Older data
     (or a state merge from another device) can still carry more than one
     note flagged open — collapse down to the most recently touched one so
     the tab bar has a single active tab. */
  const openOnes = list.filter(n => n.open);
  if (openOnes.length > 1) {
    const keep = openOnes.reduce((a, b) => (b.updated || 0) > (a.updated || 0) ? b : a);
    openOnes.forEach(n => { if (n !== keep) n.open = false; });
  } else if (openOnes.length === 0 && list.length) {
    list[0].open = true;
  }

  /* Quill lives in a real DOM node, so rebuilding this container under a
     mounted editor would silently orphan it — and renderAll() reaches here
     on every unrelated state change. Rebuild only when what's on screen
     actually differs; otherwise leave the DOM (and the cursor) alone.

     The signature includes a hash of each note's BODY, not just its id and
     open/closed state. It used to cover only id+open, which meant a note
     whose text had been rewritten on another device produced an identical
     signature — so this returned early, the editor was never re-read, and
     the screen kept showing the local copy indefinitely. The sync had in
     fact succeeded; only the UI never caught up. That is why two devices
     could both report "Synced" while displaying different text.

     Tab titles are always on screen now (in the tab bar), not just for the
     open note, so the signature has to include every title, not only the
     active note's body. */
  const signature = list.map(n => `${n.id}:${n.open ? 1 : 0}:${hash(n.title)}:${hash(n.html)}`).join(",");
  if (!opts.force && box.dataset.sig === signature) return;

  /* Never yank the DOM out from under someone mid-sentence — but ONLY for
     a passive rebuild (a background sync tick, another module's render
     pass). An explicit action the user just took in THIS box — clicking a
     tab, hitting "+ New note", deleting a note — is opts.force, and must
     always take effect immediately.

     Without that distinction, clicking a tab was itself the problem:
     click focuses the clicked button before its onclick handler runs, so
     by the time selectSectionNote() called back in here, the tab button
     was already document.activeElement and *inside* this box — the guard
     read that as "the user is mid-edit" and silently deferred the switch
     until a later focusout. The tab's `open` flag in state was already
     correct; only the visible editor never caught up, which is exactly
     what looked like "clicking a tab does nothing". */
  if (!opts.force && box.contains(document.activeElement) && document.activeElement !== document.body) {
    if (!box.dataset.deferred) {
      box.dataset.deferred = "1";
      box.addEventListener("focusout", () => {
        delete box.dataset.deferred;
        setTimeout(() => renderSectionNotes(key), 0); // after focus settles
      }, { once: true });
    }
    return;
  }
  delete box.dataset.deferred; // a forced render (or one with no focus inside it) makes any pending deferral moot

  /* A rebuild is happening, so every live editor is about to be thrown
     away. Quill's change handler is debounced — an edit from the last half
     second may not have reached state yet — so read each editor back
     before it goes, or that edit is simply lost.

     Except when the rebuild was triggered by state arriving from another
     device. In that case `list` is already the incoming version, and
     copying the local editor over it would overwrite the newer text with
     the stale text this rebuild exists to replace. */
  if (!remoteJustArrived) {
    list.forEach(n => {
      const q = getRichEditor(noteEditorId(key, n.id));
      if (q) n.html = q.root.innerHTML;
    });
  }
  list.forEach(n => unmountRichEditor(noteEditorId(key, n.id)));
  // The ink canvas points at DOM nodes this rebuild is about to discard.
  box.querySelectorAll(".sec-note").forEach(detachNoteInk);
  box.dataset.sig = signature;

  const active = list.find(n => n.open) || null;

  const tabBar = list.length ? `<div class="sec-notes-tabbar">
    ${list.map(n => `
      <button type="button" class="sec-note-tab ${n.id === active?.id ? "active" : ""}"
        onclick="selectSectionNote('${key}','${n.id}')" title="${esc(n.title || "Untitled note")}">
        <span class="sec-note-tab-title">${esc(n.title || "Untitled note")}</span>
        <span class="sec-note-tab-close" onclick="event.stopPropagation();delSectionNote('${key}','${n.id}')"
          title="Delete note">✕</span>
      </button>`).join("")}
  </div>` : "";

  const activeCard = active ? `
    <div class="sec-note open">
      <div class="sec-note-head">
        <input type="text" class="sec-note-title" value="${esc(active.title || "")}" placeholder="Untitled note"
          onchange="editSectionNoteTitle('${key}','${active.id}',this.value)">
        <button class="sec-note-full" onclick="toggleNoteFullscreen(this)"
          title="Full screen (Esc to exit)" aria-label="Full screen">⤢</button>
      </div>
      <div class="sec-note-body">
        <div id="${noteEditorId(key, active.id)}" class="mm-rich-editor sec-note-editor"></div>
      </div>
    </div>` : `<p class="hint">No notes yet — "+ New note" starts one.</p>`;

  box.innerHTML = tabBar + activeCard;

  list.filter(n => n.open).forEach(n => {
    /* Resolved by id on every read and every write, never captured.
       Capturing `n` meant that once a sync replaced state — merge() builds
       an entirely new object graph — the editor still held a pointer to
       the old, detached note. Typing then wrote into an orphan, persist()
       saved a state that never contained the edit, and the words vanished
       with no error anywhere. */
    const nid = n.id;
    mountRichEditor(noteEditorId(key, nid),
      () => (noteById(key, nid)?.html) || "",
      html => {
        const live = noteById(key, nid);
        if (!live) return; // deleted on another device mid-edit
        live.html = html;
        live.updated = Date.now();
        persist(); // rich-text.js already debounced this; rerender() here would destroy the editor mid-edit
      });

    /* The ink layer sits over the mounted editor and reads its strokes
       from state by id on every draw — never from a captured note object,
       for the same reason the editor above resolves by id: a sync
       replaces the whole object graph, and a captured reference would
       quietly become an orphan that saves nowhere. */
    const noteEl = box.querySelector(".sec-note");
    if (noteEl) {
      if (noteHasInk(noteById(key, nid))) noteEl.classList.add("has-ink");
      attachNoteInk(noteEl, () => noteById(key, nid));
    }
  });
}

export function addSectionNote(key) {
  const list = noteList(key);
  if (!list) return;
  list.forEach(n => { n.open = false; }); // only the new tab should be active
  const note = { id: uid(), title: "", html: "", open: true, updated: Date.now() };
  list.push(note); // appended after existing notes — a new tab lands beside the old ones, not stacked on top
  persist();
  renderSectionNotes(key, { force: true }); // explicit user action — must switch immediately, not wait on the typing guard
  document.querySelector(`#secNotes-${key} .sec-note-title`)?.focus();
}
/* Switches which note's tab is active. Notes behave like browser tabs: only
   one is ever open, so selecting one closes whichever was open before it —
   renderSectionNotes reads that note's editor back before unmounting it.
   Forced, because clicking a tab focuses the tab button first (browsers
   focus a clicked button before its onclick fires), which would otherwise
   make renderSectionNotes think someone is still mid-edit and defer the
   switch indefinitely. */
export function selectSectionNote(key, id) {
  const list = noteList(key);
  if (!list) return;
  const n = list.find(x => x.id === id);
  if (!n || n.open) return; // already the active tab — nothing to do
  list.forEach(x => { x.open = (x.id === id); });
  persist(false);
  renderSectionNotes(key, { force: true });
}
export function editSectionNoteTitle(key, id, v) {
  const n = (noteList(key) || []).find(x => x.id === id);
  if (!n) return;
  n.title = v.trim();
  n.updated = Date.now();
  persist();
  // The tab label is a separate element from this input, so it needs an
  // explicit (forced) render to pick up the rename — otherwise the tab
  // still shows the old title until some unrelated render pass touches it.
  renderSectionNotes(key, { force: true });
}
export function delSectionNote(key, id) {
  const list = noteList(key);
  const n = (list || []).find(x => x.id === id);
  if (!n) return;
  if (!confirm(`Delete "${n.title || "Untitled note"}"? You can restore it from Trash within 30 days.`)) return;
  // Trash keeps a snapshot, so it must hold the latest text, including
  // anything still sitting in the editor's debounce window.
  const q = getRichEditor(noteEditorId(key, id));
  if (q) n.html = q.root.innerHTML;
  unmountRichEditor(noteEditorId(key, id));
  moveToTrash("sectionNote", n, { sectionKey: key });
  const idx = list.findIndex(x => x.id === id);
  const remaining = list.filter(x => x.id !== id);
  // Deleting the active tab should hand activeness to a neighboring tab
  // (preferring the one that slides into its old spot) instead of leaving
  // no tab open.
  if (n.open && remaining.length) remaining[Math.min(idx, remaining.length - 1)].open = true;
  state.sections[key].noteList = remaining;
  persist();
  renderSectionNotes(key, { force: true }); // explicit action — swap the tab bar/editor immediately
  rerender(); // also refreshes Trash and anything else watching this state
}

/* Pages hand-written in index.html rather than generated from SECTION_META,
   whose Notes cards nevertheless use this module's editor. A key with a
   #secNotes-<key> container must appear here or it silently never renders —
   the container simply stays empty forever, which is exactly what happened
   to Personal's Notes card until this list existed. */
export const NOTE_SECTIONS = ["work", "personal", "health", "finance"];

/* Links are deliberately NOT rendered for every key above. Health and
   Finance own their links in state.health.links / state.finance.links and
   render them from health.js / finance.js — pointing this loop at
   #secLinks-health as well would have a second renderer overwrite the real
   links with "No links yet" from the empty state.sections copy. Personal's
   links live under #pwLinks and are drawn by personal.js. So only the
   generated SECTION_META pages and Work read their links from here. */
const LINK_SECTIONS = () => [...Object.keys(SECTION_META), "work"];

export function renderSections() {
  for (const key of new Set([...Object.keys(SECTION_META), ...NOTE_SECTIONS])) {
    renderSectionNotes(key);
  }
  remoteJustArrived = false;
  for (const key of LINK_SECTIONS()) {
    const g = document.getElementById("secLinks-" + key);
    if (!g || !state.sections[key]) continue;
    g.innerHTML = (state.sections[key].links || []).map(l => `
      <div class="link-card">
        <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
        <button class="del" onclick="delSectionLink('${key}','${l.id}')">✕</button>
      </div>`).join("") || `<p class="hint">No links yet.</p>`;
  }
}
export function addSectionLink(key) {
  const t = document.getElementById("secLinkTitle-" + key), u = document.getElementById("secLinkUrl-" + key);
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.sections[key].links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delSectionLink(key, id) {
  const l = (state.sections[key].links || []).find(x => x.id === id);
  if (l) moveToTrash("sectionLink", l, { sectionKey: key });
  state.sections[key].links = state.sections[key].links.filter(x => x.id !== id);
  persist(); rerender();
}
