/* Generic life-space pages: Communication, Finance, Health, Travel, Reference.
   (Work has a dedicated GSI page in gsi.js.) */
import { state, uid, esc, persist, rerender, SECTION_META } from './state.js';
import { toast } from './ui.js';
import { moveToTrash } from './trash.js';
import { mountRichEditor, unmountRichEditor, getRichEditor } from './rich-text.js';

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
function notePreview(html) {
  const text = String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 90) + (text.length > 90 ? "…" : "") : "Empty note";
}

export function renderSectionNotes(key) {
  const box = document.getElementById("secNotes-" + key);
  const list = noteList(key);
  if (!box || !list) return;

  /* Quill lives in a real DOM node, so rebuilding this container under a
     mounted editor would silently orphan it — and renderAll() reaches
     here on every unrelated state change. Rebuild only when the set of
     notes or their expanded/collapsed state actually differs from what's
     on screen; otherwise leave the DOM (and the cursor) alone. */
  const signature = list.map(n => `${n.id}:${n.open ? 1 : 0}`).join(",");
  if (box.dataset.sig === signature) return;
  /* A rebuild is happening, so every live editor is about to be thrown
     away. Quill's change handler is debounced — an edit from the last
     half-second may not have reached state yet — so read each editor
     back before it goes, or that edit is simply lost. */
  list.forEach(n => {
    const q = getRichEditor(noteEditorId(key, n.id));
    if (q) n.html = q.root.innerHTML;
    unmountRichEditor(noteEditorId(key, n.id));
  });
  box.dataset.sig = signature;

  box.innerHTML = list.map(n => `
    <div class="sec-note ${n.open ? "open" : ""}">
      <div class="sec-note-head">
        <button class="sec-note-toggle" onclick="toggleSectionNoteOpen('${key}','${n.id}')"
          title="${n.open ? "Collapse" : "Expand"}">${n.open ? "▾" : "▸"}</button>
        <input type="text" class="sec-note-title" value="${esc(n.title || "")}" placeholder="Untitled note"
          onchange="editSectionNoteTitle('${key}','${n.id}',this.value)">
        ${n.open ? "" : `<span class="sec-note-preview">${esc(notePreview(n.html))}</span>`}
        <button class="del sec-note-del" onclick="delSectionNote('${key}','${n.id}')" title="Delete note">✕</button>
      </div>
      ${n.open ? `<div class="sec-note-body">
        <div id="${noteEditorId(key, n.id)}" class="mm-rich-editor sec-note-editor"></div>
      </div>` : ""}
    </div>`).join("") || `<p class="hint">No notes yet — "+ New note" starts one.</p>`;

  list.filter(n => n.open).forEach(n => {
    mountRichEditor(noteEditorId(key, n.id), () => n.html || "", html => {
      n.html = html;
      n.updated = Date.now();
      persist(); // rich-text.js already debounced this; rerender() here would destroy the editor mid-edit
    });
  });
}

export function addSectionNote(key) {
  const list = noteList(key);
  if (!list) return;
  const note = { id: uid(), title: "", html: "", open: true, updated: Date.now() };
  list.unshift(note); // newest first — a new note shouldn't be a scroll away
  persist();
  renderSectionNotes(key);
  document.querySelector(`#secNotes-${key} .sec-note-title`)?.focus();
}
export function toggleSectionNoteOpen(key, id) {
  const n = (noteList(key) || []).find(x => x.id === id);
  if (!n) return;
  n.open = !n.open; // renderSectionNotes reads the editor back before unmounting it

  persist(false);
  renderSectionNotes(key);
}
export function editSectionNoteTitle(key, id, v) {
  const n = (noteList(key) || []).find(x => x.id === id);
  if (!n) return;
  n.title = v.trim();
  n.updated = Date.now();
  persist();
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
  state.sections[key].noteList = list.filter(x => x.id !== id);
  persist(); rerender();
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
