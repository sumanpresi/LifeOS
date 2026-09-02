/* Universal search (Ctrl/Cmd+K) across everything in LifeOS. */
import { state, esc, SECTION_META } from './state.js?v=202609040600';
import { go, scrollToEl } from './ui.js?v=202609040600';

let items = [], results = [], sel = 0;
let includeArchivedTasks = false; // default OFF, per spec — archived tasks stay out of everyday search unless explicitly opted in

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildIndex() {
  const ix = [];
  const push = (type, text, sub, action) => text && ix.push({ type, text, sub, action });
  // Everything below reaches into nearly every corner of app state.
  // A single malformed or unexpectedly-shaped field anywhere in that
  // chain would previously throw here — aborting buildIndex() entirely,
  // which meant openSearch() never reached the line that actually shows
  // the modal, and the whole feature looked like it silently did
  // nothing on tap. Now one broken section just means that section's
  // items are missing from this session's results — everything else
  // still gets indexed and search still opens.
  try {

  state.tasks.forEach(t => {
    if (t.archived && !includeArchivedTasks) return;
    push("Task", t.text, (t.archived ? "archived" : t.done ? "done" : "open"),
      () => { go("overview"); scrollToEl("tasksCard"); });
  });
  state.goals.forEach(g => push("Goal", g.name, g.pct + "%", () => go("overview")));
  state.habits.forEach(h => push("Habit", h.name, "", () => go("overview")));
  state.links.forEach(l => push("Link", l.title, l.desc || "", () => window.open(l.url, "_blank")));
  state.feeds.forEach(f => push("News", f.name, "", () => window.open(f.url, "_blank")));
  state.quotes.forEach(q => push("Quote", q, "", () => { go("overview"); scrollToEl("quoteCard"); }));

  // Journal entries are stored as HTML now that the editor is rich text,
  // so index and preview the readable text — searching for a word should
  // not miss it because a tag sits in the middle of it.
  Object.entries(state.journal).forEach(([date, text]) => {
    const plain = stripHtml(text);
    plain.trim() && push("Journal", plain.slice(0, 120), date, () => go("dayof"));
  });

  const secPages = Object.assign({}, SECTION_META, { work: "Work · GSI", personal: "Personal" });
  Object.entries(secPages).forEach(([key, label]) => {
    const sec = state.sections[key]; if (!sec) return;
    // Notes are now a list of rich-text notes per section rather than one
    // free-text box, so index each note by its title and its readable text.
    (sec.noteList || []).forEach(n => {
      n.title && push("Notes", n.title, label, () => go(key));
      stripHtml(n.html).split(/(?:\n|\.\s)/).forEach(line =>
        line.trim() && push("Notes", line.trim().slice(0, 120), label, () => go(key)));
    });
    (sec.links || []).forEach(l => push("Link", l.title, label, () => window.open(l.url, "_blank")));
  });

  // Work · GSI — multi-project tasks, work log, meetings, links, documents
  (state.gsi.projects || []).forEach(p => {
    (p.tasks || []).forEach(t => push("GSI task", t.text, p.name + " · " + t.status, () => go("work")));
  });
  state.gsi.log.forEach(e => push("Work log", e.text.slice(0, 120), e.date, () => go("work")));
  state.gsi.meetings.forEach(m => {
    push("Meeting", m.title || "Untitled meeting", fmtSearchDate(m.date), () => go("work"));
    [["Agenda", m.agenda], ["Updates", m.updates], ["Action items", m.actionItems]].forEach(([label, html]) => {
      const text = stripHtml(html);
      text && push("Meeting", text.slice(0, 120), (m.title || "Meeting") + " · " + label, () => go("work"));
    });
  });
  state.gsi.links.forEach(l => push("Link", l.title, "GSI", () => window.open(l.url, "_blank")));
  (state.gsi.personalDocs || []).forEach(d => push("Document", d.name, "Personal", () => window.open(d.url, "_blank")));
  // Work documents live per project, inside named tabs — the old flat
  // state.gsi.workDocs has been empty since that move, so nothing here was
  // reaching the index at all. Archived tabs and links stay out.
  (state.gsi.projects || []).forEach(proj =>
    (proj.workDocGroups || []).filter(gr => !gr.archived).forEach(gr =>
      gr.docs.filter(d => !d.archived).forEach(d =>
        push("Document", d.name, `${proj.name} · ${gr.name}`, () => window.open(d.url, "_blank")))));

  // Personal Workspace — projects, tasks, links and documents. Mirrors the
  // GSI block above; kept separate because the two trees are separate, and
  // the sub-label says which workspace a hit came from so an identically
  // worded task in both is still tellable apart in the results list.
  (state.personal?.projects || []).forEach(p => {
    (p.tasks || []).forEach(t =>
      push("Personal task", t.text, p.name + " \u00b7 " + t.status, () => go("personal")));
    (p.workDocs || []).forEach(d =>
      push("Document", d.name, "Personal \u00b7 " + p.name, () => window.open(d.url, "_blank")));
  });
  (state.personal?.links || []).forEach(l =>
    push("Link", l.title, "Personal", () => window.open(l.url, "_blank")));
  (state.personal?.docs || []).forEach(d =>
    push("Document", d.name, "Personal", () => window.open(d.url, "_blank")));

  // Finance
  (state.finance.notes || "").split("\n").forEach(line =>
    line.trim() && push("Notes", line.trim().slice(0, 120), "Finance", () => go("finance")));
  (state.finance.links || []).forEach(l => push("Link", l.title, "Finance", () => window.open(l.url, "_blank")));
  ["grocery", "shopping", "wishlist"].forEach(key => {
    (state.finance[key] || []).forEach(i => push("Finance", i.name, key[0].toUpperCase() + key.slice(1), () => go("finance")));
  });

  // Health
  (state.health.notes || "").split("\n").forEach(line =>
    line.trim() && push("Notes", line.trim().slice(0, 120), "Health", () => go("health")));
  (state.health.links || []).forEach(l => push("Link", l.title, "Health", () => window.open(l.url, "_blank")));
  (state.health.medicines || []).forEach(m => push("Medicine", m.name, "", () => go("health")));
  (state.health.prescriptions || []).forEach(p => push("Prescription", p.name, "", () => go("health")));

  // Entertainment — books, music and video, findable by title, creator or note
  ((state.entertainment && state.entertainment.items) || []).forEach(it => {
    const kind = { book: "Book", music: "Music", video: "Video" }[it.type] || "Entry";
    push(kind, it.title, [it.creator, ...(it.tags || [])].filter(Boolean).join(" \u00B7 "), () => go("entertainment"));
    it.note && push(kind, it.note.slice(0, 120), it.title, () => go("entertainment"));
  });

  // Travel Plan — every plan's notes, packing list, and stops
  (state.travel.plans || []).forEach(p => {
    push("Travel plan", p.name, "", () => go("travel"));
    (p.notes || "").split("\n").forEach(line =>
      line.trim() && push("Notes", line.trim().slice(0, 120), "Travel · " + p.name, () => go("travel")));
    // Packing is now several named lists per plan rather than one blob —
    // index each list's name, its items, and its rich-text notes.
    (p.packLists || []).forEach(l => {
      push("Packing list", l.name, p.name, () => go("travel"));
      (l.items || []).forEach(it =>
        it.text && push("Packing", it.text, `${p.name} · ${l.name}`, () => go("travel")));
      stripHtml(l.notes).split(/(?:\n|\.\s)/).forEach(line =>
        line.trim() && push("Notes", line.trim().slice(0, 120), `${p.name} · ${l.name}`, () => go("travel")));
    });
    (p.stops || []).forEach(s => s.place && push("Stop", s.place, p.name, () => go("travel")));
  });

  // Reference — every page's notes, links, plus the world map is not text-searchable
  (state.reference.pages || []).forEach(p => {
    push("Reference page", p.name, "", () => go("reference"));
    (p.notes || "").split("\n").forEach(line =>
      line.trim() && push("Notes", line.trim().slice(0, 120), "Reference · " + p.name, () => go("reference")));
    (p.links || []).forEach(l => push("Link", l.title, "Reference · " + p.name, () => window.open(l.url, "_blank")));
  });

  const c = state.communication;
  if (c) {
    (c.vocab || []).forEach(v => push("Vocabulary", v.word, v.meaning || "", () => go("communication")));
    (c.mistakes || []).forEach(m => push("Mistake", m.wrong + " → " + m.right, m.cat || "", () => go("communication")));
    (c.writing || []).forEach(w => push("Writing", (w.text || "").slice(0, 120), w.date || "", () => go("communication")));
  }

  } catch (e) {
    console.error("[search] buildIndex hit an error partway through — showing what was indexed before the failure:", e);
  }
  return ix;
}
function fmtSearchDate(d) {
  if (!d) return "";
  try { return new Date(d + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch (e) { return d; }
}

export function openSearch() {
  try { items = buildIndex(); } catch (e) { items = []; console.error("[search] buildIndex threw outside its own try/catch — opening with an empty index:", e); }
  const bg = document.getElementById("searchBg");
  if (!bg) { console.error("[search] #searchBg not found in the page — can't open search."); return; }
  bg.classList.add("open");
  const inp = document.getElementById("searchInput");
  if (inp) { inp.value = ""; inp.focus(); }
  runSearch("");
}
export function closeSearch() { document.getElementById("searchBg").classList.remove("open"); }
export function setSearchIncludeArchived(v) {
  includeArchivedTasks = v;
  items = buildIndex();
  runSearch(document.getElementById("searchInput").value);
}

function runSearch(q) {
  q = q.trim().toLowerCase();
  if (!q) { results = items.slice(0, 12); sel = 0; renderResults(); return; }
  // Rank by relevance instead of leaving matches in whatever arbitrary
  // order buildIndex() happened to add them in (tasks, then goals, then
  // habits, then links...). Without this, "top result" — the one Enter
  // picks — just meant "first category that happened to contain a
  // match," not "best match," which is exactly why Enter often landed
  // somewhere unrelated to what was actually being searched for.
  const scored = [];
  items.forEach(i => {
    const text = i.text.toLowerCase(), sub = (i.sub || "").toLowerCase(), type = i.type.toLowerCase();
    if (!(text + " " + sub + " " + type).includes(q)) return;
    let score;
    if (text === q) score = 0;              // exact match
    else if (text.startsWith(q)) score = 1;  // starts with the query
    else if (text.includes(q)) score = 2;    // query appears anywhere in the main text
    else score = 3;                          // only matched in the category/subtitle
    scored.push({ item: i, score });
  });
  scored.sort((a, b) => a.score - b.score); // stable sort — same-score items keep their relative order
  results = scored.slice(0, 30).map(s => s.item);
  sel = 0; renderResults();
}
function renderResults() {
  const box = document.getElementById("searchResults");
  box.innerHTML = results.length ? results.map((r, i) => `
    <button class="search-item ${i === sel ? "sel" : ""}" onmousemove="searchHover(${i})" onclick="searchPick(${i})">
      <span class="search-badge">${r.type}</span>
      <span class="search-text">${esc(r.text)}</span>
      <span class="search-sub">${esc(r.sub)}</span>
    </button>`).join("")
    : `<div class="search-empty">Nothing found — try fewer words.</div>`;
  const el = box.querySelector(".sel");
  if (el) el.scrollIntoView({ block: "nearest" });
}
export function searchHover(i) { if (sel !== i) { sel = i; renderResults(); } }
export function searchPick(i) {
  const r = results[i]; if (!r) return;
  closeSearch(); r.action();
}

export function initSearch() {
  document.getElementById("searchInput").addEventListener("input", e => runSearch(e.target.value));
  document.getElementById("searchBg").addEventListener("click", e => {
    if (e.target.id === "searchBg") closeSearch();
  });
  document.addEventListener("keydown", e => {
    const open = document.getElementById("searchBg").classList.contains("open");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault(); open ? closeSearch() : openSearch(); return;
    }
    if (!open) return;
    if (e.key === "Escape") closeSearch();
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); renderResults(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); renderResults(); }
    else if (e.key === "Enter") { e.preventDefault(); searchPick(sel); }
  });
}
