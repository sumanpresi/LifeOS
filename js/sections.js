/* Generic life-space pages: Communication, Finance, Health, Travel, Reference.
   (Work has a dedicated GSI page in gsi.js.) */
import { state, uid, esc, persist, rerender, SECTION_META } from './state.js';
import { toast } from './ui.js';

export function buildSectionPages() {
  document.getElementById("sectionPages").innerHTML =
    Object.entries(SECTION_META).map(([key, label]) => `
    <section class="page" id="page-${key}">
      <h1 class="display" style="font-size:28px;margin-bottom:14px">${label}</h1>
      <div class="grid-2">
        <div class="card"><div class="card-head"><h2>Notes</h2></div>
          <div class="card-body">
            <textarea class="notes-area" id="notes-${key}" placeholder="Everything about ${label.toLowerCase()} lives here…"
              oninput="saveSectionNotes('${key}',this.value)"></textarea>
          </div>
        </div>
        <div class="card"><div class="card-head"><h2>Links</h2></div>
          <div class="card-body">
            <div class="link-grid" id="secLinks-${key}" style="grid-template-columns:1fr"></div>
            <div class="add-inline">
              <input type="text" id="secLinkTitle-${key}" placeholder="Title">
              <input type="text" id="secLinkUrl-${key}" placeholder="https://…">
              <button class="btn btn-ghost" onclick="addSectionLink('${key}')">Add</button>
            </div>
          </div>
        </div>
      </div>
    </section>`).join("");
}

const secTimers = {};
export function saveSectionNotes(key, v) {
  state.sections[key].notes = v;
  clearTimeout(secTimers[key]);
  secTimers[key] = setTimeout(() => persist(), 800);
}

export function renderSections() {
  /* generic pages + the Work notes textarea living on the GSI page */
  for (const key of [...Object.keys(SECTION_META), "work"]) {
    const n = document.getElementById("notes-" + key);
    if (n && document.activeElement !== n) n.value = state.sections[key].notes || "";
    const g = document.getElementById("secLinks-" + key);
    if (g) g.innerHTML = (state.sections[key].links || []).map(l => `
      <div class="link-card">
        <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
        <button class="del" onclick="delSectionLink('${key}','${l.id}')">✕</button>
      </div>`).join("") || `<p class="hint">No links yet.</p>`;
  }
}
export function addSectionLink(key) {
  const t = document.getElementById("secLinkTitle-" + key), u = document.getElementById("secLinkUrl-" + key);
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.sections[key].links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delSectionLink(key, id) {
  state.sections[key].links = state.sections[key].links.filter(x => x.id !== id);
  persist(); rerender();
}
