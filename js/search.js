/* Universal search (Ctrl/Cmd+K) across everything in LifeOS. */
import { state, esc, SECTION_META } from './state.js';
import { go, scrollToEl } from './ui.js';

let items = [], results = [], sel = 0;

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function buildIndex() {
  const ix = [];
  const push = (type, text, sub, action) => text && ix.push({ type, text, sub, action });

  state.tasks.forEach(t => push("Task", t.text, t.done ? "done" : "open",
    () => { go("overview"); scrollToEl("tasksCard"); }));
  state.goals.forEach(g => push("Goal", g.name, g.pct + "%", () => go("overview")));
  state.habits.forEach(h => push("Habit", h.name, "", () => go("overview")));
  state.links.forEach(l => push("Link", l.title, l.desc || "", () => window.open(l.url, "_blank")));
  state.feeds.forEach(f => push("News", f.name, "", () => window.open(f.url, "_blank")));
  state.quotes.forEach(q => push("Quote", q, "", () => { go("overview"); scrollToEl("quoteCard"); }));

  Object.entries(state.journal).forEach(([date, text]) =>
    text.trim() && push("Journal", text.slice(0, 120), date, () => go("dayof")));

  const secPages = Object.assign({}, SECTION_META, { work: "Work · GSI" });
  Object.entries(secPages).forEach(([key, label]) => {
    const sec = state.sections[key]; if (!sec) return;
    (sec.notes || "").split("\n").forEach(line =>
      line.trim() && push("Notes", line.trim().slice(0, 120), label, () => go(key)));
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
  (state.gsi.workDocs || []).forEach(d => push("Document", d.name, "Work", () => window.open(d.url, "_blank")));

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

  // Travel Plan — every plan's notes, packing list, and stops
  (state.travel.plans || []).forEach(p => {
    push("Travel plan", p.name, "", () => go("travel"));
    (p.notes || "").split("\n").forEach(line =>
      line.trim() && push("Notes", line.trim().slice(0, 120), "Travel · " + p.name, () => go("travel")));
    (p.packing || "").split("\n").forEach(line =>
      line.trim() && push("Packing", line.trim(), p.name, () => go("travel")));
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
  return ix;
}
function fmtSearchDate(d) {
  if (!d) return "";
  try { return new Date(d + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch (e) { return d; }
}

export function openSearch() {
  items = buildIndex();
  document.getElementById("searchBg").classList.add("open");
  const inp = document.getElementById("searchInput");
  inp.value = ""; runSearch(""); inp.focus();
}
export function closeSearch() { document.getElementById("searchBg").classList.remove("open"); }

function runSearch(q) {
  q = q.trim().toLowerCase();
  results = !q ? items.slice(0, 12) :
    items.filter(i => (i.text + " " + i.sub + " " + i.type).toLowerCase().includes(q)).slice(0, 30);
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
