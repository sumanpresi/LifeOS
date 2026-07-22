/* Communication workspace: email templates, draft pad, follow-up tracker, links.
   Built on the same pattern as gsi.js — its own state slice (state.communication),
   its own hand-written page (#page-communication), the shared persist()/sync model. */
import { state, uid, esc, persist, rerender } from './state.js';
import { toast } from './ui.js';

/* Follow-up statuses reuse the GSI status keys (todo/progress/done) on purpose,
   so the existing .s-todo / .s-progress / .s-done colours apply for free. */
const FU_STATUS = [["todo", "Pending"], ["progress", "Waiting"], ["done", "Completed"]];

export function renderCommunication() {
  const c = state.communication;

  /* ---- Email templates ---- */
  document.getElementById("templateList").innerHTML = c.templates.map(t => `
    <div class="card" style="margin-bottom:12px">
      <div class="meeting-top">
        <input type="text" value="${esc(t.title)}" onchange="editTemplate('${t.id}','title',this.value)">
        <input type="text" value="${esc(t.category || "")}" placeholder="Category" style="max-width:140px"
          onchange="editTemplate('${t.id}','category',this.value)">
        <button class="btn btn-ghost" onclick="useTemplate('${t.id}')">Use</button>
        <button class="del" onclick="delTemplate('${t.id}')">✕</button>
      </div>
      <textarea placeholder="Template body…" oninput="editTemplateBody('${t.id}',this.value)">${esc(t.body)}</textarea>
    </div>`).join("") || `<p class="hint">Save reusable email templates — click Use to start a draft from one.</p>`;

  /* ---- Draft pad (newest first) ---- */
  const drafts = [...c.drafts].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  document.getElementById("draftList").innerHTML = drafts.map(d => `
    <div class="card" style="margin-bottom:12px">
      <div class="meeting-top">
        <input type="text" value="${esc(d.subject)}" placeholder="Subject"
          onchange="editDraft('${d.id}','subject',this.value)">
        <button class="del" onclick="delDraft('${d.id}')">✕</button>
      </div>
      <input type="text" value="${esc(d.to || "")}" placeholder="To…"
        style="width:100%;margin-bottom:8px" onchange="editDraft('${d.id}','to',this.value)">
      <textarea placeholder="Write your email…" oninput="editDraftBody('${d.id}',this.value)">${esc(d.body)}</textarea>
    </div>`).join("") || `<p class="hint">No drafts yet — click “New draft” or start one from a template.</p>`;

  /* ---- Follow-up tracker ---- */
  document.getElementById("followUpList").innerHTML = c.followUps.map(f => `
    <div class="meeting">
      <div class="meeting-top">
        <select class="status-sel s-${f.status}" onchange="setFollowUpStatus('${f.id}',this.value)">
          ${FU_STATUS.map(([v, l]) => `<option value="${v}" ${f.status === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <input type="text" value="${esc(f.title)}" onchange="editFollowUp('${f.id}','title',this.value)">
        <button class="del" onclick="delFollowUp('${f.id}')">✕</button>
      </div>
      <div class="add-inline" style="margin-top:8px">
        <input type="text" value="${esc(f.person || "")}" placeholder="Person / office"
          onchange="editFollowUp('${f.id}','person',this.value)">
        <input type="date" value="${esc(f.due || "")}" onchange="editFollowUp('${f.id}','due',this.value)">
      </div>
      <textarea placeholder="Notes…" oninput="editFollowUpNotes('${f.id}',this.value)">${esc(f.notes || "")}</textarea>
    </div>`).join("") || `<p class="hint">Track who owes you a reply and by when.</p>`;

  /* ---- Link cards ---- */
  document.getElementById("commLinks").innerHTML = c.links.map(l => `
    <div class="link-card">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <button class="del" onclick="delCommLink('${l.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No links yet.</p>`;

  /* ---- Stats line ---- */
  const pending = c.followUps.filter(f => f.status !== "done").length;
  document.getElementById("commStats").innerHTML =
    `<span class="streak">${c.templates.length}</span> templates ·
     <span class="streak">${c.drafts.length}</span> drafts ·
     <span class="streak">${pending}</span> pending follow-ups ·
     <span class="streak">${c.links.length}</span> links`;
}

/* ---- templates ---- */
export function addTemplate() {
  const t = document.getElementById("newTemplateTitle");
  const cat = document.getElementById("newTemplateCat");
  if (!t.value.trim()) return toast("Template needs a title");
  state.communication.templates.push({ id: uid(), title: t.value.trim(), category: cat.value.trim(), body: "", tags: [] });
  t.value = cat.value = "";
  persist(); rerender();
}
export function editTemplate(id, field, v) {
  const t = state.communication.templates.find(x => x.id === id);
  if (t) { t[field] = v; persist(); }
}
const tplTimers = {};
export function editTemplateBody(id, v) {
  const t = state.communication.templates.find(x => x.id === id); if (!t) return;
  t.body = v;
  clearTimeout(tplTimers[id]);
  tplTimers[id] = setTimeout(() => persist(), 800);   /* debounce keystrokes, like gsi meeting notes */
}
export function delTemplate(id) {
  state.communication.templates = state.communication.templates.filter(x => x.id !== id);
  persist(); rerender();
}
export function useTemplate(id) {
  const t = state.communication.templates.find(x => x.id === id); if (!t) return;
  state.communication.drafts.unshift({ id: uid(), subject: t.title, to: "", body: t.body, updated: Date.now() });
  persist(); rerender();
  toast("Draft started from template");
  const el = document.getElementById("draftList");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---- drafts ---- */
export function addDraft() {
  state.communication.drafts.unshift({ id: uid(), subject: "", to: "", body: "", updated: Date.now() });
  persist(); rerender();
}
export function editDraft(id, field, v) {
  const d = state.communication.drafts.find(x => x.id === id);
  if (d) { d[field] = v; d.updated = Date.now(); persist(); }
}
const draftTimers = {};
export function editDraftBody(id, v) {
  const d = state.communication.drafts.find(x => x.id === id); if (!d) return;
  d.body = v; d.updated = Date.now();
  clearTimeout(draftTimers[id]);
  draftTimers[id] = setTimeout(() => persist(), 800);
}
export function delDraft(id) {
  if (!confirm("Delete this draft?")) return;
  state.communication.drafts = state.communication.drafts.filter(x => x.id !== id);
  persist(); rerender();
}

/* ---- follow-ups ---- */
export function addFollowUp() {
  const el = document.getElementById("newFollowUp"); const v = el.value.trim(); if (!v) return;
  state.communication.followUps.push({ id: uid(), title: v, person: "", due: "", status: "todo", notes: "" });
  el.value = "";
  persist(); rerender();
}
export function editFollowUp(id, field, v) {
  const f = state.communication.followUps.find(x => x.id === id);
  if (f) { f[field] = v; persist(); }
}
export function setFollowUpStatus(id, v) {
  const f = state.communication.followUps.find(x => x.id === id);
  if (f) { f.status = v; persist(); rerender(); }
}
const fuTimers = {};
export function editFollowUpNotes(id, v) {
  const f = state.communication.followUps.find(x => x.id === id); if (!f) return;
  f.notes = v;
  clearTimeout(fuTimers[id]);
  fuTimers[id] = setTimeout(() => persist(), 800);
}
export function delFollowUp(id) {
  state.communication.followUps = state.communication.followUps.filter(x => x.id !== id);
  persist(); rerender();
}

/* ---- links ---- */
export function addCommLink() {
  const t = document.getElementById("commLinkTitle"), u = document.getElementById("commLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.communication.links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delCommLink(id) {
  state.communication.links = state.communication.links.filter(x => x.id !== id);
  persist(); rerender();
}
