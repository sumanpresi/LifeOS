/* Health page: notes, links, a weekly Morning/Afternoon/Night medicine
   tracker (same visual language as the habit tracker), a chronological log
   filterable by medicine name, and a simple prescriptions list. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js?v=202609042200';
import { moveToTrash } from './trash.js?v=202609042200';
import { toast } from './ui.js?v=202609042200';
import { weekDates } from './habits.js?v=202609042200';

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
  /* Stamp the DAY, not the dose. The sync merge reconciles this log a day
     at a time, so what it needs to know is "when did this device last
     touch 24 Aug" — see mergeIncomingDayLog in js/supabase.js. */
  state.health.medicineLogUpdated = state.health.medicineLogUpdated || {};
  state.health.medicineLogUpdated[dateKey] = Date.now();
  persist(); renderHealth();
}

function renderMedWeek() {
  const table = document.getElementById("medWeekTable");
  if (!table) return;
  const days = weekDates(medWeekOffset);
  const tKey = todayKey();
  const dayNames = ["M", "T", "W", "T", "F", "S", "S"];
  const meds = liveMedicines();   // archived ones keep their history, not their row
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
  const nameOf = medicineName;
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
      meds.map(m => `<option value="${m.id}" ${m.id === logFilterMed ? "selected" : ""}>${esc(m.name)}${m.archived ? " (removed)" : ""}</option>`).join("");
    sel.value = logFilterMed;
  }
}
export function setMedLogFilter(v) { logFilterMed = v; renderMedLog(); }

export function addMedicine() {
  const el = document.getElementById("newMedicine"); const v = el.value.trim(); if (!v) return;
  state.health.medicines.push({ id: uid(), name: v }); el.value = "";
  persist(); renderHealth();
}
/* ---------- a deleted medicine still has to have a name ----------

   Removing a medicine used to drop it out of state.health.medicines while
   leaving every dose it was ever ticked for behind in medicineLog. The log
   keys on the medicine id, so those rows resolved to "?" — 77 of 199 doses
   in this account, 39% of the history, unlabelled and uncountable.

   The record is now ARCHIVED rather than removed: gone from the weekly grid
   and from the add list, still present to name its own history. The Trash
   entry is still written, so Restore works exactly as before — it just
   un-archives instead of pushing a second copy back (see trash.js).

   The confirm text was always honest about this: "from view". */
export function delMedicine(id) {
  if (!confirm("Remove this medicine and its dose history from view?")) return;
  const m = state.health.medicines.find(x => x.id === id);
  if (!m) return;
  moveToTrash("medicine", m);
  m.archived = true;
  persist(); renderHealth();
}

/* The doses already orphaned by the old behaviour. Their medicines are in
   the Trash log, which holds the name — but Trash is purged after 30 days,
   so the names are on a clock. This lifts any that are still there back
   into the medicine list as archived entries, once, before they expire.

   Idempotent by construction: it only adds ids that are absent from the
   list, so running it twice adds nothing the second time. The flag is
   belt-and-braces so it doesn't scan the trash log on every boot. */
export function adoptOrphanedMedicines() {
  if (state.health.medsAdopted) return;
  state.health.medsAdopted = true;
  const known = new Set((state.health.medicines || []).map(m => m.id));
  const logged = new Set();
  Object.values(state.health.medicineLog || {}).forEach(day =>
    Object.keys(day || {}).forEach(id => logged.add(id)));
  let found = 0;
  (state.trash || []).forEach(t => {
    if (!t || t.type !== "medicine" || !t.payload || !t.payload.id) return;
    const { id, name } = t.payload;
    if (known.has(id) || !logged.has(id)) return;
    known.add(id);
    state.health.medicines.push({ id, name, archived: true });
    found++;
  });
  if (found) persist();
  return found;
}

/* The one place anything should turn a medicine id into a name. Archived
   medicines resolve normally; an id with no record left anywhere gets a
   label that says so rather than a bare "?", which read like a bug. */
export function medicineName(id) {
  const m = (state.health.medicines || []).find(x => x.id === id);
  if (m) return m.name;
  const t = (state.trash || []).find(e => e && e.type === "medicine" && e.payload && e.payload.id === id);
  return (t && t.payload.name) || "Removed medicine";
}
export function liveMedicines() { return (state.health.medicines || []).filter(m => !m.archived); }

let openPrescriptionEditId = null;
export function togglePrescriptionEdit(id) {
  openPrescriptionEditId = openPrescriptionEditId === id ? null : id;
  renderPrescriptions();
  const card = document.getElementById("prescriptionList")?.closest(".card");
  if (card) card.classList.toggle("has-open-popover", !!openPrescriptionEditId);
  if (openPrescriptionEditId) document.querySelector(`#presEdit-${id} input`)?.focus();
}
document.addEventListener("pointerdown", evt => {
  if (!openPrescriptionEditId) return;
  if (evt.target.closest(".link-edit-panel") || evt.target.closest(".link-edit-btn")) return;
  togglePrescriptionEdit(openPrescriptionEditId);
});
export function editPrescription(id, field, value) {
  const p = (state.health.prescriptions || []).find(x => x.id === id);
  if (!p) return;
  let v = String(value).trim();
  if (field === "url" && v && !/^https?:\/\//i.test(v)) v = "https://" + v;
  p[field] = v;
  persist(); renderPrescriptions();
}
function renderPrescriptions() {
  const box = document.getElementById("prescriptionList");
  if (!box) return;
  const items = [...(state.health.prescriptions || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const label = `<span class="card-head-section link-grid-label">Prescriptions</span>`;
  const rows = items.map(p => {
    const when = p.date ? ` <span class="link-row-meta">${esc(p.date)}</span>` : "";
    /* A prescription without a link is a note, not a destination — it gets
       a span, so there is no anchor to click that goes nowhere. */
    const title = p.url
      ? `<a href="${esc(/^https?:\/\//i.test(p.url) ? p.url : "https://" + p.url)}" target="_blank" rel="noopener" class="link-row-title" onclick="linkClickPulse(this)">${esc(p.name)}${when}</a>`
      : `<span class="link-row-title">${esc(p.name)}${when}</span>`;
    return `
    <div class="link-row" data-pres-id="${p.id}">
      ${title}
      <button class="link-edit-btn" onclick="togglePrescriptionEdit('${p.id}')" title="Edit">✎</button>
      <button class="del link-del-btn" onclick="delPrescription('${p.id}')" title="Delete">✕</button>
      <div class="link-edit-panel ${openPrescriptionEditId === p.id ? "open" : ""}" id="presEdit-${p.id}">
        <div class="link-edit-panel-inner">
          <input type="text" value="${esc(p.name)}" placeholder="Prescribed for / doctor" onchange="editPrescription('${p.id}','name',this.value)">
          <input type="date" value="${esc(p.date || "")}" title="Date of visit" onchange="editPrescription('${p.id}','date',this.value)">
          <input type="text" value="${esc(p.url || "")}" placeholder="Link (optional)" onchange="editPrescription('${p.id}','url',this.value)">
        </div>
      </div>
    </div>`;
  }).join("") || `<p class="hint">No prescriptions saved yet.</p>`;
  box.innerHTML = label + rows;
  box.insertAdjacentHTML("beforeend",
    `<button type="button" class="link-add-btn" title="Add prescription" aria-label="Add prescription"
       onclick="this.closest('.card').classList.toggle('adding')">+</button>`);
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
  renderHealthLinks();
  renderMedWeek();
  renderMedLog();
  renderPrescriptions();
}

/* ---------- Links and Prescriptions as pill rows ----------
   Both are the same component as Important links on My Day, down to the
   class names, so they inherit its CSS rather than carrying copies of it:
   a leading label chip, one .link-row per item with an inline ✎ panel, and
   a "+" that folds the add form away until it is wanted.

   Editing is new here. Before this, a mistyped URL or a renamed doctor
   could only be fixed by deleting the row and adding it again — which also
   put a copy in Trash for no reason. */
let openHealthLinkEditId = null;
export function toggleHealthLinkEdit(id) {
  openHealthLinkEditId = openHealthLinkEditId === id ? null : id;
  renderHealthLinks();
  /* backdrop-filter gives every .card its own stacking context, so the
     popover's z-index has no authority outside it — the card itself is
     promoted instead, exactly as toggleLinkEdit does in widgets.js. */
  const card = document.getElementById("secLinks-health")?.closest(".card");
  if (card) card.classList.toggle("has-open-popover", !!openHealthLinkEditId);
  if (openHealthLinkEditId) document.querySelector(`#healthLinkEdit-${id} input`)?.focus();
}
document.addEventListener("pointerdown", evt => {
  if (!openHealthLinkEditId) return;
  if (evt.target.closest(".link-edit-panel") || evt.target.closest(".link-edit-btn")) return;
  toggleHealthLinkEdit(openHealthLinkEditId);
});
export function editHealthLink(id, field, value) {
  const l = (state.health.links || []).find(x => x.id === id);
  if (!l) return;
  let v = String(value).trim();
  if (field === "url" && v && !/^https?:\/\//i.test(v)) v = "https://" + v;
  l[field] = v;
  persist(); rerender();
}
function renderHealthLinks() {
  const g = document.getElementById("secLinks-health");
  if (!g) return;
  const label = `<span class="card-head-section link-grid-label">Links</span>`;
  const rows = (state.health.links || []).map(l => `
    <div class="link-row" data-link-id="${l.id}">
      <a href="${esc(l.url)}" target="_blank" rel="noopener" class="link-row-title" onclick="linkClickPulse(this)">${esc(l.title)}</a>
      <button class="link-edit-btn" onclick="toggleHealthLinkEdit('${l.id}')" title="Edit link">✎</button>
      <button class="del link-del-btn" onclick="delHealthLink('${l.id}')" title="Delete">✕</button>
      <div class="link-edit-panel ${openHealthLinkEditId === l.id ? "open" : ""}" id="healthLinkEdit-${l.id}">
        <div class="link-edit-panel-inner">
          <input type="text" value="${esc(l.title)}" placeholder="Title" onchange="editHealthLink('${l.id}','title',this.value)">
          <input type="text" value="${esc(l.url)}" placeholder="https://…" onchange="editHealthLink('${l.id}','url',this.value)">
        </div>
      </div>
    </div>`).join("") || `<p class="hint">No links yet.</p>`;
  g.innerHTML = label + rows;
  g.insertAdjacentHTML("beforeend",
    `<button type="button" class="link-add-btn" title="Add link" aria-label="Add link"
       onclick="this.closest('.card').classList.toggle('adding')">+</button>`);
}

let healthTimer = null;
/* Legacy. The Notes card here is now the shared multi-note rich editor in
   sections.js, backed by state.sections.health.noteList — merge() lifted any
   old text into a first note. Kept only so a bookmarklet or an older cached
   page calling this doesn't throw; nothing in the app calls it. */
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
