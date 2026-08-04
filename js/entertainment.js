/* Entertainment — a personal catalogue of books, music and video.

   The layout follows the "curated archive" idea: a Current focus panel
   for whatever is being read or watched right now, a filter down the
   side, a search, and a grid of entries.

   Two deliberate departures from the mockup that inspired it:

   • It is built in LifeOS's own visual language rather than the dark
     glass one. A single page in a different palette reads as a page from
     a different app, and the sidebar and header sit around it regardless.
     The structure is what was worth taking.

   • No Tailwind and no Alpine. Adding two CDN frameworks for one page
     would put the whole app's no-build setup on someone else's uptime,
     and the filtering they were doing there is a few lines here.

   Entries carry a URL, so the link-preview work already in the app does
   the heavy lifting: a pasted song or video link brings back its own
   title and artwork. */

import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';
import { moveToTrash } from './trash.js';
import { getLinkPreview } from './link-preview.js';

const TYPES = [
  ["book", "Books", "\u{1F4D6}"],
  ["music", "Music", "\u{1F3B5}"],
  ["video", "Video", "\u{1F3AC}"],
];
const TYPE_LABEL = Object.fromEntries(TYPES.map(([k, label]) => [k, label]));

let filterType = "all";
let searchQuery = "";

function ent() {
  if (!state.entertainment || typeof state.entertainment !== "object") {
    state.entertainment = { items: [] };
  }
  if (!Array.isArray(state.entertainment.items)) state.entertainment.items = [];
  return state.entertainment;
}

function visibleItems() {
  const q = searchQuery.trim().toLowerCase();
  return ent().items.filter(it => {
    if (filterType !== "all" && it.type !== filterType) return false;
    if (!q) return true;
    // Searched across everything the person typed, not just the title —
    // "Herbert" and "sci-fi" are how you actually look for a book.
    return [it.title, it.creator, it.note, it.tag, TYPE_LABEL[it.type]]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}

function starsHtml(rating, id) {
  // Clicking the star you're already on clears it — otherwise a rating
  // given by mistake can only ever be changed, never removed.
  return `<span class="ent-stars">${[1, 2, 3, 4, 5].map(n =>
    `<button class="ent-star ${n <= (rating || 0) ? "on" : ""}"
       onclick="rateEntertainment('${id}',${n})"
       title="${n === rating ? "Clear rating" : n + " star" + (n === 1 ? "" : "s")}">\u2605</button>`).join("")}</span>`;
}

function entryHtml(it) {
  const host = (() => {
    try { return it.url ? new URL(it.url).hostname.replace(/^www\./, "") : ""; }
    catch (e) { return ""; }
  })();
  return `
  <article class="ent-card ent-${esc(it.type)}" data-ent-id="${it.id}">
    <div class="ent-card-head">
      <span class="ent-type">${TYPES.find(t => t[0] === it.type)?.[2] || ""} ${esc(TYPE_LABEL[it.type] || it.type)}</span>
      ${it.tag ? `<span class="ent-tag">${esc(it.tag)}</span>` : ""}
      <button class="ent-focus-btn ${it.featured ? "on" : ""}" onclick="toggleEntertainmentFocus('${it.id}')"
        title="${it.featured ? "Remove from Current focus" : "Set as Current focus"}">\u25C9</button>
      <button class="del" onclick="delEntertainment('${it.id}')" title="Delete">\u2715</button>
    </div>
    <h4 class="ent-title">${esc(it.title)}</h4>
    ${it.creator ? `<p class="ent-creator">${esc(it.creator)}</p>` : ""}
    ${it.note ? `<p class="ent-note">${esc(it.note)}</p>` : ""}
    <div class="ent-card-foot">
      ${starsHtml(it.rating, it.id)}
      ${it.url ? `<span class="link-row ent-link"><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(host || "Open")} \u2192</a></span>` : ""}
    </div>
  </article>`;
}

function focusHtml(it) {
  if (!it) {
    return `<p class="hint" style="margin:0">Nothing set as Current focus. Use the \u25C9 button on any entry to pin what you're reading or watching right now.</p>`;
  }
  const pct = Number(it.progress) > 0 ? Math.min(100, Number(it.progress)) : 0;
  return `
    <div class="ent-focus-art" id="entFocusArt"></div>
    <div class="ent-focus-body">
      <span class="ent-focus-badge">Current focus</span>
      <h2 class="ent-focus-title">${esc(it.title)}</h2>
      <p class="ent-focus-meta">${esc(it.creator || "")}${it.creator && it.tag ? " \u00B7 " : ""}${esc(it.tag || "")}</p>
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
  const page = document.getElementById("page-entertainment");
  if (!page) return;
  const items = ent().items;

  const counts = document.getElementById("entCounts");
  if (counts) {
    counts.innerHTML = TYPES.map(([k, label]) =>
      `<div class="ent-stat"><span>${esc(label)}</span><span class="ent-stat-n">${items.filter(i => i.type === k).length}</span></div>`
    ).join("");
  }

  const filters = document.getElementById("entFilters");
  if (filters) {
    filters.innerHTML = [["all", "All items"], ...TYPES.map(([k, l]) => [k, l])].map(([k, label]) =>
      `<button class="ent-filter ${filterType === k ? "active" : ""}" onclick="filterEntertainment('${k}')">${esc(label)}</button>`
    ).join("");
  }

  const focusBox = document.getElementById("entFocus");
  const featured = items.find(i => i.featured) || null;
  if (focusBox) focusBox.innerHTML = focusHtml(featured);

  const grid = document.getElementById("entGrid");
  if (grid) {
    const shown = visibleItems();
    grid.innerHTML = shown.map(entryHtml).join("") || `<p class="hint">${
      searchQuery ? "Nothing matches that." :
      filterType === "all" ? "Nothing catalogued yet \u2014 add a book, a song or a video below."
        : "Nothing in this category yet."}</p>`;
  }

  // Artwork for the focus panel comes from the link itself, so a pinned
  // song or film shows its own cover without anything being uploaded.
  if (featured && featured.url) {
    getLinkPreview(featured.url).then(p => {
      const art = document.getElementById("entFocusArt");
      // The page may have re-rendered or moved on while this was fetching.
      if (!art || !p || !p.image || !art.isConnected) return;
      const img = document.createElement("img");
      img.src = p.image;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => img.remove());
      art.appendChild(img);
    });
  }
}

export function addEntertainment() {
  const type = document.getElementById("entType").value;
  const titleEl = document.getElementById("entTitle");
  const creatorEl = document.getElementById("entCreator");
  const urlEl = document.getElementById("entUrl");
  const noteEl = document.getElementById("entNote");
  const tagEl = document.getElementById("entTag");
  const title = titleEl.value.trim();
  if (!title) { titleEl.focus(); return toast("A title is the one thing that's required"); }

  ent().items.unshift({
    id: uid(), type, title,
    creator: creatorEl.value.trim(),
    url: urlEl.value.trim(),
    note: noteEl.value.trim(),
    tag: tagEl.value.trim(),
    rating: 0, progress: 0, featured: false,
    addedAt: Date.now(),
  });
  [titleEl, creatorEl, urlEl, noteEl, tagEl].forEach(el => { el.value = ""; });
  persist(); rerender();
  titleEl.focus(); // straight on to the next one
}

export function delEntertainment(id) {
  const list = ent().items;
  const it = list.find(x => x.id === id);
  if (!it) return;
  moveToTrash("entertainment", it, {});
  state.entertainment.items = list.filter(x => x.id !== id);
  persist(); rerender();
  toast(`Deleted "${it.title}"`);
}

export function rateEntertainment(id, n) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  it.rating = it.rating === n ? 0 : n; // same star again clears it
  persist(); rerender();
}

export function toggleEntertainmentFocus(id) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  const turningOn = !it.featured;
  // Only one thing can be the current focus — "what I'm on right now"
  // stops meaning anything if three items claim it.
  ent().items.forEach(x => { x.featured = false; });
  it.featured = turningOn;
  persist(); rerender();
}

/* Dragging fires continuously, so the label is updated on the way and the
   value is only committed when the slider is released.

   The first version of this called persist(false) during the drag and a
   full persist() on a timer afterwards. That was wrong in a way specific
   to how syncing works here: persist(false) writes to this device but
   does NOT increment state.rev, and rev is exactly what tells the sync
   layer "this device has changes". Close the tab inside that window and
   the new progress sits on disk while the device still looks unedited —
   so the next sync would treat the cloud copy as authoritative and
   silently roll it back. Committing on release removes the window
   entirely: the value is either not saved yet, or saved and flagged. */
export function previewEntertainmentProgress(value) {
  const pct = document.querySelector(".ent-progress-pct");
  if (pct) pct.textContent = Math.max(0, Math.min(100, Number(value) || 0)) + "%";
}
export function setEntertainmentProgress(id, value) {
  const it = ent().items.find(x => x.id === id);
  if (!it) return;
  it.progress = Math.max(0, Math.min(100, Number(value) || 0));
  previewEntertainmentProgress(it.progress);
  persist(); // real data — must bump rev so the change is offered to other devices
}

export function filterEntertainment(type) {
  filterType = type;
  renderEntertainment();
}

export function searchEntertainment() {
  searchQuery = document.getElementById("entSearch")?.value || "";
  renderEntertainment();
}
