/* A calendar popover of quick date presets + a month grid, attached to any
   existing <input type="date">. This is UI-only: it sets the input's value
   and dispatches the same "change" event a person picking a date manually
   would trigger, so it always runs through whatever save logic that
   specific input already had — editTaskMeta(), editProjectTask(),
   editPwProjectTask(), or anything else — without this module needing to
   know or duplicate that logic.

   ---- why this is built in JS and attached to <body> ----

   The trigger button lives inside a scrollable card list (a GSI or
   Personal task row, which can itself be sitting inside the Eisenhower
   matrix's .eis-q-body). A popover positioned *inside* that card used to
   be clipped to, or painted underneath, whatever card came after it in the
   DOM: every task row has its own `position:relative` (for its own
   controls), and among same-level positioned siblings with no explicit
   z-index, a later sibling in the DOM paints ON TOP of an earlier one's
   overflowing children — which is exactly why the popover looked "covered
   by the tasks below it" until the pointer moved and something repainted.

   This is the same class of bug .eis-move-menu already solved in
   eisenhower.js: build the popover fresh on open, append it straight to
   <body>, and position it with a measured getBoundingClientRect() rather
   than CSS positioning inherited from a deeply-nested ancestor. That
   sidesteps the scroller and the paint-order issue entirely instead of
   fighting it with a bigger z-index. */

let openPop = null; // { el, input, btn, month: Date, settling }

function fmt(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function parseVal(v) {
  if (!v) return null;
  const parts = String(v).split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function sameDay(a, b) {
  return !!a && !!b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}
function fmtPill(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function commit(value) {
  if (!openPop) return;
  const { input } = openPop;
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  closeDatePopover();
}

function quickRow(label, icon, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "date-pop-quick";
  b.innerHTML = `<span class="date-pop-quick-ico" aria-hidden="true">${icon}</span>${label}`;
  b.addEventListener("click", onClick);
  return b;
}

function buildCalendar(pop) {
  const grid = pop.el.querySelector(".date-pop-grid");
  const label = pop.el.querySelector(".date-pop-month-label");
  const month = pop.month;
  label.textContent = `${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}`;
  grid.innerHTML = "";

  WEEKDAYS.forEach(w => {
    const h = document.createElement("div");
    h.className = "date-pop-wd";
    h.textContent = w;
    grid.appendChild(h);
  });

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // Monday-first week: getDay() is 0=Sun..6=Sat, so shift Monday to 0.
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = new Date();
  const selected = parseVal(pop.input.value);

  for (let i = 0; i < lead; i++) grid.appendChild(document.createElement("div"));
  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = new Date(month.getFullYear(), month.getMonth(), day);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "date-pop-day";
    if (sameDay(cellDate, today)) btn.classList.add("is-today");
    if (selected && sameDay(cellDate, selected)) btn.classList.add("is-selected");
    btn.textContent = String(day);
    btn.setAttribute("aria-label", cellDate.toLocaleDateString());
    btn.addEventListener("click", () => commit(fmt(cellDate)));
    grid.appendChild(btn);
  }
}

function place(el, btn) {
  const r = btn.getBoundingClientRect();
  const m = 8;
  const { offsetWidth: w, offsetHeight: h } = el;
  // Below the trigger by default; above it when there isn't room below —
  // the same rule .eis-move-menu uses for a card near the bottom of a list.
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - m) top = Math.max(m, r.top - 6 - h);
  let left = Math.min(Math.max(m, r.left), window.innerWidth - w - m);
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}

export function closeDatePopover() {
  if (!openPop) return;
  openPop.btn?.setAttribute("aria-expanded", "false");
  openPop.el.remove();
  openPop = null;
}

export function toggleDatePopover(evt, inputId) {
  evt.stopPropagation();
  const btn = (evt.currentTarget || evt.target.closest("button"));
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  if (openPop && openPop.input === input) { closeDatePopover(); return; }
  closeDatePopover();

  const el = document.createElement("div");
  el.className = "date-popover open";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Choose a date");
  el.innerHTML = `
    <div class="date-pop-head">
      <span class="date-pop-title">Date</span>
      <button type="button" class="date-pop-close" aria-label="Close">&times;</button>
    </div>
    <div class="date-pop-quicks"></div>
    <div class="date-pop-cal">
      <div class="date-pop-cal-head">
        <button type="button" class="date-pop-nav date-pop-prev" aria-label="Previous month">&lsaquo;</button>
        <span class="date-pop-month-label"></span>
        <button type="button" class="date-pop-nav date-pop-next" aria-label="Next month">&rsaquo;</button>
      </div>
      <div class="date-pop-grid"></div>
    </div>`;

  const initial = parseVal(input.value) || new Date();
  openPop = { el, input, btn, month: new Date(initial.getFullYear(), initial.getMonth(), 1), settling: true };

  const quicks = el.querySelector(".date-pop-quicks");
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const weekend = new Date();
  const wd = weekend.getDay(); // 0=Sun..6=Sat
  weekend.setDate(weekend.getDate() + (wd === 6 ? 0 : wd === 0 ? 6 : 6 - wd)); // coming Saturday
  const nextweek = new Date(); nextweek.setDate(nextweek.getDate() + 7);

  quicks.appendChild(quickRow("Today", "📅", () => commit(fmt(today))));
  quicks.appendChild(quickRow("Tomorrow", "🌤️", () => commit(fmt(tomorrow))));
  quicks.appendChild(quickRow("This weekend", "🛋️", () => commit(fmt(weekend))));
  quicks.appendChild(quickRow("Next week", "➡️", () => commit(fmt(nextweek))));
  quicks.appendChild(quickRow("No date", "🚫", () => commit("")));

  el.querySelector(".date-pop-close").addEventListener("click", closeDatePopover);
  el.querySelector(".date-pop-prev").addEventListener("click", () => {
    openPop.month = new Date(openPop.month.getFullYear(), openPop.month.getMonth() - 1, 1);
    buildCalendar(openPop);
  });
  el.querySelector(".date-pop-next").addEventListener("click", () => {
    openPop.month = new Date(openPop.month.getFullYear(), openPop.month.getMonth() + 1, 1);
    buildCalendar(openPop);
  });

  document.body.appendChild(el);
  buildCalendar(openPop);
  place(el, btn);
  btn.setAttribute("aria-expanded", "true");

  // Same belt-and-braces as .eis-move-menu: ignore the scroll that opening
  // itself can cause (focus/layout settling) for one frame, then treat any
  // further scroll as a request to close.
  requestAnimationFrame(() => { if (openPop) openPop.settling = false; });
}

// Kept for backward compatibility with any inline handler still referring
// to it; the popover built above no longer uses it internally.
export function setQuickDate(inputId, which) {
  const input = document.getElementById(inputId);
  if (!input) return;
  let value = "";
  if (which !== "clear") {
    const d = new Date();
    if (which === "tomorrow") d.setDate(d.getDate() + 1);
    if (which === "nextweek") d.setDate(d.getDate() + 7);
    value = fmt(d);
  }
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  closeDatePopover();
}

document.addEventListener("pointerdown", (e) => {
  if (!openPop) return;
  if (e.target.closest && (e.target.closest(".date-popover") || e.target.closest(".date-popover-trigger"))) return;
  closeDatePopover();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDatePopover(); });
window.addEventListener("scroll", () => {
  if (openPop && openPop.settling) return; // the scroll that opening caused
  closeDatePopover();
}, true);
window.addEventListener("resize", closeDatePopover);
