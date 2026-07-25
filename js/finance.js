/* Finance page: notes, links, and three simple tracked lists —
   Grocery, Shopping, Wishlist — each with a date and an optional link. */
import { state, uid, esc, persist, rerender } from './state.js';
import { moveToTrash } from './trash.js';
import { toast } from './ui.js';

const LISTS = ["grocery", "shopping", "wishlist"];

function renderList(key) {
  const box = document.getElementById("fin-" + key + "-list");
  if (!box) return;
  const items = state.finance[key] || [];
  box.innerHTML = items.map(it => `
    <div class="fin-item">
      <input type="text" class="fin-item-name-edit" value="${esc(it.name)}" onchange="editFinanceItem('${key}','${it.id}','name',this.value)">
      <input type="date" class="fin-item-date-edit" value="${esc(it.date||"")}" onchange="editFinanceItem('${key}','${it.id}','date',this.value)">
      <input type="text" class="fin-item-link-edit" placeholder="link" value="${esc(it.link||"")}" onchange="editFinanceItem('${key}','${it.id}','link',this.value)">
      ${it.link ? `<a href="${esc(it.link.startsWith("http")?it.link:"https://"+it.link)}" target="_blank" rel="noopener" title="Open link">🔗</a>` : ""}
      <button class="del" onclick="delFinanceItem('${key}','${it.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No items yet.</p>`;
}

export function renderFinance() {
  const n = document.getElementById("notes-finance");
  if (n && document.activeElement !== n) n.value = state.finance.notes || "";
  const g = document.getElementById("secLinks-finance");
  if (g) g.innerHTML = (state.finance.links || []).map(l => `
    <div class="link-card">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <button class="del" onclick="delFinanceLink('${l.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No links yet.</p>`;
  LISTS.forEach(renderList);
  renderEmiTable();
}

let finTimer = null;
export function saveFinanceNotes(v) {
  state.finance.notes = v;
  clearTimeout(finTimer);
  finTimer = setTimeout(() => persist(), 800);
}
export function addFinanceLink() {
  const t = document.getElementById("finLinkTitle"), u = document.getElementById("finLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.finance.links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delFinanceLink(id) {
  const l = state.finance.links.find(x => x.id === id);
  if (l) moveToTrash("financeLink", l);
  state.finance.links = state.finance.links.filter(x => x.id !== id);
  persist(); rerender();
}

export function addFinanceItem(key) {
  const n = document.getElementById("fin-" + key + "-name");
  const d = document.getElementById("fin-" + key + "-date");
  const l = document.getElementById("fin-" + key + "-link");
  if (!n.value.trim()) return toast("Enter a name first");
  state.finance[key].push({ id: uid(), name: n.value.trim(), date: d.value || "", link: l.value.trim() });
  n.value = ""; d.value = ""; l.value = "";
  persist(); renderList(key);
}
export function editFinanceItem(key, id, field, v) {
  const it = state.finance[key].find(x => x.id === id);
  if (!it) return;
  it[field] = v;
  persist();
}
export function delFinanceItem(key, id) {
  const it = state.finance[key].find(x => x.id === id);
  if (it) moveToTrash("financeItem", it, { listKey: key });
  state.finance[key] = state.finance[key].filter(x => x.id !== id);
  persist(); renderList(key);
}

/* ---------- Expense & EMI Tracker ---------- */
// Remaining Amount and Months Remaining are formulas, not stored values —
// computed fresh against today's date on every render, exactly like a
// real spreadsheet recalculates rather than caching a stale answer.
function monthsRemaining(endDate) {
  if (!endDate) return null;
  const end = new Date(endDate + "T00:00:00");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (end <= today) return 0;
  let months = (end.getFullYear() - today.getFullYear()) * 12 + (end.getMonth() - today.getMonth());
  if (end.getDate() < today.getDate()) months -= 1;
  return Math.max(0, months);
}
function remainingAmount(monthlyAmount, months) {
  if (months === null) return null;
  return (parseFloat(monthlyAmount) || 0) * months;
}
function fmtInr(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function emiTable() { return state.finance.emiTable; }

function dropdownCell(row, field, options) {
  return `<select onchange="editEmiRow('${row.id}','${field}',this.value)">
    <option value=""></option>
    ${options.map(o => `<option value="${esc(o)}" ${row[field] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}
  </select>`;
}

export function renderEmiTable() {
  const t = emiTable();
  const tbody = document.getElementById("emiTableBody");
  if (!tbody) return;

  let totalMonthly = 0, totalRemaining = 0;
  tbody.innerHTML = t.rows.map((r, i) => {
    const mr = monthsRemaining(r.endDate);
    const ra = remainingAmount(r.monthlyAmount, mr);
    totalMonthly += parseFloat(r.monthlyAmount) || 0;
    if (ra !== null) totalRemaining += ra;
    return `
    <tr>
      <td class="emi-srno">${i + 1}</td>
      <td><input type="text" value="${esc(r.expense || "")}" onchange="editEmiRow('${r.id}','expense',this.value)" placeholder="Expense name"></td>
      <td><input type="number" step="0.01" value="${r.monthlyAmount || ""}" onchange="editEmiRow('${r.id}','monthlyAmount',this.value)" placeholder="0.00"></td>
      <td><input type="date" value="${esc(r.startDate || "")}" onchange="editEmiRow('${r.id}','startDate',this.value)"></td>
      <td><input type="date" value="${esc(r.endDate || "")}" onchange="editEmiRow('${r.id}','endDate',this.value)"></td>
      <td class="emi-formula-cell">${fmtInr(ra)}</td>
      <td class="emi-formula-cell">${mr === null ? "" : mr}</td>
      <td>${dropdownCell(r, "bank", t.banks)}</td>
      <td>${dropdownCell(r, "term", t.terms)}</td>
      <td>${dropdownCell(r, "status", t.statuses)}</td>
      <td><input type="text" value="${esc(r.notes || "")}" onchange="editEmiRow('${r.id}','notes',this.value)" placeholder="Notes"></td>
      <td><button class="del" onclick="delEmiRow('${r.id}')" aria-label="Delete row">✕</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="11" class="hint" style="text-align:center;padding:18px">No rows yet — add your first expense or EMI below.</td></tr>`;

  const totalsRow = document.getElementById("emiTotalsRow");
  if (totalsRow) {
    totalsRow.innerHTML = `
      <td></td><td>Total</td><td>${fmtInr(totalMonthly)}</td><td></td><td></td>
      <td>${fmtInr(totalRemaining)}</td><td></td><td></td><td></td><td></td><td></td>`;
  }
}

export function addEmiRow() {
  emiTable().rows.push({ id: uid(), expense: "", monthlyAmount: "", startDate: "", endDate: "", bank: "", term: "", status: "", notes: "" });
  persist(); renderEmiTable();
}
export function editEmiRow(id, field, v) {
  const r = emiTable().rows.find(x => x.id === id);
  if (!r) return;
  r[field] = v;
  persist();
  renderEmiTable(); // formulas depend on monthlyAmount/endDate — recompute the whole table so totals stay correct too
}
export function delEmiRow(id) {
  const r = emiTable().rows.find(x => x.id === id);
  if (!r) return;
  moveToTrash("emiRow", r);
  emiTable().rows = emiTable().rows.filter(x => x.id !== id);
  persist(); renderEmiTable();
}

/* ---------- Manage dropdown options (Bank / Term / Status) ---------- */
const DROPDOWN_LABELS = { banks: "Bank", terms: "Term", statuses: "Status" };
export function openEmiDropdownManager() {
  document.getElementById("emiDropdownModalBg").classList.add("open");
  renderDropdownManager();
}
export function closeEmiDropdownManager() {
  document.getElementById("emiDropdownModalBg").classList.remove("open");
}
function renderDropdownManager() {
  const t = emiTable();
  const box = document.getElementById("emiDropdownManagerBody");
  if (!box) return;
  box.innerHTML = Object.keys(DROPDOWN_LABELS).map(listName => `
    <div class="emi-dd-group">
      <h4>${DROPDOWN_LABELS[listName]}</h4>
      ${t[listName].map(v => `
        <div class="emi-dd-row">
          <input type="text" value="${esc(v)}" onchange="renameEmiDropdownOption('${listName}','${esc(v)}',this.value)">
          <button onclick="deleteEmiDropdownOption('${listName}','${esc(v)}')" aria-label="Delete option">✕</button>
        </div>`).join("")}
      <button class="emi-dd-add" onclick="addEmiDropdownOption('${listName}')">+ Add ${DROPDOWN_LABELS[listName].toLowerCase()}</button>
    </div>`).join("");
}
export function addEmiDropdownOption(listName) {
  const v = prompt(`New ${DROPDOWN_LABELS[listName].toLowerCase()}:`);
  if (!v || !v.trim()) return;
  const t = emiTable();
  if (t[listName].includes(v.trim())) return toast("Already exists");
  t[listName].push(v.trim());
  persist(); renderDropdownManager(); renderEmiTable();
}
export function renameEmiDropdownOption(listName, oldV, newV) {
  if (!newV.trim() || oldV === newV.trim()) { renderDropdownManager(); return; }
  const t = emiTable();
  const idx = t[listName].indexOf(oldV);
  if (idx === -1) return;
  t[listName][idx] = newV.trim();
  // Any row currently using the old value follows the rename, rather than
  // silently pointing at a value that no longer exists in the list.
  const field = listName === "banks" ? "bank" : listName === "terms" ? "term" : "status";
  t.rows.forEach(r => { if (r[field] === oldV) r[field] = newV.trim(); });
  persist(); renderDropdownManager(); renderEmiTable();
}
export function deleteEmiDropdownOption(listName, v) {
  const t = emiTable();
  const field = listName === "banks" ? "bank" : listName === "terms" ? "term" : "status";
  const inUse = t.rows.some(r => r[field] === v);
  if (inUse && !confirm(`"${v}" is used by one or more rows. Remove it from the list anyway? Those rows will show a blank ${field} until you pick a new value.`)) return;
  t[listName] = t[listName].filter(x => x !== v);
  if (inUse) t.rows.forEach(r => { if (r[field] === v) r[field] = ""; });
  persist(); renderDropdownManager(); renderEmiTable();
}
