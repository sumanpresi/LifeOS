/* Health page: notes, links, a weekly Morning/Afternoon/Night medicine
   tracker (same visual language as the habit tracker), a chronological log
   filterable by medicine name, and a simple prescriptions list. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';
import { moveToTrash } from './trash.js';
import { toast } from './ui.js';
import { weekDates } from './habits.js';

let medWeekOffset = 0;
let logFilterMed = "all";

function isDosed(dateKey, medId, slot) {
  return !!(state.health.medicineLog[dateKey] && state.health.medicineLog[dateKey][medId] && state.health.medicineLog[dateKey][medId][slot]);
}
export function toggleDose(dateKey, medId, slot) {
  state.health.medicineLog[dateKey] = state.health.medicineLog[dateKey] || {};
  state.health.medicineLog[dateKey][medId] = state.health.medicineLog[dateKey][medId] || {};
  const cur = state.health.medicineLog[dateKey][medId];
  cur[slot] = !cur[slot];
  persist(); renderHealth();
}

function renderMedWeek() {
  const table = document.getElementById("medWeekTable");
  if (!table) return;
  const days = weekDates(medWeekOffset);
  const tKey = todayKey();
  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  const meds = state.health.medicines || [];
  const SLOTS = [["morning", "M"], ["afternoon", "A"], ["night", "N"]];

  let html = `<tr><th>Medicine</th>${days.map((d, i) =>
    `<th class="${todayKey(d) === tKey ? "today-col" : ""}">${dayNames[i]}<br><span style="font-weight:600">${d.getDate()}</span></th>`).join("")}</tr>`;
  html += meds.map(m => `
    <tr>
      <td><span class="habit-name">${esc(m.name)}<button class="del" onclick="delMedicine('${m.id}')">✕</button></span></td>
      ${days.map(d => {
        const k = todayKey(d);
        const future = k > tKey;
        return `<td class="${k === tKey ? "today-col" : ""}"><div class="dose-cell">
          ${SLOTS.map(([slot, letter]) => `
            <button class="dose-btn ${isDosed(k, m.id, slot) ? "on" : ""}" ${future ? "disabled" : ""}
              title="${slot}" onclick="toggleDose('${k}','${m.id}','${slot}')">${letter}</button>`).join("")}
        </div></td>`;
      }).join("")}
    </tr>`).join("");
  table.innerHTML = html;
  const fmt = d => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  document.getElementById("medWeekLabel").textContent = meds.length ? `${fmt(days[0])} – ${fmt(days[6])}` : "";
}
export function shiftMedWeek(n) { medWeekOffset += n; if (medWeekOffset > 0) medWeekOffset = 0; renderMedWeek(); }

function renderMedLog() {
  const box = document.getElementById("medLogList");
  if (!box) return;
  const meds = state.health.medicines || [];
  const nameOf = id => (meds.find(m => m.id === id) || {}).name || "?";
  const dates = Object.keys(state.health.medicineLog).sort().reverse();
  const rows = [];
  dates.forEach(d => {
    Object.entries(state.health.medicineLog[d]).forEach(([medId, slots]) => {
      if (logFilterMed !== "all" && medId !== logFilterMed) return;
      const taken = Object.entries(slots).filter(([, v]) => v).map(([k]) => k);
      if (!taken.length) return;
      rows.push({ d, medId, taken });
    });
  });
  box.innerHTML = rows.slice(0, 60).map(r => `
    <div class="log-entry">
      <div class="log-date"><span>${esc(r.d)}</span></div>
      <div class="log-text"><b>${esc(nameOf(r.medId))}</b> — ${r.taken.join(", ")}</div>
    </div>`).join("") || `<p class="hint">No doses logged yet.</p>`;

  const sel = document.getElementById("medLogFilter");
  if (sel) {
    sel.innerHTML = `<option value="all">All medicines</option>` +
      meds.map(m => `<option value="${m.id}" ${m.id === logFilterMed ? "selected" : ""}>${esc(m.name)}</option>`).join("");
    sel.value = logFilterMed;
  }
}
export function setMedLogFilter(v) { logFilterMed = v; renderMedLog(); }

export function addMedicine() {
  const el = document.getElementById("newMedicine"); const v = el.value.trim(); if (!v) return;
  state.health.medicines.push({ id: uid(), name: v }); el.value = "";
  persist(); renderHealth();
}
export function delMedicine(id) {
  if (!confirm("Remove this medicine and its dose history from view?")) return;
  const m = state.health.medicines.find(x => x.id === id);
  if (m) moveToTrash("medicine", m);
  state.health.medicines = state.health.medicines.filter(x => x.id !== id);
  persist(); renderHealth();
}

function renderPrescriptions() {
  const box = document.getElementById("prescriptionList");
  if (!box) return;
  const items = [...(state.health.prescriptions || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  box.innerHTML = items.map(p => `
    <div class="fin-item">
      <span class="fin-item-name">${esc(p.name)}</span>
      <span class="fin-item-date">${p.date ? esc(p.date) : ""}</span>
      ${p.url ? `<a href="${esc(p.url.startsWith("http")?p.url:"https://"+p.url)}" target="_blank" rel="noopener" title="Open">🔗</a>` : ""}
      <button class="del" onclick="delPrescription('${p.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No prescriptions saved yet.</p>`;
}
export function addPrescription() {
  const n = document.getElementById("presName"), u = document.getElementById("presUrl"), d = document.getElementById("presDate");
  if (!n.value.trim()) return toast("Enter a name first");
  state.health.prescriptions.push({ id: uid(), name: n.value.trim(), url: u.value.trim(), date: d.value || "" });
  n.value = u.value = d.value = "";
  persist(); renderPrescriptions();
}
export function delPrescription(id) {
  const p = state.health.prescriptions.find(x => x.id === id);
  if (p) moveToTrash("prescription", p);
  state.health.prescriptions = state.health.prescriptions.filter(x => x.id !== id);
  persist(); renderPrescriptions();
}

export function renderHealth() {
  const n = document.getElementById("notes-health");
  if (n && document.activeElement !== n) n.value = state.health.notes || "";
  const g = document.getElementById("secLinks-health");
  if (g) g.innerHTML = (state.health.links || []).map(l => `
    <div class="link-card">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <button class="del" onclick="delHealthLink('${l.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No links yet.</p>`;
  renderMedWeek();
  renderMedLog();
  renderPrescriptions();
}

let healthTimer = null;
export function saveHealthNotes(v) {
  state.health.notes = v;
  clearTimeout(healthTimer);
  healthTimer = setTimeout(() => persist(), 800);
}
export function addHealthLink() {
  const t = document.getElementById("healthLinkTitle"), u = document.getElementById("healthLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.health.links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delHealthLink(id) {
  const l = state.health.links.find(x => x.id === id);
  if (l) moveToTrash("healthLink", l);
  state.health.links = state.health.links.filter(x => x.id !== id);
  persist(); rerender();
}
