/* GSI Workspace: NGDR tracker, daily work log, meeting notes, GSI links. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';
import { toast } from './ui.js';

const STATUSES = [
  ["todo", "To do"], ["progress", "In progress"], ["done", "Done"], ["blocked", "Blocked"]
];
const fmtDate = k => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

export function renderGsi() {
  const g = state.gsi;

  /* NGDR tracker */
  document.getElementById("ngdrList").innerHTML = g.ngdr.map(item => `
    <div class="task-row">
      <select class="status-sel s-${item.status}" onchange="setNgdrStatus('${item.id}',this.value)">
        ${STATUSES.map(([v, l]) => `<option value="${v}" ${item.status === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <input type="text" value="${esc(item.text)}" onchange="editNgdr('${item.id}',this.value)">
      <button class="del" onclick="delNgdr('${item.id}')">✕</button>
    </div>`).join("") || `<p class="hint">Track NGDR / UAT items here.</p>`;
  const open = g.ngdr.filter(i => i.status !== "done").length;
  document.getElementById("ngdrCount").textContent = g.ngdr.length ? `${open} open` : "";

  /* Daily work log (newest first) */
  const byDate = [...g.log].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("logList").innerHTML = byDate.map(e => `
    <div class="log-entry">
      <div class="log-date"><span>${fmtDate(e.date)}</span>
        <button class="del" style="opacity:.35" onclick="delLog('${e.id}')">✕</button></div>
      <div class="log-text">${esc(e.text)}</div>
    </div>`).join("") || `<p class="hint">Log one line per day — future-you will thank you at appraisal time.</p>`;

  /* Meetings (newest first) — now with an optional link (recording, agenda doc, etc.) */
  const meets = [...g.meetings].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("meetingList").innerHTML = meets.map(m => `
    <div class="meeting">
      <div class="meeting-top">
        <span class="log-date" style="flex-shrink:0">${fmtDate(m.date)}</span>
        <input type="text" value="${esc(m.title)}" onchange="editMeeting('${m.id}','title',this.value)">
        <button class="del" style="opacity:.35" onclick="delMeeting('${m.id}')">✕</button>
      </div>
      <textarea placeholder="Decisions, action points, who said what…"
        oninput="editMeetingNotes('${m.id}',this.value)">${esc(m.notes)}</textarea>
      <div class="meeting-link-row">
        <input type="text" placeholder="Link (agenda, recording, doc…)" value="${esc(m.link||"")}"
          onchange="editMeeting('${m.id}','link',this.value)">
        ${m.link ? `<a href="${esc(m.link.startsWith("http")?m.link:"https://"+m.link)}" target="_blank" rel="noopener" title="Open link">🔗</a>` : ""}
      </div>
    </div>`).join("") || `<p class="hint">Add a meeting to capture decisions and action points.</p>`;

  /* GSI links */
  document.getElementById("gsiLinks").innerHTML = g.links.map(l => `
    <div class="link-card">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <button class="del" onclick="delGsiLink('${l.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No links yet.</p>`;

  /* Personal & Work documents */
  const docList = (arr, delFn) => arr.map(d => `
    <div class="link-card">
      <a href="${esc(d.url.startsWith("http")?d.url:"https://"+d.url)}" target="_blank" rel="noopener">${esc(d.name)}</a>
      <button class="del" onclick="${delFn}('${d.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No documents yet.</p>`;
  const pd = document.getElementById("personalDocs");
  if (pd) pd.innerHTML = docList(g.personalDocs || [], "delPersonalDoc");
  const wd = document.getElementById("workDocs");
  if (wd) wd.innerHTML = docList(g.workDocs || [], "delWorkDoc");
}

/* ---- NGDR ---- */
export function addNgdr() {
  const el = document.getElementById("newNgdr"); const v = el.value.trim(); if (!v) return;
  state.gsi.ngdr.push({ id: uid(), text: v, status: "todo" }); el.value = "";
  persist(); rerender();
}
export function editNgdr(id, v) { const i = state.gsi.ngdr.find(x => x.id === id); if (i) { i.text = v; persist(); } }
export function setNgdrStatus(id, v) {
  const i = state.gsi.ngdr.find(x => x.id === id);
  if (i) { i.status = v; persist(); rerender(); }
}
export function delNgdr(id) { state.gsi.ngdr = state.gsi.ngdr.filter(x => x.id !== id); persist(); rerender(); }

/* ---- work log ---- */
export function addLog() {
  const el = document.getElementById("newLog"); const v = el.value.trim(); if (!v) return;
  state.gsi.log.push({ id: uid(), date: todayKey(), text: v }); el.value = "";
  persist(); rerender();
}
export function delLog(id) { state.gsi.log = state.gsi.log.filter(x => x.id !== id); persist(); rerender(); }

/* ---- meetings ---- */
export function addMeeting() {
  const el = document.getElementById("newMeeting"); const v = el.value.trim(); if (!v) return;
  state.gsi.meetings.push({ id: uid(), date: todayKey(), title: v, notes: "", link: "" }); el.value = "";
  persist(); rerender();
}
export function editMeeting(id, field, v) {
  const m = state.gsi.meetings.find(x => x.id === id);
  if (m) { m[field] = v; persist(); }
}
let meetTimers = {};
export function editMeetingNotes(id, v) {
  const m = state.gsi.meetings.find(x => x.id === id); if (!m) return;
  m.notes = v;
  clearTimeout(meetTimers[id]);
  meetTimers[id] = setTimeout(() => persist(), 800);
}
export function delMeeting(id) {
  if (!confirm("Delete this meeting note?")) return;
  state.gsi.meetings = state.gsi.meetings.filter(x => x.id !== id);
  persist(); rerender();
}

/* ---- GSI links ---- */
export function addGsiLink() {
  const t = document.getElementById("gsiLinkTitle"), u = document.getElementById("gsiLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.gsi.links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delGsiLink(id) { state.gsi.links = state.gsi.links.filter(x => x.id !== id); persist(); rerender(); }

/* ---- personal & work documents ---- */
export function addPersonalDoc() {
  const n = document.getElementById("personalDocName"), u = document.getElementById("personalDocUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and link are required");
  state.gsi.personalDocs = state.gsi.personalDocs || [];
  state.gsi.personalDocs.push({ id: uid(), name: n.value.trim(), url: u.value.trim() });
  n.value = u.value = "";
  persist(); rerender();
}
export function delPersonalDoc(id) {
  state.gsi.personalDocs = (state.gsi.personalDocs || []).filter(x => x.id !== id);
  persist(); rerender();
}
export function addWorkDoc() {
  const n = document.getElementById("workDocName"), u = document.getElementById("workDocUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and link are required");
  state.gsi.workDocs = state.gsi.workDocs || [];
  state.gsi.workDocs.push({ id: uid(), name: n.value.trim(), url: u.value.trim() });
  n.value = u.value = "";
  persist(); rerender();
}
export function delWorkDoc(id) {
  state.gsi.workDocs = (state.gsi.workDocs || []).filter(x => x.id !== id);
  persist(); rerender();
}
