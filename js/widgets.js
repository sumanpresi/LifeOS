/* Links, news feeds, quotes, meditation, Day Of page + journal. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';
import { toast, autoGrow } from './ui.js';
import { moveToTrash } from './trash.js';
import { isLogged, streak } from './habits.js';
import { getAllGsiTasksFlat } from './gsi.js';
import { mountRichEditor } from './rich-text.js';

/* ---------- important links ---------- */
let openLinkEditId = null; // which single link's inline edit panel is open — UI-only, not persisted
export function renderLinks() {
  document.getElementById("linksGrid").innerHTML = state.links.map(l => `
    <div class="link-row" data-link-id="${l.id}">
      <a href="${esc(l.url)}" target="_blank" rel="noopener" class="link-row-title" onclick="linkClickPulse(this)">${esc(l.title)}</a>
      <button class="link-edit-btn" onclick="toggleLinkEdit('${l.id}')" title="Edit link">✎</button>
      <button class="del link-del-btn" onclick="delLink('${l.id}')" title="Delete">✕</button>
      <div class="link-edit-panel ${openLinkEditId === l.id ? "open" : ""}" id="linkEdit-${l.id}">
        <div class="link-edit-panel-inner">
          <input type="text" value="${esc(l.title)}" placeholder="Title" onchange="editLink('${l.id}','title',this.value)">
          <input type="text" value="${esc(l.url)}" placeholder="https://…" onchange="editLink('${l.id}','url',this.value)">
          <input type="text" value="${esc(l.desc || "")}" placeholder="Description (optional)" onchange="editLink('${l.id}','desc',this.value)">
        </div>
      </div>
    </div>`).join("") || `<p class="hint">Save the links you reach for every day.</p>`;
}
export function toggleLinkEdit(id) {
  openLinkEditId = openLinkEditId === id ? null : id;
  renderLinks();
  // The popover's own z-index only has authority within its containing
  // .card's stacking context (backdrop-filter gives every .card its own
  // one) — it can never paint above a completely separate sibling card
  // like Tasks below it, no matter how high that number is set. Instead
  // the containing card itself gets promoted for as long as a popover
  // inside it is open, which lets its content — the popover included —
  // paint above the next card in normal document flow.
  const card = document.getElementById("linksGrid")?.closest(".card");
  if (card) card.classList.toggle("has-open-popover", !!openLinkEditId);
  if (openLinkEditId) document.querySelector(`#linkEdit-${id} input`)?.focus();
}
document.addEventListener("pointerdown", (evt) => {
  if (!openLinkEditId) return;
  if (evt.target.closest(".link-edit-panel") || evt.target.closest(".link-edit-btn")) return;
  toggleLinkEdit(openLinkEditId); // same id toggles it closed
});
export function editLink(id, field, value) {
  const l = state.links.find(x => x.id === id);
  if (!l) return;
  if (field === "url") { value = value.trim(); if (value && !/^https?:\/\//i.test(value)) value = "https://" + value; }
  l[field] = value.trim ? value.trim() : value;
  persist(); rerender();
}
// A quick, satisfying press animation on the link itself — the click
// still opens the link normally (this doesn't preventDefault anything),
// this just gives it some tactile feedback beyond the plain color change
// a bare <a> gets. Remove-then-reflow-then-add is needed so the
// animation reliably restarts even if you click the same link twice in
// a row, rather than silently doing nothing the second time because the
// class was already present.
export function linkClickPulse(el) {
  el.classList.remove("clicked");
  void el.offsetWidth;
  el.classList.add("clicked");
}
export function addLink() {
  const t = document.getElementById("linkTitle"), u = document.getElementById("linkUrl"), d = document.getElementById("linkDesc");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.links.push({ id: uid(), title: t.value.trim(), url, desc: d.value.trim() });
  t.value = u.value = d.value = "";
  persist(); rerender();
}
export function delLink(id) {
  const l = state.links.find(x => x.id === id);
  if (l) moveToTrash("bookmarkLink", l);
  state.links = state.links.filter(x => x.id !== id); persist(); rerender();
}

/* ---------- news feeds ---------- */
export function renderFeeds() {
  document.getElementById("newsList").innerHTML = state.feeds.map(f => `
    <a href="${esc(f.url)}" target="_blank" rel="noopener">
      <span class="fav">${esc((f.name || "?")[0])}</span>${esc(f.name)}
      <button class="del" style="margin-left:auto;opacity:.35" onclick="event.preventDefault();delFeed('${f.id}')">✕</button>
    </a>`).join("");
}
export function addFeed() {
  const n = document.getElementById("feedName"), u = document.getElementById("feedUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.feeds.push({ id: uid(), name: n.value.trim(), url }); n.value = u.value = "";
  persist(); rerender();
}
export function delFeed(id) {
  const f = state.feeds.find(x => x.id === id);
  if (f) moveToTrash("feed", f);
  state.feeds = state.feeds.filter(x => x.id !== id); persist(); rerender();
}

/* ---------- quotes ---------- */
const dayIndex = () => {
  const start = new Date(new Date().getFullYear(), 0, 0);
  return Math.floor((Date.now() - start) / 864e5);
};
export function renderQuote() {
  if (!state.quotes.length) {
    document.getElementById("quoteBox").textContent = "Add some quotes you love."; return;
  }
  const q = state.quotes[(dayIndex() + state.quoteOffset) % state.quotes.length];
  document.getElementById("quoteBox").innerHTML = `<span class="mark">“</span>${esc(q)}`;
}
export function nextQuote() { state.quoteOffset++; persist(false); renderQuote(); }

/* ---------- meditation ---------- */
let medSecs = 600, medLeft = 600, medTimer = null;
const fmtClock = s => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");

export function setMed(min) {
  stopMed(); medSecs = medLeft = min * 60;
  document.getElementById("medClock").textContent = fmtClock(medLeft);
}
export function toggleMed() { medTimer ? stopMed() : startMed(); }
function startMed() {
  document.getElementById("medStartBtn").textContent = "Pause";
  medTimer = setInterval(() => {
    medLeft--; document.getElementById("medClock").textContent = fmtClock(medLeft);
    if (medLeft <= 0) {
      stopMed(); logMed(Math.round(medSecs / 60)); medLeft = medSecs;
      document.getElementById("medClock").textContent = fmtClock(medLeft);
      toast("Meditation complete 🌿");
    }
  }, 1000);
}
function stopMed() {
  clearInterval(medTimer); medTimer = null;
  document.getElementById("medStartBtn").textContent = "Start";
}
function logMed(min) {
  const k = todayKey();
  state.meditation[k] = (state.meditation[k] || 0) + min;
  persist(); renderMedStat();
}
export function renderMedStat() {
  const today = state.meditation[todayKey()] || 0;
  document.getElementById("medStat").textContent = today ? `${today} min logged today` : "No session logged today yet";
  document.getElementById("medTodayHint").textContent = today ? `${today} min today` : "";
  const catMedSub = document.getElementById("catMedSub");
  if (catMedSub) catMedSub.textContent = today ? `${today} min done today 🌿` : "Breathe for a while.";
}

/* ---------- Day Of page ---------- */
let currentJournalDate = null; // null = today (re-evaluated each render so it stays "today" across midnight)

export function renderDayOf() {
  const k = todayKey();
  const viewDate = currentJournalDate || k;

  // "Today's focus" mixes urgency and importance: due today, overdue
  // (still needs attention), finished today (so the day's progress is
  // visible) — and now also anything flagged as important, regardless of
  // its date, since a flagged task is one you've deliberately said matters
  // right now even if it isn't formally due. Applies to both personal
  // tasks and GSI Workspace tasks — toggling or editing either one here
  // routes through tasks.js's toggleTask/editTask, which already handle
  // GSI-sourced IDs transparently (same routing Overview's own merged
  // task view relies on), so nothing GSI-specific is needed here beyond
  // supplying the merged list itself.
  const personal = state.tasks.map(t => ({ ...t, isGsi: false, source: null }));
  const gsi = getAllGsiTasksFlat().map(t => ({
    id: t.id, text: t.text, done: t.status === "done", flag: !!t.flag,
    link: t.link || "", dueDate: t.date || "", completedAt: null,
    isGsi: true, source: t.projectName
  }));
  const dayTaskList = [...personal, ...gsi].filter(t => {
    if (t.done) return t.completedAt && todayKey(new Date(t.completedAt)) === k;
    if (t.flag) return true;
    return t.dueDate && t.dueDate <= k;
  }).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1; // completed sinks to the bottom
    if (!!a.flag !== !!b.flag) return a.flag ? -1 : 1; // flagged/important first
    return (a.dueDate || "").localeCompare(b.dueDate || ""); // then overdue (earlier date) first
  });

  document.getElementById("dayTasks").innerHTML = dayTaskList.map((t, i) => `
    <div class="task-row ${t.done ? "done" : ""}">
      <button class="chk ${t.done ? "on" : ""}" onclick="toggleTask('${t.id}')"><svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <span class="task-num">${i + 1}</span>
      <textarea class="${t.link ? "task-text-linked" : ""}" rows="1" onclick="event.stopPropagation()" onchange="editTask('${t.id}',this.value)" oninput="autoGrow(this)">${esc(t.text)}</textarea>
      ${t.source ? `<span class="task-source-badge">${esc(t.source)}</span>` : ""}
      ${t.link ? `<a href="${esc(t.link.startsWith("http")?t.link:"https://"+t.link)}" target="_blank" rel="noopener" class="task-link-go-inline" title="Open link">🔗</a>` : ""}
      ${!t.done && t.dueDate && t.dueDate < k ? `<span class="due-pill overdue">Overdue</span>` : ""}
    </div>`).join("") || `<p class="hint">Nothing due today — give a task a due date on Overview to see it here.</p>`;
  // Same "measure after render" requirement as everywhere else this
  // input→textarea fix has been applied — see go() in ui.js for the
  // re-run when this page was hidden at the moment this render happened.
  document.getElementById("dayTasks").querySelectorAll("textarea").forEach(autoGrow);
  document.getElementById("dayHabits").innerHTML = state.habits.map(h => `
    <div class="task-row">
      <button class="chk ${isLogged(k, h.id) ? "on" : ""}" onclick="toggleHabit('${k}','${h.id}')"><svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <span style="font-weight:600;flex:1">${esc(h.name)}</span>
      <span class="streak">${streak(h.id)}🔥</span>
    </div>`).join("");
  renderJournalEditor(viewDate);
  renderJournalList(viewDate);
}

function fmtJournalDate(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
// Plain-text preview for the entries list — journal entries are stored
// as HTML now (rich text), and showing raw HTML tags in a one-line
// snippet would look broken, so this is read-only display text, never
// written back anywhere.
function journalSnippet(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  return (tmp.textContent || "").trim();
}
function renderJournalEditor(viewDate) {
  const isToday = viewDate === todayKey();
  document.getElementById("journalEditingLabel").textContent = isToday ? "Today — " + fmtJournalDate(viewDate) : fmtJournalDate(viewDate);
  document.getElementById("journalDatePicker").value = viewDate;
  document.getElementById("journalTodayBtn").style.display = isToday ? "none" : "";
  const quill = mountRichEditor("dayJournal", () => state.journal[viewDate] || "", saveJournal, "How did that day go?");
  if (!quill) return; // Quill's CDN script hasn't finished loading yet — this re-runs on the next render pass
  // mountRichEditor only loads its initial content once (the reused-
  // instance design covers "don't clobber what's being typed" — see
  // rich-text.js), so switching which date is being viewed needs its
  // own explicit content swap here. Guarded so it only fires on an
  // actual date change, not every re-render while typing today's entry.
  if (quill.__journalDate !== viewDate) {
    quill.__journalDate = viewDate;
    quill.setContents([]);
    const html = state.journal[viewDate] || "";
    if (html) quill.clipboard.dangerouslyPasteHTML(html);
  }
}
function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Wraps matches in <mark> for the snippet display. Both the snippet text
// and the query are escaped through the same esc() first, then matched
// against each other post-escaping — keeps this safe (the only literal
// HTML ever inserted is the <mark> tags themselves) without needing a
// separate escaping scheme for the search term.
function highlightSnippet(text, query) {
  const escaped = esc(text);
  if (!query) return escaped;
  const re = new RegExp(escRegex(esc(query)), "ig");
  return escaped.replace(re, m => `<mark>${m}</mark>`);
}
let journalFilterFrom = "", journalFilterTo = "", journalSearchQuery = "";
// Single source of truth for "which dates count right now" — shared by
// the List view, the Calendar view, and Export, so the three can never
// disagree about what's an entry or which filters apply.
function filteredJournalDates() {
  let dates = Object.keys(state.journal).filter(d => (state.journal[d] || "").trim()).sort().reverse();
  if (journalFilterFrom) dates = dates.filter(d => d >= journalFilterFrom);
  if (journalFilterTo) dates = dates.filter(d => d <= journalFilterTo);
  const q = journalSearchQuery.trim().toLowerCase();
  if (q) dates = dates.filter(d => journalSnippet(state.journal[d]).toLowerCase().includes(q));
  return dates;
}
function journalFilterActive() {
  return !!(journalFilterFrom || journalFilterTo || journalSearchQuery.trim());
}

let journalView = null; // "list" | "calendar" — lazily initialized from state.journalViewPref on first render
let journalCalMonth = (() => { const d = new Date(); d.setDate(1); return d; })(); // first-of-month, tracks which month Calendar view is showing
export function setJournalView(v) {
  journalView = v;
  state.journalViewPref = v;
  persist(false);
  const sw = document.getElementById("journalViewSwitch");
  if (sw) sw.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  renderJournalList(currentJournalDate || todayKey());
}
export function journalCalPrevMonth() { journalCalMonth.setMonth(journalCalMonth.getMonth() - 1); renderJournalList(currentJournalDate || todayKey()); }
export function journalCalNextMonth() { journalCalMonth.setMonth(journalCalMonth.getMonth() + 1); renderJournalList(currentJournalDate || todayKey()); }
export function journalCalToday() {
  const d = new Date(); d.setDate(1); journalCalMonth = d;
  renderJournalList(currentJournalDate || todayKey());
}

// Month grid marking every date that has an entry. Same "flat array of
// slots, chunked into rows of 7" construction the Tasks calendar uses
// (see renderCalendarView in tasks.js) rather than relying on a single
// CSS grid to auto-wrap ~35 cells at exactly the 7-column boundary.
function renderJournalCalendar(dates, viewDate) {
  const has = new Set(dates);
  const year = journalCalMonth.getFullYear(), month = journalCalMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = journalCalMonth.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const todayStr = todayKey();

  const slots = [];
  for (let i = 0; i < firstWeekday; i++) slots.push(null);
  for (let d = 1; d <= daysInMonth; d++) slots.push(d);
  while (slots.length % 7 !== 0) slots.push(null);

  const cellHtml = d => {
    if (d === null) return `<div class="j-cal-cell j-cal-empty"></div>`;
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const hasEntry = has.has(dateStr);
    const cls = ["j-cal-cell",
      hasEntry ? "has-entry" : "",
      dateStr === todayStr ? "is-today" : "",
      dateStr === viewDate ? "is-active" : ""].filter(Boolean).join(" ");
    // Every day is clickable, entry or not — clicking an empty one opens
    // that date in the editor ready to write, which is the natural way
    // to backfill a missed day.
    const title = hasEntry ? `${fmtJournalDate(dateStr)} — ${journalSnippet(state.journal[dateStr]).slice(0, 80)}` : `${fmtJournalDate(dateStr)} — no entry yet`;
    return `<button class="${cls}" onclick="selectJournalDate('${dateStr}')" title="${esc(title)}">
      <span class="j-cal-daynum">${d}</span>${hasEntry ? `<span class="j-cal-dot"></span>` : ""}</button>`;
  };

  let weeks = "";
  for (let w = 0; w < slots.length; w += 7) {
    weeks += `<div class="j-cal-week">${slots.slice(w, w + 7).map(cellHtml).join("")}</div>`;
  }
  const monthCount = dates.filter(d => d.startsWith(`${year}-${String(month + 1).padStart(2, "0")}`)).length;
  return `
    <div class="j-cal">
      <div class="j-cal-head">
        <button class="btn btn-ghost" onclick="journalCalPrevMonth()" aria-label="Previous month">‹</button>
        <div class="j-cal-month">${monthLabel}</div>
        <button class="btn btn-ghost" onclick="journalCalNextMonth()" aria-label="Next month">›</button>
        <button class="btn btn-ghost" onclick="journalCalToday()">Today</button>
      </div>
      <div class="j-cal-weekdays"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div>
      <div class="j-cal-grid">${weeks}</div>
      <p class="hint j-cal-legend"><span class="j-cal-dot"></span> has an entry — ${monthCount} this month${journalFilterActive() ? " (matching the current filter)" : ""}</p>
    </div>`;
}

function renderJournalList(viewDate) {
  const box = document.getElementById("journalList");
  if (!box) return;
  if (journalView === null) {
    journalView = state.journalViewPref || "list";
    const sw = document.getElementById("journalViewSwitch");
    if (sw) sw.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === journalView));
  }
  const dates = filteredJournalDates();
  if (journalView === "calendar") { box.innerHTML = renderJournalCalendar(dates, viewDate); return; }
  box.innerHTML = dates.map(d => `
    <button class="journal-list-item ${d === viewDate ? "active" : ""}" onclick="selectJournalDate('${d}')">
      <span class="jd-date">${fmtJournalDate(d)}</span>
      <span class="jd-snip">${highlightSnippet(journalSnippet(state.journal[d]), journalSearchQuery.trim())}</span>
    </button>`).join("") || `<p class="hint">${journalFilterActive() ? "No entries match." : "Past entries will appear here."}</p>`;
}
export function applyJournalFilter() {
  journalFilterFrom = document.getElementById("journalFilterFrom").value;
  journalFilterTo = document.getElementById("journalFilterTo").value;
  journalSearchQuery = document.getElementById("journalSearchInput").value;
  document.getElementById("journalFilterClearBtn").style.display = (journalFilterFrom || journalFilterTo || journalSearchQuery) ? "" : "none";
  renderJournalList(currentJournalDate || todayKey());
}
export function clearJournalFilter() {
  journalFilterFrom = journalFilterTo = journalSearchQuery = "";
  document.getElementById("journalFilterFrom").value = "";
  document.getElementById("journalFilterTo").value = "";
  document.getElementById("journalSearchInput").value = "";
  document.getElementById("journalFilterClearBtn").style.display = "none";
  renderJournalList(currentJournalDate || todayKey());
}
export function selectJournalDate(d) {
  currentJournalDate = d;
  renderJournalEditor(d);
  renderJournalList(d);
}
export function journalGoToday() { selectJournalDate(todayKey()); }

// Rich-text HTML -> readable plain text for export. Textwise this is
// journalSnippet's cousin, but that one deliberately flattens everything
// to a single line for a list preview; this keeps paragraph/line breaks
// so a multi-paragraph entry doesn't get squashed into a wall of text.
function journalHtmlToText(html) {
  if (!html) return "";
  const withBreaks = (html)
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const tmp = document.createElement("div");
  tmp.innerHTML = withBreaks;
  return (tmp.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}
const JOURNAL_SEP = "────────────────────────────────────";
export function exportJournalRange() {
  const dates = filteredJournalDates(); // same set, same "most recent first" order as the list/calendar on screen
  const q = journalSearchQuery.trim().toLowerCase();
  if (!dates.length) { toast("No entries match the current filter to export"); return; }

  const rangeLabel = journalFilterFrom || journalFilterTo
    ? `${journalFilterFrom ? fmtJournalDate(journalFilterFrom) : "the beginning"} to ${journalFilterTo ? fmtJournalDate(journalFilterTo) : "today"}`
    : "all entries";
  const searchNote = q ? ` — matching "${journalSearchQuery.trim()}"` : "";
  const header = `Journal export — ${rangeLabel}${searchNote}\nGenerated ${fmtJournalDate(todayKey())}\n`;
  const body = dates.map(d => `${JOURNAL_SEP}\n${fmtJournalDate(d)}\n${JOURNAL_SEP}\n${journalHtmlToText(state.journal[d])}`).join("\n\n\n");
  const text = header + "\n\n" + body + "\n";

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fileRange = journalFilterFrom || journalFilterTo ? `${journalFilterFrom || "start"}_to_${journalFilterTo || "today"}` : "all";
  a.href = url;
  a.download = `journal_${fileRange}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(`Exported ${dates.length} ${dates.length === 1 ? "entry" : "entries"}`);
}

let journalTimer = null;
export function saveJournal(html) {
  const d = currentJournalDate || todayKey();
  state.journal[d] = html;
  clearTimeout(journalTimer);
  journalTimer = setTimeout(() => { persist(); renderJournalList(d); }, 800);
}
