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
import { medicineName } from './health.js?v=202609042200';
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
let hpTimelineCombo = null;  // comboKey, chosen lazily once data exists
let hpTimelineWeekOffset = 0;
/* Recent dose log defaults to hiding entries for medicines hidden from
   the tracker (see health.js's toggleMedicineHidden) — same reasoning:
   a medicine you've stopped taking shouldn't crowd out the log for what
   you're actually taking now. The dose history itself is untouched;
   this only decides what's shown here, and it's a click away either
   direction. */
let hpShowHiddenLog = false;
/* Whole-card collapse for Recent dose log — separate from hpShowHiddenLog
   above, which only ever affected the hidden-medicines sub-list. This one
   folds away the entire card (main list included) when the log itself
   isn't something the person wants taking up space on this visit. */
let hpLogCollapsed = false;

export function setHPRange(v) { hpRange = v; hpOffset = 0; renderHealthPulse(); }
export function shiftHPPeriod(n) { hpOffset += n; if (hpOffset > 0) hpOffset = 0; renderHealthPulse(); }
export function setHPMed(v) { hpMedFilter = v; hpStrengthFilter = "all"; renderHealthPulse(); }
export function setHPStrength(v) { hpStrengthFilter = v; renderHealthPulse(); }
export function setHPTimelineCombo(v) { hpTimelineCombo = v; hpTimelineWeekOffset = 0; renderHealthPulse(); }
export function shiftHPTimelineWeek(n) { hpTimelineWeekOffset += n; if (hpTimelineWeekOffset > 0) hpTimelineWeekOffset = 0; renderHealthPulse(); }
export function toggleHPHiddenLog() { hpShowHiddenLog = !hpShowHiddenLog; renderHealthPulse(); }
export function toggleHPLogCollapsed() { hpLogCollapsed = !hpLogCollapsed; renderHealthPulse(); }

/* ---------- medicine metadata, derived fresh every render ----------
   One pass over state.health.medicines turns each stored {id, name}
   into {base, strength}. Archived medicines are included (their history
   still counts) exactly as medicineName()/renderMedLog() already treat
   them elsewhere in the app. */
function medMeta() {
  return (state.health.medicines || []).map(m => {
    const { base, strength } = parseMedName(m.name);
    return { medId: m.id, name: m.name, base, strength, archived: !!m.archived, hidden: !!m.hidden, comboKey: `${base.toLowerCase()}|${strength}` };
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

/* ---------- small SVG builders ---------- */
const ICONS = {
  empty: '<path d="M9 4.5l6 6-6 6"/><circle cx="12" cy="12" r="9.2"/>'
};

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

  /* ---- Medicine timeline options ---- */
  const liveCombos = new Map();
  meta.filter(m => !m.archived).forEach(m => {
    if (!liveCombos.has(m.comboKey)) liveCombos.set(m.comboKey, m);
  });

  /* ---- Medication timeline ---- */
  const tKey = todayKey();
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
  const allLogRows = [];
  const metaByIdForLog = new Map(meta.map(m => [m.medId, m]));
  Object.keys(state.health.medicineLog || {}).sort().reverse().forEach(dateKey => {
    const entry = state.health.medicineLog[dateKey];
    Object.entries(entry || {}).forEach(([medId, slots]) => {
      const m = metaByIdForLog.get(medId);
      SLOTS.forEach(([slot, name]) => {
        if (slots && slots[slot]) allLogRows.push({ dateKey, medId, base: m ? m.base : medicineName(medId), strength: m ? m.strength : "", slotName: name, hidden: m ? m.hidden : false });
      });
    });
  });
  const logRows = allLogRows.filter(r => !r.hidden);
  /* A hidden medicine is, by definition, one that's stopped — its doses
     sit further back in time than whatever's currently active. Merging
     them into the same top-25 "recent" window meant they were pushed out
     by newer entries from visible medicines and never actually appeared
     even after clicking "Show" — clicking looked broken because the
     rows it revealed were past the cutoff. Giving hidden entries their
     OWN top-25 window, shown as its own list rather than interleaved,
     is what actually surfaces them. */
  const hiddenLogRows = allLogRows.filter(r => r.hidden);
  const hiddenLogToggle = hiddenLogRows.length
    ? `<button type="button" class="show-hidden-meds" onclick="toggleHPHiddenLog()">
        ${hpShowHiddenLog ? "Hide" : "Show"} history for hidden medicines (${hiddenLogRows.length})
      </button>`
    : "";
  const logRowHtml = r => `
          <div class="hp-logrow">
            <span class="hp-logdate">${esc(fmtDay(new Date(r.dateKey + "T00:00:00")))}</span>
            <span><i class="hp-ok">✓</i><b>${esc(comboLabel(r.base, r.strength))}</b> · ${esc(r.slotName)}</span>
            <span class="hp-dot" style="background:${colorForBase(r.base)}"></span>
          </div>`;
  const logCard = `
    <div class="hp-card hp-wide">
      <div class="hp-card-head">
        <h3>Recent dose log</h3>
        <div class="hp-card-controls">
          <span class="hint">Latest first</span>
          <button type="button" class="hp-collapse-btn" onclick="toggleHPLogCollapsed()"
            aria-expanded="${hpLogCollapsed ? "false" : "true"}" title="${hpLogCollapsed ? "Show" : "Hide"} recent dose log">
            <svg viewBox="0 0 24 24" class="${hpLogCollapsed ? "is-collapsed" : ""}"><path d="M6 9l6 6 6-6"/></svg>
            ${hpLogCollapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>
      ${hpLogCollapsed ? "" : `
      ${logRows.length ? `<div class="hp-log">${logRows.slice(0, 25).map(logRowHtml).join("")}</div>`
        : `<p class="hint">No doses logged yet.</p>`}
      ${hiddenLogToggle}
      ${hpShowHiddenLog && hiddenLogRows.length ? `<div class="hp-log hp-log-hidden">${hiddenLogRows.slice(0, 25).map(logRowHtml).join("")}</div>` : ""}
      `}
    </div>`;

  root.innerHTML = `
    <div class="hp-layout">
      ${rhythmCard}
      <div>${todCard}${distCard}</div>
    </div>
    ${timelineCard}
    ${logCard}
  `;
}
