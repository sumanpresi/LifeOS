/* Entertainment — a personal catalogue of books, music and video.

   The controls are deliberately limited to five: type, status, tags, sort
   and search, plus a density toggle. Every extra filter costs attention
   permanently and gets used rarely; anything that can't earn a place on
   the toolbar belongs in search instead.

   Two choices worth stating, because both look like omissions:

   NO PAGINATION. Page numbers hide a personal collection behind
   navigation and break the browser's own find-on-page. Filtering and
   sorting are what make a long list usable; splitting it into pages only
   makes it shorter to look at, not easier to search. Long results are
   capped and extended on demand instead.

   STATUS BEFORE TAGS. The question actually asked of a catalogue is
   "what should I read next", not "what is science fiction". Status also
   changes over time, which keeps the page current rather than archival. */

import { state, uid, esc, persist, rerender } from './state.js?v=202609042200';
import { toast } from './ui.js?v=202609042200';
import { moveToTrash } from './trash.js?v=202609042200';
import { getLinkPreview } from './link-preview.js?v=202609042200';

const TYPES = [
  ["book", "Books", "\u{1F4D6}"],
  ["music", "Music", "\u{1F3B5}"],
  ["video", "Video", "\u{1F3AC}"],
];
const TYPE_LABEL = Object.fromEntries(TYPES.map(([k, l]) => [k, l]));
const STATUSES = [["want", "Want to"], ["doing", "In progress"], ["done", "Finished"]];

/* Results are capped and extended on demand rather than paginated. Below
   this many matches the cap never comes into play, so a normal-sized
   catalogue pays nothing for it. */
const PAGE_SIZE = 60;

let filterType = "all";
let filterStatus = "all";
let selectedTags = new Set();   // multi-select: something can be Sci-Fi *and* Re-read
let searchQuery = "";
let sortMode = "added";
let viewMode = "grid";
let renderLimit = PAGE_SIZE;
let archivePanelOpen = false;   // declared with the other view state, above every use of it

function ent() {
  if (!state.entertainment || typeof state.entertainment !== "object") state.entertainment = { items: [] };
  if (!Array.isArray(state.entertainment.items)) state.entertainment.items = [];
  return state.entertainment;
}
const itemTags = it => (Array.isArray(it.tags) ? it.tags : []);
/* Archived entries stay in the catalogue but out of the way — off the
   shelf, out of the tag counts, out of the totals. They are not deleted
   and never enter Trash, which is the whole point of having both. */
const liveItems = () => ent().items.filter(it => !it.archived);
const archivedItems = () => ent().items.filter(it => it.archived);
const q1 = s => String(s).replace(/'/g, "\\'"); // safe inside a single-quoted inline handler

/* Every tag in use, with its count, most-used first. Matching is
   case-insensitive and the first spelling seen wins, so "Sci-Fi" and
   "sci-fi" collapse into one filter instead of splitting the shelf in
   two — the failure that makes a tag list useless within a year. */
function allTags(scope = "all") {
  /* Scoped to the section being browsed. A single shared tag list mixes
     #History from a documentary in with #History from a book, and shows
     tags that can't match anything while Video is selected — a filter
     that returns nothing is worse than no filter. Passing "all" gives the
     whole catalogue, which is what the add-form's suggestions want, since
     reusing a spelling across sections is exactly what keeps them tidy. */
  const seen = new Map(); // lowercase -> {label, count}
  liveItems()
    .filter(it => scope === "all" || it.type === scope)
    .forEach(it => itemTags(it).forEach(t => {
      const key = String(t).toLowerCase();
      if (seen.has(key)) seen.get(key).count++;
      else seen.set(key, { label: t, count: 1 });
    }));
  return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
// Reuses an existing spelling when the tag already exists in another case.
function canonicalTag(raw) {
  const t = String(raw).trim();
  if (!t) return "";
  // Deliberately over the whole catalogue, archived included: a spelling
  // shouldn't be forgotten just because the only entry using it is filed away.
  const seen = new Map();
  ent().items.forEach(it => itemTags(it).forEach(x => seen.set(x.toLowerCase(), x)));
  const match = [...seen.values()].map(label => ({ label })).find(x => x.label.toLowerCase() === t.toLowerCase());
  return match ? match.label : t;
}
function parseTags(raw) {
  return [...new Set(String(raw || "").split(",").map(canonicalTag).filter(Boolean))];
}

const filtersActive = () =>
  filterType !== "all" || filterStatus !== "all" || selectedTags.size > 0 || searchQuery.trim() !== "";

function matchingItems() {
  const q = searchQuery.trim().toLowerCase();
  const wanted = [...selectedTags].map(t => t.toLowerCase());
  return liveItems().filter(it => {
    if (filterType !== "all" && it.type !== filterType) return false;
    if (filterStatus !== "all" && (it.status || "want") !== filterStatus) return false;
    /* Several tags selected means "has all of them" — narrowing. Reading
       it as "any of them" would widen the results as you click more,
       which is the opposite of what picking another filter should do. */
    if (wanted.length) {
      const mine = itemTags(it).map(t => String(t).toLowerCase());
      if (!wanted.every(t => mine.includes(t))) return false;
    }
    if (!q) return true;
    return [it.title, it.creator, it.note, ...itemTags(it), TYPE_LABEL[it.type]]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}

function sortItems(list) {
  const copy = [...list];
  if (sortMode === "rating") return copy.sort((a, b) => (b.rating || 0) - (a.rating || 0) || (b.addedAt || 0) - (a.addedAt || 0));
  if (sortMode === "title") return copy.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return copy.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)); // newest first
}

function starsHtml(rating, id) {
  return `<span class="ent-stars">${[1, 2, 3, 4, 5].map(n =>
    `<button class="ent-star ${n <= (rating || 0) ? "on" : ""}" onclick="rateEntertainment('${id}',${n})"
       title="${n === rating ? "Clear rating" : n + " star" + (n === 1 ? "" : "s")}">\u2605</button>`).join("")}</span>`;
}
function tagChipsHtml(it) {
  return itemTags(it).map(t =>
    `<button class="ent-tag" onclick="toggleEntertainmentTag('${esc(q1(t))}')" title="Filter by ${esc(t)}">${esc(t)}</button>`).join("");
}
function statusSelect(it) {
  const s = it.status || "want";
  return `<select class="ent-status ent-status-${s}" onchange="setEntertainmentStatus('${it.id}',this.value)" title="Status">
    ${STATUSES.map(([k, l]) => `<option value="${k}" ${k === s ? "selected" : ""}>${l}</option>`).join("")}</select>`;
}

function cardHtml(it) {
  const host = (() => { try { return it.url ? new URL(it.url).hostname.replace(/^www\./, "") : ""; } catch (e) { return ""; } })();
  return `
  <article class="ent-card" data-ent-id="${it.id}">
    <div class="ent-card-head">
      <span class="ent-type">${TYPES.find(t => t[0] === it.type)?.[2] || ""} ${esc(TYPE_LABEL[it.type] || it.type)}</span>
      ${statusSelect(it)}
      <button class="ent-focus-btn ${it.featured ? "on" : ""}" onclick="toggleEntertainmentFocus('${it.id}')"
        title="${it.featured ? "Remove from Current focus" : "Set as Current focus"}">\u25C9</button>
      <button class="ent-edit-btn" onclick="openEntertainmentEdit('${it.id}')" title="Edit this entry">\u270E</button>
      <button class="ent-edit-btn" onclick="archiveEntertainment('${it.id}')" title="Archive \u2014 keeps it, just hides it">\uD83D\uDDC4</button>
      <button class="del" onclick="delEntertainment('${it.id}')" title="Delete">\u2715</button>
    </div>
    <h4 class="ent-title">${esc(it.title)}</h4>
    ${it.creator ? `<p class="ent-creator">${esc(it.creator)}</p>` : ""}
    ${it.note ? `<p class="ent-note">${esc(it.note)}</p>` : ""}
    ${itemTags(it).length ? `<div class="ent-tags">${tagChipsHtml(it)}</div>` : ""}
    <div class="ent-card-foot">
      ${starsHtml(it.rating, it.id)}
      ${it.url ? `<span class="link-row ent-link"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(host || "Open")} \u2192</a></span>` : ""}
    </div>
  </article>`;
}

/* One line per entry. Past roughly forty items the artwork grid stops
   being a browsing aid and becomes a wall — this is what gets used for
   scanning a real collection. */
function rowHtml(it) {
  return `
  <div class="ent-row" data-ent-id="${it.id}">
    <span class="ent-row-type" title="${esc(TYPE_LABEL[it.type] || "")}">${TYPES.find(t => t[0] === it.type)?.[2] || ""}</span>
    <span class="ent-row-main">
      <span class="ent-row-title">${esc(it.title)}</span>
      ${it.creator ? `<span class="ent-row-creator">${esc(it.creator)}</span>` : ""}
    </span>
    <span class="ent-row-tags">${tagChipsHtml(it)}</span>
    ${statusSelect(it)}
    ${starsHtml(it.rating, it.id)}
    ${it.url ? `<a class="ent-row-link" href="${esc(it.url)}" target="_blank" rel="noopener" title="Open">\u2197</a>` : `<span class="ent-row-link"></span>`}
    <button class="ent-edit-btn" onclick="openEntertainmentEdit('${it.id}')" title="Edit this entry">\u270E</button>
    <button class="ent-edit-btn" onclick="archiveEntertainment('${it.id}')" title="Archive">\uD83D\uDDC4</button>
    <button class="del" onclick="delEntertainment('${it.id}')" title="Delete">\u2715</button>
  </div>`;
}

function focusHtml(it) {
  if (!it) return `<p class="hint" style="margin:0">Nothing set as Current focus. Use the \u25C9 on any entry to pin what you're reading or watching right now.</p>`;
  const pct = Number(it.progress) > 0 ? Math.min(100, Number(it.progress)) : 0;
  return `
    <div class="ent-focus-art" id="entFocusArt"></div>
    <div class="ent-focus-body">
      <span class="ent-focus-badge">Current focus</span>
      <h2 class="ent-focus-title">${esc(it.title)}</h2>
      <p class="ent-focus-meta">${esc(it.creator || "")}${it.creator && itemTags(it).length ? " \u00B7 " : ""}${esc(itemTags(it).join(", "))}</p>
      ${it.note ? `<p class="ent-focus-note">${esc(it.note)}</p>` : ""}
      <div class="ent-progress-row">
        <input type="range" min="0" max="100" value="${pct}" class="ent-progress"
          oninput="previewEntertainmentProgress(this.value)"
          onchange="setEntertainmentProgress('${it.id}',this.value)" aria-label="Progress">
        <span class="ent-progress-pct">${pct}%</span>
      </div>
      ${it.url ? `<span class="link-row ent-link"><a href="${esc(it.url)}" target="_blank" rel="noopener">Open \u2192</a></span>` : ""}
    </div>`;
}

export function renderEntertainment() {
  if (!document.getElementById("page-entertainment")) return;
  const items = ent().items;

  const counts = document.getElementById("entCounts");
  if (counts) {
    const live = liveItems();
    counts.innerHTML =
      TYPES.map(([k, l]) => `<div class="ent-stat"><span>${esc(l)}</span><span class="ent-stat-n">${live.filter(i => i.type === k).length}</span></div>`).join("")
      + STATUSES.map(([k, l]) => `<div class="ent-stat ent-stat-status"><span>${esc(l)}</span><span class="ent-stat-n">${live.filter(i => (i.status || "want") === k).length}</span></div>`).join("")
      + (archivedItems().length ? `<div class="ent-stat ent-stat-status"><span>Archived</span><span class="ent-stat-n">${archivedItems().length}</span></div>` : "");
  }

  const typeBox = document.getElementById("entFilters");
  if (typeBox) {
    typeBox.innerHTML = [["all", "All items"], ...TYPES.map(([k, l]) => [k, l])].map(([k, l]) =>
      `<button class="ent-filter ${filterType === k ? "active" : ""}" onclick="filterEntertainment('${k}')">${esc(l)}</button>`).join("");
  }

  const statusBox = document.getElementById("entStatusTabs");
  if (statusBox) {
    statusBox.innerHTML = [["all", "All"], ...STATUSES].map(([k, l]) =>
      `<button class="ent-tab ${filterStatus === k ? "active" : ""}" onclick="filterEntertainmentStatus('${k}')">${esc(l)}</button>`).join("");
  }

  const tagHead = document.getElementById("entTagHead");
  if (tagHead) tagHead.textContent = filterType === "all" ? "Tags" : `Tags \u00B7 ${TYPE_LABEL[filterType]}`;
  const tagBox = document.getElementById("entTagFilters");
  if (tagBox) {
    const tags = allTags(filterType);
    tagBox.innerHTML = tags.length
      ? tags.map(t => `<button class="ent-tagfilter ${selectedTags.has(t.label) ? "active" : ""}"
          onclick="toggleEntertainmentTag('${esc(q1(t.label))}')">${esc(t.label)} <span>${t.count}</span></button>`).join("")
      : `<p class="hint" style="margin:0">${filterType === "all"
          ? "Tags you add will appear here."
          : `No tags on your ${TYPE_LABEL[filterType].toLowerCase()} yet.`}</p>`;
  }
  // Typing a tag offers the ones already in use — the one thing that stops
  // a tag list fragmenting into near-duplicates over time.
  const dl = document.getElementById("entTagOptions");
  if (dl) dl.innerHTML = allTags("all").map(t => `<option value="${esc(t.label)}">`).join("");

  const focusBox = document.getElementById("entFocus");
  const featured = items.find(i => i.featured) || null;
  if (focusBox) focusBox.innerHTML = focusHtml(featured);

  const matched = sortItems(matchingItems());
  const shown = matched.slice(0, renderLimit);

  /* A filtered view that comes back empty with no explanation is the most
     common way people conclude their data has been lost. The count and a
     visible way out are not decoration. */
  const summary = document.getElementById("entSummary");
  if (summary) {
    summary.innerHTML = !items.length ? ""
      : `<span>${matched.length === items.length
          ? `${items.length} entr${items.length === 1 ? "y" : "ies"}`
          : `${matched.length} of ${items.length} shown`}</span>`
        + (filtersActive() ? ` <button class="ent-clear" onclick="clearEntertainmentFilters()">Clear filters</button>` : "");
  }

  const grid = document.getElementById("entGrid");
  if (grid) {
    grid.className = viewMode === "list" ? "ent-list" : "ent-grid";
    grid.innerHTML = shown.map(viewMode === "list" ? rowHtml : cardHtml).join("") || `<p class="hint">${
      filtersActive() ? "Nothing matches these filters." : "Nothing catalogued yet \u2014 add a book, a song or a video below."}</p>`;
  }

  const more = document.getElementById("entMore");
  if (more) {
    const remaining = matched.length - shown.length;
    more.style.display = remaining > 0 ? "" : "none";
    more.textContent = `Show ${Math.min(remaining, PAGE_SIZE)} more (${remaining} left)`;
  }

  const archived = archivedItems();
  const archBtn = document.getElementById("entArchiveBtn");
  if (archBtn) {
    archBtn.style.display = archived.length ? "" : "none";
    archBtn.textContent = `\uD83D\uDDC4 Archived (${archived.length})`;
  }
  const archPanel = document.getElementById("entArchivePanel");
  if (archPanel) {
    if (!archived.length) archivePanelOpen = false;
    archPanel.classList.toggle("open", archivePanelOpen);
    archPanel.innerHTML = !archivePanelOpen ? "" : archived.map(it => `
      <div class="gsi-archive-row">
        <span class="gsi-archive-text">${TYPES.find(t => t[0] === it.type)?.[2] || ""} ${esc(it.title)}
          ${it.creator ? `<span class="hint">\u2014 ${esc(it.creator)}</span>` : ""}</span>
        <div class="gsi-archive-actions">
          <button class="gsi-archive-restore" onclick="unarchiveEntertainment('${it.id}')">\u21BA Restore</button>
          <button class="gsi-archive-remove" onclick="delEntertainment('${it.id}')" title="Delete (recoverable from Trash)">\u2715</button>
        </div>
      </div>`).join("");
  }

  const viewBtns = document.getElementById("entViewToggle");
  if (viewBtns) viewBtns.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.view === viewMode));
  const sortSel = document.getElementById("entSort");
  if (sortSel && sortSel.value !== sortMode) sortSel.value = sortMode;

  if (featured && featured.url) {
    getLinkPreview(featured.url).then(p => {
      const art = document.getElementById("entFocusArt");
      if (!art || !p || !p.image || !art.isConnected) return;
      const img = document.createElement("img");
      img.src = p.image; img.alt = ""; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.remove());
      art.appendChild(img);
    });
  }
}

/* ---------- filters ----------
   All view-only. None of this is written to state, so which filter a
   device happens to be showing never travels to another device or counts
   as an edit for syncing. */
export function filterEntertainment(type) {
  filterType = type;
  /* A tag selected under Video is meaningless once Books is chosen, and
     leaving it on would silently show an empty shelf with no obvious
     cause. Selections that still exist in the new section are kept. */
  const available = new Set(allTags(type).map(t => t.label));
  [...selectedTags].forEach(t => { if (!available.has(t)) selectedTags.delete(t); });
  renderLimit = PAGE_SIZE;
  renderEntertainment();
}
export function filterEntertainmentStatus(s) { filterStatus = s; renderLimit = PAGE_SIZE; renderEntertainment(); }
export function toggleEntertainmentTag(tag) {
  if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
  renderLimit = PAGE_SIZE;
  renderEntertainment();
}
export function searchEntertainment() {
  searchQuery = document.getElementById("entSearch")?.value || "";
  renderLimit = PAGE_SIZE;
  renderEntertainment();
}
export function sortEntertainment(mode) { sortMode = mode; renderEntertainment(); }
export function setEntertainmentView(mode) { viewMode = mode; renderEntertainment(); }
export function showMoreEntertainment() { renderLimit += PAGE_SIZE; renderEntertainment(); }
export function clearEntertainmentFilters() {
  filterType = "all"; filterStatus = "all"; selectedTags.clear(); searchQuery = "";
  const box = document.getElementById("entSearch"); if (box) box.value = "";
  renderLimit = PAGE_SIZE;
  renderEntertainment();
}

// ---------- entries ----------
export function addEntertainment() {
  const get = id => document.getElementById(id);
  const titleEl = get("entTitle");
  const title = titleEl.value.trim();
  if (!title) { titleEl.focus(); return toast("A title is the one thing that's required"); }
  ent().items.unshift({
    id: uid(),
    type: get("entType").value,
    status: get("entStatus").value,
    title,
    creator: get("entCreator").value.trim(),
    url: get("entUrl").value.trim(),
    note: get("entNote").value.trim(),
    tags: parseTags(get("entTags").value),
    rating: 0, progress: 0, featured: false, addedAt: Date.now(),
  });
  ["entTitle", "entCreator", "entUrl", "entNote", "entTags"].forEach(id => { get(id).value = ""; });
  persist(); rerender();
  titleEl.focus(); // straight on to the next one
}
export function delEntertainment(id) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  moveToTrash("entertainment", it, {});
  state.entertainment.items = ent().items.filter(x => x.id !== id);
  persist(); rerender();
  /* Three ways back from a mistaken delete, in descending order of how
     quickly they're needed: Undo right here, Archive if it shouldn't have
     been deleted at all, and Trash for the next 30 days. */
  toast(`Deleted "${it.title}"`, "Undo", "undoEntertainmentDelete()");
}
export function undoEntertainmentDelete() {
  // Trash is newest-first, so the first match is the one just deleted.
  const entry = state.trash.find(x => x.type === "entertainment");
  if (!entry) return toast("Nothing left to undo");
  ent().items.unshift(entry.payload);
  state.trash = state.trash.filter(x => x.id !== entry.id);
  persist(); rerender();
  toast(`Restored "${entry.payload.title}"`);
}

export function archiveEntertainment(id) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  it.archived = true;
  it.featured = false; // something filed away can't still be the Current focus
  persist(); rerender();
  toast(`Archived "${it.title}"`, "Undo", `unarchiveEntertainment('${id}')`);
}
export function unarchiveEntertainment(id) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  it.archived = false;
  persist(); rerender();
  toast(`Restored "${it.title}"`);
}
export function toggleEntertainmentArchivePanel() {
  archivePanelOpen = !archivePanelOpen;
  renderEntertainment();
}
export function rateEntertainment(id, n) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  it.rating = it.rating === n ? 0 : n; // the same star again clears it
  persist(); rerender();
}
export function setEntertainmentStatus(id, status) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  it.status = status;
  if (status === "done") it.progress = 100; // finished shouldn't still read 40%
  persist(); rerender();
}
export function toggleEntertainmentFocus(id) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  const on = !it.featured;
  ent().items.forEach(x => { x.featured = false; }); // only one focus at a time
  it.featured = on;
  if (on && (it.status || "want") === "want") it.status = "doing"; // pinning it means you've started
  persist(); rerender();
}
export function previewEntertainmentProgress(value) {
  const pct = document.querySelector(".ent-progress-pct");
  if (pct) pct.textContent = Math.max(0, Math.min(100, Number(value) || 0)) + "%";
}
export function setEntertainmentProgress(id, value) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  it.progress = Math.max(0, Math.min(100, Number(value) || 0));
  if (it.progress >= 100) it.status = "done";
  else if (it.progress > 0 && (it.status || "want") === "want") it.status = "doing";
  previewEntertainmentProgress(it.progress);
  persist(); // committed on release, so it always marks the device as edited
}

/* ---------- editing an existing entry ----------
   Everything typed when the entry was created is editable afterwards. The
   fields are the same ones, in the same order, so the edit form reads as
   the add form rather than as a different screen. */
let editingId = null;

export function openEntertainmentEdit(id) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  editingId = id;
  const set = (field, value) => { const el = document.getElementById(field); if (el) el.value = value; };
  set("entEditType", it.type);
  set("entEditStatus", it.status || "want");
  set("entEditTitle", it.title || "");
  set("entEditCreator", it.creator || "");
  set("entEditUrl", it.url || "");
  set("entEditTags", itemTags(it).join(", "));
  set("entEditNote", it.note || "");
  const dl = document.getElementById("entEditTagOptions");
  if (dl) dl.innerHTML = allTags("all").map(t => `<option value="${esc(t.label)}">`).join("");
  document.getElementById("entEditModalBg")?.classList.add("open");
  document.getElementById("entEditTitle")?.focus();
}
export function closeEntertainmentEdit() {
  editingId = null;
  document.getElementById("entEditModalBg")?.classList.remove("open");
}
export function saveEntertainmentEdit() {
  const it = ent().items.find(x => x.id === editingId);
  if (!it) return closeEntertainmentEdit();
  const get = id => (document.getElementById(id)?.value ?? "");
  const title = get("entEditTitle").trim();
  if (!title) { document.getElementById("entEditTitle")?.focus(); return toast("A title is still required"); }
  it.type = get("entEditType");
  it.status = get("entEditStatus");
  it.title = title;
  it.creator = get("entEditCreator").trim();
  it.url = get("entEditUrl").trim();
  it.note = get("entEditNote").trim();
  it.tags = parseTags(get("entEditTags"));
  // Same rule the status dropdown follows, so the two can't disagree.
  if (it.status === "done") it.progress = 100;
  closeEntertainmentEdit();
  persist(); rerender();
  toast("Entry updated");
}
export function deleteFromEntertainmentEdit() {
  const id = editingId;
  closeEntertainmentEdit();
  if (id) delEntertainment(id);
}
