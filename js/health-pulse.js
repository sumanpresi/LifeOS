/* ======== HEALTH PULSE ========
   A read-only analytics dashboard laid over the existing medicine tracker.
   Nothing here is a second data store: every number is computed at render
   time from state.health.medicines / state.health.medicineLog, the exact
   same source the weekly tick grid and Medicine insights table already
   use (see health.js and med-stats.js). Add a medicine, tick a dose,
   delete a medicine — this dashboard updates on the next render because
   it never cached anything to begin with.

   Strength is still parsed off the end of the medicine name (parseMedName
   in med-stats.js), not a separate stored field — that parser is the
   existing, shipped source of truth for "base drug" vs "strength", and
   splitting it into a real field would mean a data migration this file
   has no business doing. "Librax · 1/2" and "Librax · 1/4" are treated
   as distinct combinations purely by grouping on (base, strength) here.

   No Supabase calls of any kind live in this file. It reads state that
   app.js/supabase.js have already loaded and merged; it writes nothing
   back, so it cannot create a sync conflict or a duplicate payload. */
import { state, esc, todayKey } from './state.js?v=202609042200';
import { weekDates } from './habits.js?v=202609042200';
import { medicineName, liveMedicines } from './health.js?v=202609042200';
import { parseMedName } from './med-stats.js?v=202609042200';

const SLOTS = [["morning", "Morning"], ["afternoon", "Afternoon"], ["night", "Night"]];
/* Same hex values as med-stats.js's SLOT_COLOR on purpose — a dose taken
   in the morning should read as the same colour everywhere in Health. */
const SLOT_COLOR = { morning: "#2a78d6", afternoon: "#eda100", night: "#6250d6" };

/* Fixed per-medicine palette. Series colours inside SVGs/legends have to
   mean the same thing in light mode, dark mode and every named theme, so
   these are hex, not CSS variables — exactly the reasoning already
   documented next to SLOT_COLOR. Picked to sit comfortably on both a
   warm ivory panel and a dark one. */
const HP_PALETTE = [
  "#2f8f6f", "#c98a4b", "#3f7fb0", "#8a6fb0", "#b0555a",
  "#5aa6a0", "#c9a23f", "#6f8f4b", "#a05a8a", "#4b6f8f"
];
function colorForBase(base) {
  let h = 0;
  const s = String(base || "").toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HP_PALETTE[h % HP_PALETTE.length];
}

/* ---------- shared UI state ----------
   All of it is transient view state (which tab, which filter) — never
   persisted, never synced, reset to sensible defaults on reload. */
let hpRange = "week";        // "week" | "month" | "year"
let hpOffset = 0;
let hpMedFilter = "all";     // base name, lowercase-matched, or "all"
let hpStrengthFilter = "all";
let hpExpanded = new Set();  // medIds with the card expanded (medId, not comboKey — the
                              // one identifier here that's guaranteed to be an opaque
                              // uid() rather than free-text off a medicine name, so it's
                              // safe to splice into an onclick="" attribute unescaped)
let hpTimelineCombo = null;  // comboKey, chosen lazily once data exists
let hpTimelineWeekOffset = 0;

export function setHPRange(v) { hpRange = v; hpOffset = 0; renderHealthPulse(); }
export function shiftHPPeriod(n) { hpOffset += n; if (hpOffset > 0) hpOffset = 0; renderHealthPulse(); }
export function setHPMed(v) { hpMedFilter = v; hpStrengthFilter = "all"; renderHealthPulse(); }
export function setHPStrength(v) { hpStrengthFilter = v; renderHealthPulse(); }
export function toggleHPMedCard(medId) {
  if (hpExpanded.has(medId)) hpExpanded.delete(medId); else hpExpanded.add(medId);
  renderHealthPulse();
}
export function setHPTimelineCombo(v) { hpTimelineCombo = v; hpTimelineWeekOffset = 0; renderHealthPulse(); }
export function shiftHPTimelineWeek(n) { hpTimelineWeekOffset += n; if (hpTimelineWeekOffset > 0) hpTimelineWeekOffset = 0; renderHealthPulse(); }

/* ---------- medicine metadata, derived fresh every render ----------
   One pass over state.health.medicines turns each stored {id, name}
   into {base, strength}. Archived medicines are included (their history
   still counts) exactly as medicineName()/renderMedLog() already treat
   them elsewhere in the app. */
function medMeta() {
  return (state.health.medicines || []).map(m => {
    const { base, strength } = parseMedName(m.name);
    return { medId: m.id, name: m.name, base, strength, archived: !!m.archived, comboKey: `${base.toLowerCase()}|${strength}` };
  });
}
function comboLabel(base, strength) { return strength ? `${base} · ${strength}` : base; }
function strengthValue(raw) {
  if (!raw) return null;
  if (raw.includes("/")) { const [a, b] = raw.split("/"); return Number(a) / Number(b); }
  return Number(raw);
}
function matchesFilter(m, baseFilter, strengthFilter) {
  if (baseFilter !== "all" && m.base.toLowerCase() !== baseFilter.toLowerCase()) return false;
  if (strengthFilter !== "all" && m.strength !== strengthFilter) return false;
  return true;
}

/* ---------- the period on screen ---------- */
function fmtDay(d) { return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
function getBuckets(range, offset) {
  if (range === "week") {
    const days = weekDates(offset);
    return {
      type: "day",
      items: days.map(d => ({ key: todayKey(d), label: String(d.getDate()) })),
      label: `${fmtDay(days[0])} – ${fmtDay(days[6])}`
    };
  }
  if (range === "month") {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const items = [...Array(count)].map((_, i) => {
      const d = new Date(first.getFullYear(), first.getMonth(), i + 1);
      return { key: todayKey(d), label: String(d.getDate()) };
    });
    return { type: "day", items, label: first.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
  }
  // year — 12 monthly buckets
  const now = new Date();
  const year = now.getFullYear() + offset;
  const items = [...Array(12)].map((_, i) => ({
    key: `${year}-${String(i + 1).padStart(2, "0")}`,
    label: new Date(year, i, 1).toLocaleDateString("en-IN", { month: "short" })
  }));
  return { type: "month", items, label: String(year) };
}

/* ---------- aggregation ----------
   One pass over the whole dose log per call, bucketed into the on-screen
   period and filtered to whichever medicine/strength is selected. Called
   twice per render (see renderHealthPulse): once unfiltered for the KPI
   row and the medicine-distribution donut, once filtered for the rhythm
   chart, the time-of-day donut, the strength bars and the analysis
   table — so a filter never touches the cards that are meant to compare
   across every medicine. */
function aggregate(range, offset, baseFilter, strengthFilter) {
  const meta = medMeta();
  const metaById = new Map(meta.map(m => [m.medId, m]));
  const allowed = new Set(meta.filter(m => matchesFilter(m, baseFilter, strengthFilter)).map(m => m.medId));

  const { type, items, label } = getBuckets(range, offset);
  const bucketIndex = new Map(items.map((it, i) => [it.key, i]));
  const buckets = items.map(it => ({ ...it, total: 0, morning: 0, afternoon: 0, night: 0, byMed: new Map() }));

  const perMed = new Map();   // medId -> {morning,afternoon,night,total,lastDate,days:Set}
  const perBase = new Map();  // base(lower) -> {label, total}
  const perCombo = new Map(); // comboKey -> {base,strength,medId,total,days:Set,morning,afternoon,night}
  let total = 0;
  const daysWithDose = new Set();

  Object.keys(state.health.medicineLog || {}).sort().forEach(dateKey => {
    const entry = state.health.medicineLog[dateKey];
    if (!entry) return;
    const bKey = type === "month" ? dateKey.slice(0, 7) : dateKey;
    const idx = bucketIndex.get(bKey);

    Object.entries(entry).forEach(([medId, slots]) => {
      const m = metaById.get(medId);
      if (!m || !allowed.has(medId)) return;
      SLOTS.forEach(([slot]) => {
        if (!slots || !slots[slot]) return;

        if (idx !== undefined) {
          buckets[idx][slot]++; buckets[idx].total++; total++;
          buckets[idx].byMed.set(medId, (buckets[idx].byMed.get(medId) || 0) + 1);
          daysWithDose.add(dateKey);
        }

        const pm = perMed.get(medId) || { morning: 0, afternoon: 0, night: 0, total: 0, lastDate: null, days: new Set() };
        pm[slot]++; pm.total++; pm.days.add(dateKey);
        if (!pm.lastDate || dateKey > pm.lastDate) pm.lastDate = dateKey;
        perMed.set(medId, pm);

        if (idx !== undefined) {
          const baseKey = m.base.toLowerCase();
          const pb = perBase.get(baseKey) || { label: m.base, total: 0 };
          pb.total++;
          perBase.set(baseKey, pb);

          const combo = perCombo.get(m.comboKey) ||
            { base: m.base, strength: m.strength, medId, total: 0, days: new Set(), morning: 0, afternoon: 0, night: 0 };
          combo.total++; combo.days.add(dateKey); combo[slot]++;
          perCombo.set(m.comboKey, combo);
        }
      });
    });
  });

  return { type, items: buckets, label, total, perMed, perBase, perCombo, daysCovered: daysWithDose.size, periodLength: items.length, meta, metaById };
}

/* Longest and current consecutive-day streaks across the WHOLE history —
   independent of the on-screen period, the way a streak should be. */
function computeStreaks() {
  const dated = Object.keys(state.health.medicineLog || {}).filter(k => {
    const entry = state.health.medicineLog[k];
    return entry && Object.values(entry).some(slots => SLOTS.some(([s]) => slots && slots[s]));
  }).sort();
  if (!dated.length) return { current: 0, longest: 0 };
  const set = new Set(dated);

  let longest = 0, run = 0, prev = null;
  dated.forEach(dk => {
    const d = new Date(dk + "T00:00:00");
    run = prev && Math.round((d - prev) / 86400000) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
  });

  let cur = 0;
  const cursor = new Date(todayKey() + "T00:00:00");
  if (!set.has(todayKey(cursor))) cursor.setDate(cursor.getDate() - 1); // today not logged yet is not a broken streak
  while (set.has(todayKey(cursor))) { cur++; cursor.setDate(cursor.getDate() - 1); }
  return { current: cur, longest };
}

/* Trailing 7 real days (today inclusive), independent of the range
   selector — used for both KPI sparklines so they read as "recent
   activity" rather than jumping around with the Week/Month/Year tabs. */
function trailingDoses(n) {
  const out = [];
  const cursor = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(cursor); d.setDate(cursor.getDate() - i);
    const key = todayKey(d);
    const entry = state.health.medicineLog[key];
    let count = 0;
    if (entry) Object.values(entry).forEach(slots => SLOTS.forEach(([s]) => { if (slots && slots[s]) count++; }));
    out.push({ key, count });
  }
  return out;
}

/* ---------- small SVG builders ---------- */
function icon(pathD) {
  return `<span class="hp-kpi-icon"><svg viewBox="0 0 24 24">${pathD}</svg></span>`;
}
const ICONS = {
  pill: '<path d="M4.5 14.5l6-6a4.24 4.24 0 0 1 6 6l-6 6a4.24 4.24 0 0 1-6-6z"/><path d="M8 8l8 8"/>',
  pulse: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
  flame: '<path d="M12 2s5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 1-3s1 2 3 2a2.5 2.5 0 0 0 1-4.7C10 5 9 3.5 9 2c0 0-6 4-6 10a9 9 0 0 0 18 0c0-6-9-10-9-10z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  waves: '<path d="M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  pieChart: '<path d="M12 3v9l7.5 4.3A9 9 0 1 1 12 3z"/><path d="M12 3a9 9 0 0 1 9 9h-9z"/>',
  bars: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5M12 7v5l3 2"/>',
  empty: '<path d="M9 4.5l6 6-6 6"/><circle cx="12" cy="12" r="9.2"/>'
};

/* A ring built from stroke-dasharray, same technique the habit donut in
   index.html already uses, just parameterised. pct is clamped so a
   filter that momentarily makes today "busier than usual" never draws
   past a full circle. */
function ringSvg(pct, size = 64, thickness = 8) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  return `<svg class="hp-ring" viewBox="0 0 ${size} ${size}">
    <circle class="hp-ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${thickness}"/>
    <circle class="hp-ring-val" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${thickness}"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - clamped)).toFixed(1)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>
  </svg>`;
}

/* Multi-segment donut. segments = [{value,color,label}]. An empty/zero
   total draws a flat track rather than a divide-by-zero arc, and the
   caller is expected to show its own empty copy alongside it. */
function donutSvg(segments, size = 150, thickness = 16) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((n, s) => n + s.value, 0);
  const mid = size / 2;
  if (!total) {
    return `<svg class="hp-donut-svg" viewBox="0 0 ${size} ${size}">
      <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${thickness}"/>
    </svg>`;
  }
  let offset = 0, arcs = "";
  segments.forEach(s => {
    if (!s.value) return;
    const frac = s.value / total;
    arcs += `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}"
      stroke-dasharray="${(frac * c).toFixed(1)} ${c.toFixed(1)}" stroke-dashoffset="${(-offset * c).toFixed(1)}"
      stroke-linecap="butt"><title>${esc(s.label)} — ${s.value}</title></circle>`;
    offset += frac;
  });
  return `<svg class="hp-donut-svg" viewBox="0 0 ${size} ${size}"><g transform="rotate(-90 ${mid} ${mid})">${arcs}</g></svg>`;
}

/* Stacked bar chart, multicoloured by medicine so the shape of "who
   contributed to this day" is visible at a glance — this is the "by
   medicine name" view the rhythm chart is meant to give, with the
   filter narrowing it to one medicine (a single-colour series) when
   set. */
function rhythmSvg(agg) {
  const items = agg.items;
  const n = items.length;
  const max = Math.max(1, ...items.map(b => b.total));
  const W = 860, H = 210, left = 30, right = 8, top = 10, base = H - 28;
  const span = (W - left - right) / n;
  const bw = Math.max(2, Math.min(30, span - (n > 20 ? 2 : 10)));
  const scale = (base - top) / max;

  const medTotals = new Map();
  items.forEach(b => b.byMed.forEach((v, id) => medTotals.set(id, (medTotals.get(id) || 0) + v)));
  const medIds = [...medTotals.keys()].sort((a, b) => medTotals.get(b) - medTotals.get(a));

  let bars = "";
  items.forEach((b, i) => {
    const x = left + i * span + (span - bw) / 2;
    let y = base;
    medIds.forEach(id => {
      const v = b.byMed.get(id) || 0;
      if (!v) return;
      const h = v * scale;
      y -= h;
      const m = agg.metaById.get(id);
      const color = colorForBase(m ? m.base : "");
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="2"><title>${esc(m ? comboLabel(m.base, m.strength) : "")} — ${v} on ${esc(b.label)}</title></rect>`;
    });
  });

  const step = n <= 10 ? 1 : n <= 12 ? 1 : 5;
  let ticks = "";
  items.forEach((it, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    const x = left + i * span + span / 2;
    ticks += `<text class="hp-tick" x="${x.toFixed(1)}" y="${base + 17}" text-anchor="middle">${esc(it.label)}</text>`;
  });

  const svg = `<svg class="hp-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Doses per period, coloured by medicine">
    <line class="hp-axis" x1="${left}" y1="${base}" x2="${W - right}" y2="${base}"/>
    <text class="hp-tick" x="${left - 5}" y="${top + 4}" text-anchor="end">${max}</text>
    <text class="hp-tick" x="${left - 5}" y="${base}" text-anchor="end">0</text>
    ${bars}${ticks}
  </svg>`;

  const legend = medIds.slice(0, 8).map(id => {
    const m = agg.metaById.get(id);
    const label = m ? comboLabel(m.base, m.strength) : "";
    return `<span><i style="background:${colorForBase(m ? m.base : "")}"></i>${esc(label)} <b>${medTotals.get(id)}</b></span>`;
  }).join("");
  const more = medIds.length > 8 ? `<span class="hint">+${medIds.length - 8} more</span>` : "";

  return svg + (medIds.length ? `<div class="hp-legend">${legend}${more}</div>` : "");
}

/* ---------- render ---------- */
export function renderHealthPulse() {
  const root = document.getElementById("healthPulseRoot");
  if (!root) return;

  const meta = medMeta();
  const live = liveMedicines();

  if (!meta.length) {
    root.innerHTML = `
      <div class="hp-card hp-empty">
        <svg viewBox="0 0 24 24">${ICONS.empty}</svg>
        <h3>No medicines yet</h3>
        <p>Add one in the tracker below and Health Pulse will start charting it automatically.</p>
      </div>`;
    return;
  }

  const overall = aggregate(hpRange, hpOffset, "all", "all");
  const filtered = aggregate(hpRange, hpOffset, hpMedFilter, hpStrengthFilter);
  const streaks = computeStreaks();
  const recent7 = trailingDoses(7);
  const recentMax = Math.max(1, ...recent7.map(d => d.count));
  /* All-time per-combo totals for the medicine cards' expanded view — a
     third, unbounded aggregate so "all-time" really means all-time
     regardless of which Week/Month/Year tab is active on screen. */
  const allTimeStats = aggregateAllTime();

  /* ---- Today's medication ---- */
  const tKey = todayKey();
  const todayEntry = state.health.medicineLog[tKey] || {};
  let todayCount = 0;
  const todayLines = [];
  live.forEach(m => {
    const slots = todayEntry[m.id];
    if (!slots) return;
    const taken = SLOTS.filter(([s]) => slots[s]).map(([, n]) => n);
    if (!taken.length) return;
    todayCount += taken.length;
    const { base, strength } = parseMedName(m.name);
    todayLines.push(`<div class="hp-medline"><span class="hp-check">✓</span>${esc(comboLabel(base, strength))}</div><div class="hint" style="margin:-2px 0 4px 21px">${esc(taken.join(", "))}</div>`);
  });
  const last7ExclToday = recent7.slice(0, -1);
  const avgRecent = last7ExclToday.length ? last7ExclToday.reduce((n, d) => n + d.count, 0) / last7ExclToday.length : 0;
  const todayPct = avgRecent > 0 ? todayCount / avgRecent : (todayCount > 0 ? 1 : 0);

  const kpiToday = `
    <div class="hp-kpi">
      <div class="hp-kpi-title"><span>Today's medication</span>${icon(ICONS.pill)}</div>
      <div class="hp-kpi-row">
        <div class="hp-ring-wrap">${ringSvg(todayPct)}<div class="hp-ring-label">${todayCount}</div></div>
        <div class="hp-medlines">${todayLines.length ? todayLines.join("") : `<span class="hint">No doses logged yet today.</span>`}</div>
      </div>
    </div>`;

  const kpiActive = `
    <div class="hp-kpi">
      <div class="hp-kpi-title"><span>Active medicines</span>${icon(ICONS.pulse)}</div>
      <div class="hp-big">${live.length}<span class="hp-unit">medicine${live.length === 1 ? "" : "s"}</span></div>
      <div class="hp-sub">${overall.total} dose${overall.total === 1 ? "" : "s"} in ${esc(overall.label)}</div>
      <div class="hp-bars">${recent7.map(d => `<i style="height:${Math.max(8, (d.count / recentMax) * 100)}%" title="${esc(d.key)}: ${d.count}"></i>`).join("")}</div>
    </div>`;

  const kpiStreak = `
    <div class="hp-kpi">
      <div class="hp-kpi-title"><span>Consistency</span>${icon(ICONS.flame)}</div>
      <div class="hp-big">${streaks.current}<span class="hp-unit">day${streaks.current === 1 ? "" : "s"}</span></div>
      <div class="hp-sub">Current streak · longest ${streaks.longest}</div>
      <div class="hp-bars">${recent7.map(d => `<i style="height:${Math.max(8, (d.count / recentMax) * 100)}%"></i>`).join("")}</div>
    </div>`;

  const perDayAvg = overall.periodLength ? (overall.total / overall.periodLength).toFixed(1) : "0";
  const kpiPeriod = `
    <div class="hp-kpi">
      <div class="hp-kpi-title"><span>${esc(overall.label)}</span>${icon(ICONS.calendar)}</div>
      <div class="hp-big">${overall.daysCovered}<span class="hp-unit">/ ${overall.periodLength} days</span></div>
      <div class="hp-sub">${perDayAvg} dose${perDayAvg === "1.0" ? "" : "s"} per day on average</div>
    </div>`;

  /* ---- filter dropdown option lists ---- */
  const bases = [...new Map(meta.map(m => [m.base.toLowerCase(), m.base])).values()].sort((a, b) => a.localeCompare(b));
  const strengthsForCurrentBase = [...new Set(
    meta.filter(m => hpMedFilter === "all" || m.base.toLowerCase() === hpMedFilter.toLowerCase())
      .map(m => m.strength).filter(Boolean)
  )].sort((a, b) => (strengthValue(a) ?? 0) - (strengthValue(b) ?? 0));

  const medFilterSelect = `<select class="hp-select" onchange="setHPMed(this.value)">
    <option value="all">All medicines</option>
    ${bases.map(b => `<option value="${esc(b)}" ${hpMedFilter.toLowerCase() === b.toLowerCase() ? "selected" : ""}>${esc(b)}</option>`).join("")}
  </select>`;
  const strengthFilterSelect = strengthsForCurrentBase.length ? `<select class="hp-select" onchange="setHPStrength(this.value)">
    <option value="all">All strengths</option>
    ${strengthsForCurrentBase.map(s => `<option value="${esc(s)}" ${hpStrengthFilter === s ? "selected" : ""}>${esc(s)}</option>`).join("")}
  </select>` : "";

  /* ---- Medication rhythm ---- */
  const rhythmCard = `
    <div class="hp-card">
      <div class="hp-card-head">
        <h3>Medication rhythm</h3>
        <div class="hp-card-controls">
          ${medFilterSelect}${strengthFilterSelect}
          <span class="seg">
            <button class="${hpRange === "week" ? "on" : ""}" onclick="setHPRange('week')">Week</button>
            <button class="${hpRange === "month" ? "on" : ""}" onclick="setHPRange('month')">Month</button>
            <button class="${hpRange === "year" ? "on" : ""}" onclick="setHPRange('year')">Year</button>
          </span>
          <span class="week-nav">
            <button onclick="shiftHPPeriod(-1)" aria-label="Earlier"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
            <span class="week-label">${esc(filtered.label)}</span>
            <button onclick="shiftHPPeriod(1)" aria-label="Later" ${hpOffset >= 0 ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
          </span>
        </div>
      </div>
      ${filtered.total ? rhythmSvg(filtered) : `<p class="hint">No doses ticked in ${esc(filtered.label)}${hpMedFilter !== "all" ? ` for ${esc(comboLabel(hpMedFilter, hpStrengthFilter !== "all" ? hpStrengthFilter : ""))}` : ""}.</p>`}
    </div>`;

  /* ---- Doses by time of day ---- */
  const slotTotals = SLOTS.map(([slot]) => filtered.items.reduce((n, b) => n + b[slot], 0));
  const todDonut = donutSvg(SLOTS.map(([slot, name], i) => ({ value: slotTotals[i], color: SLOT_COLOR[slot], label: name })));
  const todCard = `
    <div class="hp-card">
      <div class="hp-card-head"><h3>Doses by time of day</h3></div>
      <div class="hp-donutwrap">
        <div class="hp-donut-center">${todDonut}<div class="hp-donut-text"><b>${filtered.total}</b><span>doses</span></div></div>
        <div class="hp-legend" style="flex-direction:column">
          ${SLOTS.map(([slot, name], i) => `<span><i style="background:${SLOT_COLOR[slot]}"></i>${name}<b style="margin-left:auto">${slotTotals[i]}</b></span>`).join("")}
        </div>
      </div>
    </div>`;

  /* ---- Medicine distribution (always unfiltered — comparing across medicines) ---- */
  const baseRows = [...overall.perBase.values()].sort((a, b) => b.total - a.total);
  const distDonut = donutSvg(baseRows.map(r => ({ value: r.total, color: colorForBase(r.label), label: r.label })));
  const distCard = `
    <div class="hp-card">
      <div class="hp-card-head"><h3>Medicine distribution</h3><span class="hint">${esc(overall.label)}</span></div>
      ${overall.total ? `<div class="hp-donutwrap">
        <div class="hp-donut-center">${distDonut}<div class="hp-donut-text"><b>${overall.total}</b><span>doses</span></div></div>
        <div class="hp-legend" style="flex-direction:column">
          ${baseRows.slice(0, 6).map(r => `<span><i style="background:${colorForBase(r.label)}"></i>${esc(r.label)}<b style="margin-left:auto">${Math.round(r.total / overall.total * 100)}% (${r.total})</b></span>`).join("")}
        </div>
      </div>` : `<p class="hint">No doses ticked in ${esc(overall.label)}.</p>`}
    </div>`;

  /* ---- Dose distribution by strength (respects the shared filter) ---- */
  const comboRows = [...filtered.perCombo.values()].sort((a, b) => b.total - a.total);
  const strengthMax = Math.max(1, ...comboRows.map(r => r.total));
  const strengthCard = `
    <div class="hp-card">
      <div class="hp-card-head"><h3>Dose distribution by strength</h3></div>
      ${comboRows.length ? `<div class="hp-strength">
        ${comboRows.slice(0, 10).map(r => `
          <div class="hp-srow">
            <span class="hp-srow-label">${esc(r.strength || "—")}</span>
            <div class="hp-track"><div class="hp-fill" style="width:${Math.max(4, r.total / strengthMax * 100)}%;background:${colorForBase(r.base)}"></div></div>
            <b>${r.total}</b>
          </div>`).join("")}
      </div>` : `<p class="hint">Nothing to show yet for this filter.</p>`}
    </div>`;

  /* ---- Medicine + strength analysis table ---- */
  const analysisCard = `
    <div class="hp-card hp-wide">
      <div class="hp-card-head"><h3>Medicine + strength analysis</h3><span class="hint">${esc(filtered.label)}</span></div>
      ${comboRows.length ? `<div class="table-scroll"><table class="hp-table">
        <thead><tr><th>Medicine</th><th>Strength</th><th>Doses</th><th>Days taken</th>
          ${SLOTS.map(([, n]) => `<th>${n}</th>`).join("")}<th>Last taken</th></tr></thead>
        <tbody>
          ${comboRows.map(r => `
            <tr>
              <td><span class="hp-dot" style="background:${colorForBase(r.base)}"></span><span class="hp-medname">${esc(r.base)}</span></td>
              <td class="hp-strengthtext">${r.strength ? esc(r.strength) : "—"}</td>
              <td class="hp-num">${r.total}</td>
              <td class="hp-num">${r.days.size}</td>
              ${SLOTS.map(([slot]) => `<td class="hp-num">${r[slot] || "·"}</td>`).join("")}
              <td>${esc([...r.days].sort().pop() || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table></div>` : `<p class="hint">No doses ticked in ${esc(filtered.label)} for this filter.</p>`}
    </div>`;

  /* ---- Medicine cards ---- */
  const liveCombos = new Map();
  meta.filter(m => !m.archived).forEach(m => {
    if (!liveCombos.has(m.comboKey)) liveCombos.set(m.comboKey, m);
  });
  const cardsHtml = [...liveCombos.values()].map(m => {
    const combo = filtered.perCombo.get(m.comboKey);
    const total = combo ? combo.total : 0;
    const days = combo ? combo.days.size : 0;
    const morning = combo ? combo.morning : 0, afternoon = combo ? combo.afternoon : 0, night = combo ? combo.night : 0;
    const isOpen = hpExpanded.has(m.medId);
    const allTimeCombo = allTimeStats.perCombo.get(m.comboKey);
    return `
    <div class="hp-medcard ${isOpen ? "is-open" : ""}" onclick="toggleHPMedCard('${m.medId}')">
      <div class="hp-medcard-head">
        <span class="hp-dot" style="background:${colorForBase(m.base)}"></span>${esc(m.base)}
        <span class="hp-medcard-strength">${m.strength ? esc(m.strength) : ""}</span>
      </div>
      <div class="hp-medcard-big">${total}<span class="hp-unit" style="font-size:11px"> doses</span></div>
      <div class="hp-medcard-sub">${days} day${days === 1 ? "" : "s"} · ${esc(filtered.label)}</div>
      <div class="hp-medcard-slots">
        <div>M<b>${morning}</b></div><div>A<b>${afternoon}</b></div><div>N<b>${night}</b></div>
      </div>
      <div class="hp-medcard-expand"><div class="hp-medcard-expand-inner">
        <div><span>All-time doses</span><b>${allTimeCombo ? allTimeCombo.total : 0}</b></div>
        <div><span>Days taken (all-time)</span><b>${allTimeCombo ? allTimeCombo.days.size : 0}</b></div>
        <div><span>Last taken</span><b>${allTimeCombo && allTimeCombo.days.size ? esc([...allTimeCombo.days].sort().pop()) : "—"}</b></div>
      </div></div>
    </div>`;
  }).join("");
  const medCardsCard = `
    <div class="hp-card hp-wide">
      <div class="hp-card-head"><h3>Your medicines</h3><span class="hint">Tap a card for its full history</span></div>
      ${cardsHtml || `<p class="hint">No active medicines right now.</p>`}
    </div>`;

  /* ---- Medication timeline ---- */
  const timelineOptions = [...liveCombos.values()];
  if (!hpTimelineCombo || !timelineOptions.some(m => m.comboKey === hpTimelineCombo)) {
    hpTimelineCombo = timelineOptions[0] ? timelineOptions[0].comboKey : null;
  }
  const timelineDays = weekDates(hpTimelineWeekOffset);
  const tlMed = timelineOptions.find(m => m.comboKey === hpTimelineCombo);
  const timelineCard = `
    <div class="hp-card">
      <div class="hp-card-head">
        <h3>Medication timeline</h3>
        <div class="hp-card-controls">
          <select class="hp-select" onchange="setHPTimelineCombo(this.value)">
            ${timelineOptions.map(m => `<option value="${esc(m.comboKey)}" ${m.comboKey === hpTimelineCombo ? "selected" : ""}>${esc(comboLabel(m.base, m.strength))}</option>`).join("")}
          </select>
          <span class="week-nav">
            <button onclick="shiftHPTimelineWeek(-1)" aria-label="Previous week"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
            <span class="week-label">${fmtDay(timelineDays[0])} – ${fmtDay(timelineDays[6])}</span>
            <button onclick="shiftHPTimelineWeek(1)" aria-label="Next week" ${hpTimelineWeekOffset >= 0 ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
          </span>
        </div>
      </div>
      ${tlMed ? `<div class="hp-timeline">
        ${timelineDays.map(d => {
    const key = todayKey(d);
    const slots = (state.health.medicineLog[key] || {})[tlMed.medId] || {};
    const dayName = d.toLocaleDateString("en-IN", { weekday: "short" });
    return `<div class="hp-day ${key === tKey ? "is-today" : ""}">
            <div class="hp-day-name">${dayName}</div>
            <div class="hp-day-num">${d.getDate()}</div>
            ${SLOTS.map(([slot, name]) => `<div class="hp-dose" style="${slots[slot] ? `background:${SLOT_COLOR[slot]}` : ""}" title="${name}"></div><div class="hp-day-slot">${name[0]}</div>`).join("")}
          </div>`;
  }).join("")}
      </div>` : `<p class="hint">No medicines to show a timeline for yet.</p>`}
    </div>`;

  /* ---- Recent dose log ---- */
  const logRows = [];
  const metaByIdForLog = new Map(meta.map(m => [m.medId, m]));
  Object.keys(state.health.medicineLog || {}).sort().reverse().forEach(dateKey => {
    const entry = state.health.medicineLog[dateKey];
    Object.entries(entry || {}).forEach(([medId, slots]) => {
      const m = metaByIdForLog.get(medId);
      SLOTS.forEach(([slot, name]) => {
        if (slots && slots[slot]) logRows.push({ dateKey, medId, base: m ? m.base : medicineName(medId), strength: m ? m.strength : "", slotName: name });
      });
    });
  });
  const logCard = `
    <div class="hp-card hp-wide">
      <div class="hp-card-head"><h3>Recent dose log</h3><span class="hint">Latest first</span></div>
      ${logRows.length ? `<div class="hp-log">
        ${logRows.slice(0, 25).map(r => `
          <div class="hp-logrow">
            <span class="hp-logdate">${esc(fmtDay(new Date(r.dateKey + "T00:00:00")))}</span>
            <span><i class="hp-ok">✓</i><b>${esc(comboLabel(r.base, r.strength))}</b> · ${esc(r.slotName)}</span>
            <span class="hp-dot" style="background:${colorForBase(r.base)}"></span>
          </div>`).join("")}
      </div>` : `<p class="hint">No doses logged yet.</p>`}
    </div>`;

  root.innerHTML = `
    <div class="hp-hero">
      <div class="hp-hero-text">
        <h2>Health Pulse</h2>
        <p>Your health at a glance — calculated automatically from your recorded doses.</p>
      </div>
    </div>
    <div class="hp-cards4">${kpiToday}${kpiActive}${kpiStreak}${kpiPeriod}</div>
    <div class="hp-layout">
      ${rhythmCard}
      <div>${todCard}${distCard}</div>
    </div>
    ${strengthCard}
    ${analysisCard}
    ${medCardsCard}
    ${timelineCard}
    ${logCard}
  `;
}

/* Unbounded version of aggregate(): no period window, so it always
   reflects the medicine's entire recorded history. Kept separate from
   aggregate() rather than adding an "all time" range option there,
   because every other consumer of aggregate() (KPIs, rhythm chart,
   donuts) genuinely wants a bounded period. */
function aggregateAllTime() {
  const metaById = new Map(medMeta().map(m => [m.medId, m]));
  const perCombo = new Map();
  Object.keys(state.health.medicineLog || {}).forEach(dateKey => {
    const entry = state.health.medicineLog[dateKey];
    Object.entries(entry || {}).forEach(([medId, slots]) => {
      const m = metaById.get(medId);
      if (!m) return;
      SLOTS.forEach(([slot]) => {
        if (!slots || !slots[slot]) return;
        const combo = perCombo.get(m.comboKey) || { total: 0, days: new Set() };
        combo.total++; combo.days.add(dateKey);
        perCombo.set(m.comboKey, combo);
      });
    });
  });
  return { perCombo };
}
