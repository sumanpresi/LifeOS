/* Links, news feeds, quotes, meditation, Day Of page + journal. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';
import { toast } from './ui.js';
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
export function delLink(id) { state.links = state.links.filter(x => x.id !== id); persist(); rerender(); }

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
export function delFeed(id) { state.feeds = state.feeds.filter(x => x.id !== id); persist(); rerender(); }

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
export function renderDayOf() {
  const k = todayKey();
  document.getElementById("dayJournalDate").textContent =
    new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long" });
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
  const j = document.getElementById("dayJournal");
  if (document.activeElement !== j) j.value = state.journal[k] || "";
}
let journalTimer = null;
export function saveJournal(v) {
  state.journal[todayKey()] = v;
  clearTimeout(journalTimer);
  journalTimer = setTimeout(() => persist(), 800);
}
