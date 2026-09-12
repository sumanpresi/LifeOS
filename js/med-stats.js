/* Medicine insights — what the dose log adds up to.

   The Dose log answers "what did I take". This answers "how much, when, and
   is it changing". Three questions, three views, all derived — nothing here
   is stored, so a medicine added today appears the moment it is ticked and
   no list anywhere needs updating.

   The strength lives inside the medicine NAME ("Lamitor OD 100", "Librax
   1/2"), which is the only place the person ever types it. Rather than ask
   them to re-enter it in a structured field, it is parsed off the end of
   the name: everything before the trailing number is the base medicine,
   the number is the strength. Fractions count — 1/2 and 1/4 are strengths
   of the same drug in exactly the way 25 and 50 are.

   Bases are matched case-insensitively on purpose. This account holds both
   "lamitor OD 25" and "Lamitor OD 50"; grouped by the raw string they are
   two unrelated medicines, and the dose escalation between them disappears. */
import { state, esc, todayKey } from './state.js?v=202609042200';
import { weekDates } from './habits.js?v=202609042200';
import { medicineName } from './health.js?v=202609042200';

const SLOTS = [["morning", "Morning"], ["afternoon", "Afternoon"], ["night", "Night"]];
/* One colour per slot, fixed hex rather than a theme variable: these are
   series colours inside an SVG, and they have to mean the same thing in
   light and dark mode. Each is legible on both. */
const SLOT_COLOR = { morning: "#2a78d6", afternoon: "#eda100", night: "#6250d6" };

let statsRange = "week";   // "week" | "month"
let statsOffset = 0;       // 0 = current period, negative = earlier

/* ---------- name parsing ---------- */
const STRENGTH = /^(?<base>.*?)[\s-]*(?<s>\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s*(?<unit>mg|ml|mcg|g)?\s*$/i;
export function parseMedName(name) {
  const m = STRENGTH.exec(String(name || "").trim());
  if (!m || !m.groups.base.trim()) return { base: String(name || "").trim(), strength: "", value: null };
  const raw = m.groups.s.replace(/\s+/g, "");
  const value = raw.includes("/")
    ? Number(raw.split("/")[0]) / Number(raw.split("/")[1])
    : Number(raw);
  return { base: m.groups.base.trim(), strength: raw, value: Number.isFinite(value) ? value : null };
}

/* ---------- the period on screen ---------- */
function fmtDay(d) { return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
function periodDays() {
  if (statsRange === "week") {
    const days = weekDates(statsOffset);
    return { days, label: `${fmtDay(days[0])} – ${fmtDay(days[6])}` };
  }
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + statsOffset, 1);
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const days = [...Array(count)].map((_, i) => new Date(first.getFullYear(), first.getMonth(), i + 1));
  return { days, label: first.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
}

/* ---------- aggregation ---------- */
function collect(days) {
  const wanted = new Set(days.map(todayKey));
  const perMed = new Map();   // medId -> {morning, afternoon, night, total}
  const perDay = days.map(d => ({ d, key: todayKey(d), morning: 0, afternoon: 0, night: 0, total: 0 }));
  const dayByKey = new Map(perDay.map(p => [p.key, p]));
  let total = 0;

  Object.entries(state.health.medicineLog || {}).forEach(([key, entry]) => {
    if (!wanted.has(key) || !entry) return;
    Object.entries(entry).forEach(([medId, slots]) => {
      SLOTS.forEach(([slot]) => {
        if (!slots || !slots[slot]) return;
        const row = perMed.get(medId) || { morning: 0, afternoon: 0, night: 0, total: 0 };
        row[slot]++; row.total++;
        perMed.set(medId, row);
        dayByKey.get(key)[slot]++;
        dayByKey.get(key).total++;
        total++;
      });
    });
  });
  const daysCovered = perDay.filter(p => p.total > 0).length;
  return { perMed, perDay, total, daysCovered };
}

/* ---------- SVG helpers ----------
   Hand-built rather than a charting library: LifeOS ships no chart
   dependency, and these are two shapes and some text. The viewBox is a
   fixed 640 wide with width:100% on the element, so the coordinate space
   stays predictable at any card width. */
function barsSvg(perDay) {
  const max = Math.max(1, ...perDay.map(p => p.total));
  const n = perDay.length;
  const W = 640, H = 150, left = 28, right = 8, top = 10, base = H - 26;
  const span = (W - left - right) / n;
  const bw = Math.max(3, Math.min(26, span - (n > 14 ? 2 : 8)));
  const scale = (base - top) / max;

  let bars = "";
  perDay.forEach((p, i) => {
    const x = left + i * span + (span - bw) / 2;
    let y = base;
    SLOTS.forEach(([slot]) => {
      const h = p[slot] * scale;
      if (h <= 0) return;
      y -= h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${SLOT_COLOR[slot]}"><title>${esc(fmtDay(p.d))} — ${p[slot]} ${slot}</title></rect>`;
    });
  });

  /* Every day gets a label in a week; a month gets one every fifth day, or
     31 labels overlap into a smear. */
  const step = n <= 10 ? 1 : 5;
  let ticks = "";
  perDay.forEach((p, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    const x = left + i * span + span / 2;
    ticks += `<text class="ms-tick" x="${x.toFixed(1)}" y="${base + 16}" text-anchor="middle">${p.d.getDate()}</text>`;
  });

  return `<svg class="ms-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Doses per day, stacked by time of day">
    <line class="ms-axis" x1="${left}" y1="${base}" x2="${W - right}" y2="${base}"/>
    <line class="ms-grid" x1="${left}" y1="${top}" x2="${W - right}" y2="${top}"/>
    <text class="ms-tick" x="${left - 6}" y="${top + 4}" text-anchor="end">${max}</text>
    <text class="ms-tick" x="${left - 6}" y="${base}" text-anchor="end">0</text>
    ${bars}${ticks}
  </svg>`;
}

/* A step chart, not a line: a dose does not ramp between two strengths, it
   is one strength until the day it becomes another. Drawing it as a slope
   would claim days that never happened. */
function titrationSvg(series) {
  const W = 640, H = 110, left = 34, right = 10, top = 14, base = H - 24;
  const xs = series.points.map(p => p.t);
  const t0 = Math.min(...xs), t1 = Math.max(...xs);
  const vs = series.points.map(p => p.value);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const px = t => t1 === t0 ? left : left + ((t - t0) / (t1 - t0)) * (W - left - right);
  const py = v => hi === lo ? (top + base) / 2 : base - ((v - lo) / (hi - lo)) * (base - top);

  let d = "", dots = "";
  series.points.forEach((p, i) => {
    const x = px(p.t), y = py(p.value);
    d += i === 0 ? `M${x.toFixed(1)} ${y.toFixed(1)}` : ` H${x.toFixed(1)} V${y.toFixed(1)}`;
    if (i > 0) dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5" fill="${SLOT_COLOR.morning}"><title>${esc(p.label)} on ${esc(p.date)}</title></circle>`;
  });
  d += ` H${(W - right).toFixed(1)}`;

  const last = series.points[series.points.length - 1];
  const first = series.points[0];
  return `<svg class="ms-chart ms-chart-sm" viewBox="0 0 ${W} ${H}" role="img" aria-label="Strength over time for ${esc(series.base)}">
    <line class="ms-axis" x1="${left}" y1="${base}" x2="${W - right}" y2="${base}"/>
    <text class="ms-tick" x="${left - 6}" y="${py(hi) + 4}" text-anchor="end">${esc(series.hiLabel)}</text>
    <text class="ms-tick" x="${left - 6}" y="${py(lo) + 4}" text-anchor="end">${esc(series.loLabel)}</text>
    <path d="${d}" fill="none" stroke="${SLOT_COLOR.morning}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text class="ms-tick" x="${left}" y="${base + 16}">${esc(first.date)}</text>
    <text class="ms-tick" x="${W - right}" y="${base + 16}" text-anchor="end">${esc(last.date)}</text>
  </svg>`;
}

/* Which strength was being taken on each day, per base medicine, across the
   WHOLE log rather than the selected period — a titration is the shape of
   months, and a one-week window would only ever show a flat line. Only
   bases that have actually changed strength are drawn; a medicine taken at
   one dose forever has nothing to plot. */
function titrationSeries() {
  const byBase = new Map();
  Object.entries(state.health.medicineLog || {}).forEach(([key, entry]) => {
    Object.entries(entry || {}).forEach(([medId, slots]) => {
      if (!SLOTS.some(([s]) => slots && slots[s])) return;
      const { base, strength, value } = parseMedName(medicineName(medId));
      if (value === null) return;
      const k = base.toLowerCase();
      const bucket = byBase.get(k) || { base, days: new Map() };
      const prev = bucket.days.get(key);
      if (!prev || value > prev.value) bucket.days.set(key, { value, strength });
      byBase.set(k, bucket);
    });
  });

  const out = [];
  byBase.forEach(bucket => {
    const dates = [...bucket.days.keys()].sort();
    if (dates.length < 2) return;
    const points = [];
    let last = null;
    dates.forEach(dk => {
      const v = bucket.days.get(dk);
      if (last !== null && v.value === last) return;   // only the changes
      last = v.value;
      points.push({ t: Date.parse(dk), value: v.value, date: dk, label: v.strength });
    });
    if (points.length < 2) return;                     // never changed: nothing to show
    const sorted = [...points].sort((a, b) => a.value - b.value);
    out.push({
      base: bucket.base,
      points,
      loLabel: sorted[0].label,
      hiLabel: sorted[sorted.length - 1].label,
      /* "1/2 → 1/2" is true and useless — it is what a medicine that dipped
         and came back reads as. When the endpoints match, say where it is
         now and how many times it moved instead. */
      caption: points[0].label === points[points.length - 1].label
        ? `now ${points[points.length - 1].label} · ${points.length - 1} change${points.length === 2 ? "" : "s"}`
        : `${points[0].label} → ${points[points.length - 1].label}`
    });
  });
  return out;
}

/* ---------- render ---------- */
export function renderMedStats() {
  const host = document.getElementById("medStatsBody");
  if (!host) return;
  const { days, label } = periodDays();
  const { perMed, perDay, total, daysCovered } = collect(days);

  const lbl = document.getElementById("medStatsLabel");
  if (lbl) lbl.textContent = label;
  document.querySelectorAll("#medStatsRange button").forEach(b =>
    b.classList.toggle("on", b.dataset.range === statsRange));
  const next = document.getElementById("medStatsNext");
  if (next) next.disabled = statsOffset >= 0;

  if (!total) {
    host.innerHTML = `<p class="hint">No doses ticked in ${esc(label)}.</p>`;
    return;
  }

  /* One row per medicine AS TAKEN — base and strength split apart, because
     "Lamitor OD, 100" and "Lamitor OD, 25" are the same drug at different
     doses and the table should let you see both at once. */
  const rows = [...perMed.entries()].map(([medId, r]) => {
    const { base, strength } = parseMedName(medicineName(medId));
    return { base, strength, ...r };
  }).sort((a, b) => b.total - a.total || a.base.localeCompare(b.base));

  const slotTotals = SLOTS.map(([slot]) => rows.reduce((n, r) => n + r[slot], 0));
  const perDayAvg = (total / days.length).toFixed(1);

  const summary = `
    <div class="ms-summary">
      <div class="ms-stat"><span class="ms-stat-n">${total}</span><span class="ms-stat-l">doses</span></div>
      <div class="ms-stat"><span class="ms-stat-n">${rows.length}</span><span class="ms-stat-l">medicines</span></div>
      <div class="ms-stat"><span class="ms-stat-n">${daysCovered}/${days.length}</span><span class="ms-stat-l">days with a dose</span></div>
      <div class="ms-stat"><span class="ms-stat-n">${perDayAvg}</span><span class="ms-stat-l">per day</span></div>
    </div>`;

  const legend = `<div class="ms-legend">${SLOTS.map(([slot, name], i) =>
    `<span><i style="background:${SLOT_COLOR[slot]}"></i>${name} ${slotTotals[i]}</span>`).join("")}</div>`;

  const table = `
    <div class="table-scroll">
      <table class="habit-table ms-table">
        <thead><tr>
          <th>Medicine</th><th>Strength</th>
          ${SLOTS.map(([, n]) => `<th>${n}</th>`).join("")}
          <th>Total</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="ms-med">${esc(r.base)}</td>
              <td class="ms-strength">${r.strength ? esc(r.strength) : "—"}</td>
              ${SLOTS.map(([slot]) => `<td class="ms-num ${r[slot] ? "" : "ms-zero"}">${r[slot] || "·"}</td>`).join("")}
              <td class="ms-num ms-total">${r.total}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  const series = titrationSeries();
  const titration = !series.length ? "" : `
    <div class="ms-block">
      <div class="ms-block-head">Strength over time
        <span class="hint">whole history, not just this ${statsRange}</span>
      </div>
      ${series.map(s => `
        <div class="ms-titration">
          <div class="ms-titration-head">${esc(s.base)}<span class="hint"> ${esc(s.caption)}</span></div>
          ${titrationSvg(s)}
        </div>`).join("")}
    </div>`;

  host.innerHTML = summary + legend + barsSvg(perDay) + table + titration;
}

export function setMedStatsRange(v) { statsRange = v; statsOffset = 0; renderMedStats(); }
export function shiftMedStats(n) {
  statsOffset += n;
  if (statsOffset > 0) statsOffset = 0;   // the future has no doses in it
  renderMedStats();
}
