/* Habit tracking: week grid, calendar month view, 6-week trend, streaks, donut. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';

let weekOffset = 0;
let monthCursor = new Date(); // which month the calendar view is showing
let calendarHabitId = null;   // which habit the calendar view focuses on

export function weekDates(offset) {
  const now = new Date(); const day = (now.getDay() + 6) % 7; // Monday start
  const mon = new Date(now); mon.setDate(now.getDate() - day + offset * 7);
  return [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
}
export function isLogged(dateKey, habitId) {
  return !!(state.habitLog[dateKey] && state.habitLog[dateKey][habitId]);
}
export function toggleHabit(dateKey, habitId) {
  state.habitLog[dateKey] = state.habitLog[dateKey] || {};
  state.habitLog[dateKey][habitId] = !state.habitLog[dateKey][habitId];
  if (!state.habitLog[dateKey][habitId]) delete state.habitLog[dateKey][habitId];
  persist(); rerender();
}
export function streak(habitId) {
  let s = 0; const d = new Date();
  if (!isLogged(todayKey(d), habitId)) d.setDate(d.getDate() - 1);
  while (isLogged(todayKey(d), habitId)) { s++; d.setDate(d.getDate() - 1); }
  return s;
}

export function renderHabits() {
  const days = weekDates(weekOffset);
  const tKey = todayKey();
  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  const fut = d => todayKey(d) > tKey;
  let html = `<tr><th>Habit</th>${days.map((d, i) =>
    `<th class="${todayKey(d) === tKey ? "today-col" : ""}">${dayNames[i]}<br><span style="font-weight:600">${d.getDate()}</span></th>`).join("")}<th>Streak</th></tr>`;
  html += state.habits.map(h => `
    <tr>
      <td><span class="habit-name">${esc(h.name)}<button class="del" onclick="delHabit('${h.id}')">✕</button></span></td>
      ${days.map(d => { const k = todayKey(d); return `<td class="${k === tKey ? "today-col" : ""}">
        <button class="chk mini ${isLogged(k, h.id) ? "on" : ""}" ${fut(d) ? "disabled" : ""}
          onclick="toggleHabit('${k}','${h.id}')" aria-label="${esc(h.name)} ${k}">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button></td>`; }).join("")}
      <td><span class="streak">${streak(h.id)}🔥</span></td>
    </tr>`).join("");
  document.getElementById("habitTable").innerHTML = html;
  const fmt = d => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  document.getElementById("weekLabel").textContent = `${fmt(days[0])} – ${fmt(days[6])}`;
  renderTrendView(); renderCalendarView(); renderDonut();
}

function renderTrendView() {
  /* Last 6 weeks, % completion per habit — a quick trend, not a calendar. */
  let rows = `<tr><th>Habit</th>${[...Array(6)].map((_, i) => {
    const w = weekDates(-(5 - i)); return `<th>${w[0].getDate()}/${w[0].getMonth() + 1}</th>`; }).join("")}</tr>`;
  rows += state.habits.map(h => {
    const cells = [...Array(6)].map((_, i) => {
      const w = weekDates(-(5 - i)); const tKey = todayKey();
      const elig = w.filter(d => todayKey(d) <= tKey).length;
      const done = w.filter(d => isLogged(todayKey(d), h.id)).length;
      const pct = elig ? Math.round(done / elig * 100) : 0;
      return `<td><div class="bar" style="margin:0"><span style="width:${pct}%"></span></div><span class="streak">${pct}%</span></td>`;
    }).join("");
    return `<tr><td>${esc(h.name)}</td>${cells}</tr>`;
  }).join("");
  document.getElementById("habitMonthTable").innerHTML = rows;
}

/* ---------- true calendar month view (one habit at a time) ---------- */
function renderCalendarView() {
  const sel = document.getElementById("calHabitSelect");
  if (!sel) return;
  if (!calendarHabitId || !state.habits.some(h => h.id === calendarHabitId)) {
    calendarHabitId = state.habits[0] ? state.habits[0].id : null;
  }
  sel.innerHTML = state.habits.map(h =>
    `<option value="${h.id}" ${h.id === calendarHabitId ? "selected" : ""}>${esc(h.name)}</option>`).join("")
    || `<option value="">Add a habit first</option>`;

  const label = document.getElementById("calMonthLabel");
  const grid = document.getElementById("calGrid");
  if (!grid) return;
  if (label) label.textContent = monthCursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  if (!calendarHabitId) { grid.innerHTML = `<p class="hint">Add a habit to see its calendar.</p>`; return; }

  const year = monthCursor.getFullYear(), month = monthCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday-start grid
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const tKey = todayKey();

  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  let html = `<div class="cal-dow">${dayNames.map(d => `<div>${d}</div>`).join("")}</div><div class="cal-days">`;
  for (let i = 0; i < startOffset; i++) html += `<div class="cal-cell empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const k = todayKey(d);
    const future = k > tKey;
    const done = isLogged(k, calendarHabitId);
    html += `<button class="cal-cell ${done ? "done" : ""} ${k === tKey ? "today" : ""}" ${future ? "disabled" : ""}
      onclick="toggleHabit('${k}','${calendarHabitId}')">${day}</button>`;
  }
  html += `</div>`;
  grid.innerHTML = html;

  let doneCount = 0, eligCount = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const k = todayKey(new Date(year, month, day));
    if (k <= tKey) { eligCount++; if (isLogged(k, calendarHabitId)) doneCount++; }
  }
  const summary = document.getElementById("calSummary");
  if (summary) summary.textContent = eligCount ? `${doneCount} of ${eligCount} days this month` : "";
}
export function setCalendarHabit(id) { calendarHabitId = id; renderCalendarView(); }
export function shiftCalendarMonth(n) {
  monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + n, 1);
  renderCalendarView();
}

function renderDonut() {
  const tKey = todayKey();
  const done = state.habits.filter(h => isLogged(tKey, h.id)).length;
  const total = state.habits.length || 1;
  const pct = Math.round(done / total * 100);
  const C = 2 * Math.PI * 50;
  document.getElementById("donutVal").setAttribute("stroke-dasharray", `${C * pct / 100} ${C}`);
  document.getElementById("donutPct").textContent = pct + "%";
  document.getElementById("donutLegend").innerHTML =
    `<div class="row"><span class="swatch" style="background:var(--accent)"></span>Done today · ${done}</div>
     <div class="row"><span class="swatch" style="background:var(--line)"></span>Remaining · ${total - done}</div>
     <div class="row hint" style="font-weight:600">Tick each habit as you finish it.</div>`;
}

export function setHabitView(v) {
  document.getElementById("segWeek").classList.toggle("on", v === "week");
  document.getElementById("segCalendar").classList.toggle("on", v === "calendar");
  document.getElementById("segTrend").classList.toggle("on", v === "trend");
  document.getElementById("habitWeekWrap").style.display = v === "week" ? "" : "none";
  document.getElementById("habitCalendarWrap").style.display = v === "calendar" ? "" : "none";
  document.getElementById("habitMonthWrap").style.display = v === "trend" ? "" : "none";
}
export function shiftWeek(n) {
  weekOffset += n; if (weekOffset > 0) weekOffset = 0;
  renderHabits();
}
export function addHabit() {
  const el = document.getElementById("newHabit"); const v = el.value.trim(); if (!v) return;
  state.habits.push({ id: uid(), name: v }); el.value = "";
  persist(); rerender();
}
export function delHabit(id) {
  if (!confirm("Remove this habit and its history from view?")) return;
  state.habits = state.habits.filter(x => x.id !== id);
  persist(); rerender();
}
