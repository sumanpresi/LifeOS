/* Links, news feeds, quotes, meditation, Day Of page + journal. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';
import { toast } from './ui.js';
import { moveToTrash } from './trash.js';
import { isLogged, streak } from './habits.js';

/* ---------- important links ---------- */
export function renderLinks() {
  document.getElementById("linksGrid").innerHTML = state.links.map(l => `
    <div class="link-card">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <div class="desc">${esc(l.desc || l.url)}</div>
      <button class="del" onclick="delLink('${l.id}')">✕</button>
    </div>`).join("") || `<p class="hint">Save the links you reach for every day.</p>`;
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
  document.getElementById("catMedSub").textContent = today ? `${today} min done today 🌿` : "Breathe for a while.";
}

/* ---------- Day Of page ---------- */
let currentJournalDate = null; // null = today (re-evaluated each render so it stays "today" across midnight)

export function renderDayOf() {
  const k = todayKey();
  const viewDate = currentJournalDate || k;
  document.getElementById("dayTasks").innerHTML = state.tasks.map((t, i) => `
    <div class="task-row ${t.done ? "done" : ""}">
      <button class="chk ${t.done ? "on" : ""}" onclick="toggleTask('${t.id}')"><svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <span class="task-num">${i + 1}</span>
      <input type="text" value="${esc(t.text)}" onchange="editTask('${t.id}',this.value)">
    </div>`).join("") || `<p class="hint">Nothing planned — add tasks on the Overview page.</p>`;
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
function renderJournalEditor(viewDate) {
  const isToday = viewDate === todayKey();
  document.getElementById("journalEditingLabel").textContent = isToday ? "Today — " + fmtJournalDate(viewDate) : fmtJournalDate(viewDate);
  document.getElementById("journalDatePicker").value = viewDate;
  document.getElementById("journalTodayBtn").style.display = isToday ? "none" : "";
  const j = document.getElementById("dayJournal");
  if (document.activeElement !== j) j.value = state.journal[viewDate] || "";
}
function renderJournalList(viewDate) {
  const box = document.getElementById("journalList");
  if (!box) return;
  const dates = Object.keys(state.journal).filter(d => (state.journal[d] || "").trim()).sort().reverse();
  box.innerHTML = dates.map(d => `
    <button class="journal-list-item ${d === viewDate ? "active" : ""}" onclick="selectJournalDate('${d}')">
      <span class="jd-date">${fmtJournalDate(d)}</span>
      <span class="jd-snip">${esc((state.journal[d] || "").slice(0, 60))}</span>
    </button>`).join("") || `<p class="hint">Past entries will appear here.</p>`;
}
export function selectJournalDate(d) {
  currentJournalDate = d;
  renderJournalEditor(d);
  renderJournalList(d);
}
export function journalGoToday() { selectJournalDate(todayKey()); }

let journalTimer = null;
export function saveJournal(v) {
  const d = currentJournalDate || todayKey();
  state.journal[d] = v;
  clearTimeout(journalTimer);
  journalTimer = setTimeout(() => { persist(); renderJournalList(d); }, 800);
}
