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
let journalFilterFrom = "", journalFilterTo = "";
function renderJournalList(viewDate) {
  const box = document.getElementById("journalList");
  if (!box) return;
  let dates = Object.keys(state.journal).filter(d => (state.journal[d] || "").trim()).sort().reverse();
  if (journalFilterFrom) dates = dates.filter(d => d >= journalFilterFrom);
  if (journalFilterTo) dates = dates.filter(d => d <= journalFilterTo);
  const filterActive = journalFilterFrom || journalFilterTo;
  box.innerHTML = dates.map(d => `
    <button class="journal-list-item ${d === viewDate ? "active" : ""}" onclick="selectJournalDate('${d}')">
      <span class="jd-date">${fmtJournalDate(d)}</span>
      <span class="jd-snip">${esc(journalSnippet(state.journal[d]))}</span>
    </button>`).join("") || `<p class="hint">${filterActive ? "No entries in that date range." : "Past entries will appear here."}</p>`;
}
export function applyJournalFilter() {
  journalFilterFrom = document.getElementById("journalFilterFrom").value;
  journalFilterTo = document.getElementById("journalFilterTo").value;
  document.getElementById("journalFilterClearBtn").style.display = (journalFilterFrom || journalFilterTo) ? "" : "none";
  renderJournalList(currentJournalDate || todayKey());
}
export function clearJournalFilter() {
  journalFilterFrom = journalFilterTo = "";
  document.getElementById("journalFilterFrom").value = "";
  document.getElementById("journalFilterTo").value = "";
  document.getElementById("journalFilterClearBtn").style.display = "none";
  renderJournalList(currentJournalDate || todayKey());
}
export function selectJournalDate(d) {
  currentJournalDate = d;
  renderJournalEditor(d);
  renderJournalList(d);
}
export function journalGoToday() { selectJournalDate(todayKey()); }

let journalTimer = null;
export function saveJournal(html) {
  const d = currentJournalDate || todayKey();
  state.journal[d] = html;
  clearTimeout(journalTimer);
  journalTimer = setTimeout(() => { persist(); renderJournalList(d); }, 800);
}
