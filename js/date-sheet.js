/* ============================================================
   Date sheet
   ============================================================
   Replaces the browser's native date picker on task cards with the
   panel the Todoist reference uses: the shortcuts people actually reach
   for (Today, Tomorrow, This weekend, Next week, No date) above a month
   calendar, rather than a bare spinner that makes "tomorrow" a
   three-step operation.

   It drives an existing hidden <input type="date"> by id and dispatches
   the same "change" event a person picking a date by hand would fire.
   That is deliberate: every board already wires its own save path onto
   that input — editTaskMeta(), editProjectTask(), editPwProjectTask() —
   so this file never needs to know which board it is serving, and the
   three open*DatePicker() functions become one line each. It is the
   same contract js/date-shortcuts.js established for its small popover.

   No time-of-day or repeat row, though the reference has both: a task
   here stores a plain YYYY-MM-DD and nothing else, so those controls
   would have nowhere to write. Adding them is a data-model change, not
   a UI one.
   ============================================================ */

const SHEET_ID = "dateSheet";
let inputId = null;      // the hidden input this sheet is currently driving
let viewYear = 0, viewMonth = 0;

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function ymd(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
    "-" + String(d.getDate()).padStart(2, "0");
}
function parseYmd(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return isNaN(dt) ? null : dt;
}
function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }

/* Saturday of the current week; if today IS the weekend, the coming one. */
function thisWeekend(today) {
  const delta = (6 - today.getDay() + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}
/* Next Monday, matching the reference's "Next week". */
function nextWeek(today) {
  const delta = (1 - today.getDay() + 7) % 7;
  return addDays(today, delta === 0 ? 7 : delta);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shell() {
  let el = document.getElementById(SHEET_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = SHEET_ID;
  el.className = "date-sheet-bg";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Choose a date");
  /* Clicking the backdrop closes; clicking the panel must not. */
  el.addEventListener("click", (e) => { if (e.target === el) closeDateSheet(); });
  document.body.appendChild(el);
  return el;
}

function presetRow(icon, label, hint, value) {
  return `<button type="button" class="ds-row" data-date="${value}">
      <span class="ds-row-ico" aria-hidden="true">${icon}</span>
      <span class="ds-row-label">${esc(label)}</span>
      <span class="ds-row-hint">${esc(hint)}</span>
    </button>`;
}

function calendarHtml(selected) {
  const first = new Date(viewYear, viewMonth, 1);
  const lead = first.getDay();                       // Sun-first, matching DAY above
  const days = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayKey = ymd(new Date());
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="ds-cell ds-cell-empty"></span>');
  for (let d = 1; d <= days; d++) {
    const key = ymd(new Date(viewYear, viewMonth, d));
    const cls = ["ds-cell"];
    if (key === todayKey) cls.push("is-today");
    if (key === selected) cls.push("is-selected");
    cells.push(`<button type="button" class="${cls.join(" ")}" data-date="${key}">${d}</button>`);
  }
  return `
    <div class="ds-cal">
      <div class="ds-cal-head">
        <button type="button" class="ds-nav" data-nav="-1" aria-label="Previous month">‹</button>
        <span class="ds-cal-title">${MONTH[viewMonth]} ${viewYear}</span>
        <button type="button" class="ds-nav" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="ds-grid ds-grid-dow">${DAY.map(d => `<span class="ds-dow">${d[0]}</span>`).join("")}</div>
      <div class="ds-grid">${cells.join("")}</div>
    </div>`;
}

function render() {
  const input = document.getElementById(inputId);
  if (!input) return closeDateSheet();
  const selected = input.value || "";
  const today = new Date();
  const sel = parseYmd(selected);

  const el = shell();
  el.innerHTML = `
    <div class="date-sheet" role="document">
      <div class="ds-grip" aria-hidden="true"></div>
      <div class="ds-head">
        <h3 class="ds-title">Date</h3>
        <button type="button" class="ds-close" data-close="1" aria-label="Close">✕</button>
      </div>
      ${sel ? `<div class="ds-current">🗓 ${esc(sel.toDateString().slice(4))}</div>` : ""}
      <div class="ds-presets">
        ${presetRow("📅", "Today", DAY[today.getDay()], ymd(today))}
        ${presetRow("🌤", "Tomorrow", DAY[addDays(today, 1).getDay()], ymd(addDays(today, 1)))}
        ${presetRow("🛋", "This weekend", "Sat " + thisWeekend(today).getDate(), ymd(thisWeekend(today)))}
        ${presetRow("➡", "Next week", "Mon " + nextWeek(today).getDate(), ymd(nextWeek(today)))}
        ${presetRow("🚫", "No date", "", "")}
      </div>
      ${calendarHtml(selected)}
    </div>`;

  el.querySelectorAll("[data-date]").forEach(b =>
    b.addEventListener("click", () => commit(b.getAttribute("data-date"))));
  el.querySelectorAll("[data-nav]").forEach(b =>
    b.addEventListener("click", () => {
      const step = Number(b.getAttribute("data-nav"));
      viewMonth += step;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      render();
    }));
  const close = el.querySelector("[data-close]");
  if (close) close.addEventListener("click", closeDateSheet);
}

/* The single point where anything is saved: set the value, fire change,
   and let whichever handler the input already carries do the work. */
function commit(value) {
  const input = document.getElementById(inputId);
  if (input) {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  closeDateSheet();
}

export function openDateSheet(id) {
  const input = document.getElementById(id);
  /* No input, nothing to drive. Bail before mounting anything, or the
     rAF below would flip an empty shell to .open and put a bare backdrop
     over the page with no way to dismiss it. */
  if (!input) return;
  inputId = id;
  const start = parseYmd(input.value) || new Date();
  viewYear = start.getFullYear();
  viewMonth = start.getMonth();
  render();
  requestAnimationFrame(() => shell().classList.add("open"));
  document.addEventListener("keydown", onKey);
}

export function closeDateSheet() {
  const el = document.getElementById(SHEET_ID);
  if (el) { el.classList.remove("open"); el.innerHTML = ""; }
  inputId = null;
  document.removeEventListener("keydown", onKey);
}

function onKey(e) { if (e.key === "Escape") closeDateSheet(); }
