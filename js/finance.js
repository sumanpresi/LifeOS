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
