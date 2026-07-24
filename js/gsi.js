/* GSI Workspace: multi-project task tracker, daily work log, structured
   meeting minutes, GSI links, personal & work documents. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';
import { toast, autoGrow } from './ui.js';

const STATUSES = [
  ["todo", "To do"], ["progress", "In progress"], ["done", "Done"], ["blocked", "Blocked"]
];
const fmtDate = k => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

/* ---------------- Projects (replaces the old single NGDR list) ---------------- */
function activeProject() {
  return state.gsi.projects.find(p => p.id === state.gsi.activeProject) || state.gsi.projects[0];
}

function renderProjects() {
  const projects = state.gsi.projects;
  const active = activeProject();
  if (active && state.gsi.activeProject !== active.id) state.gsi.activeProject = active.id;

  const tabs = document.getElementById("projectTabs");
  if (tabs) {
    tabs.innerHTML = projects.map(p => `
      <button class="tab ${p.id === active.id ? "active" : ""}" onclick="switchProject('${p.id}')">${esc(p.name)}</button>`).join("")
      + `<button class="tab tab-add" onclick="addProject()" title="New project">＋</button>`;
  }
  const nameEl = document.getElementById("projectName");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = active.name;
  const delBtn = document.getElementById("projectDelBtn");
  if (delBtn) delBtn.style.display = projects.length > 1 ? "" : "none";

  /* Completed tasks always sink to the bottom. */
  const open = active.tasks.filter(t => t.status !== "done");
  const done = active.tasks.filter(t => t.status === "done");
  const ordered = [...open, ...done];

  document.getElementById("ngdrList").innerHTML = ordered.map(item => `
    <div class="task-row ${item.status === "done" ? "done" : ""}">
      <select class="status-sel s-${item.status}" onchange="setTaskStatus('${item.id}',this.value)">
        ${STATUSES.map(([v, l]) => `<option value="${v}" ${item.status === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <input type="text" value="${esc(item.text)}" onchange="editProjectTask('${item.id}','text',this.value)">
      <input type="date" class="task-due-input" value="${esc(item.date||"")}" onchange="editProjectTask('${item.id}','date',this.value)" title="Date">
      <button class="del" onclick="delProjectTask('${item.id}')">✕</button>
    </div>`).join("") || `<p class="hint">Track this project's tasks here.</p>`;
  const openCount = active.tasks.filter(i => i.status !== "done").length;
  document.getElementById("ngdrCount").textContent = active.tasks.length ? `${openCount} open` : "";
}

export function addProject() {
  const name = prompt("Name this project (e.g. NGDR, BISAG-N Integration, Field Survey):");
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), tasks: [] };
  state.gsi.projects.push(p);
  state.gsi.activeProject = p.id;
  persist(); renderProjects();
}
export function switchProject(id) {
  state.gsi.activeProject = id;
  persist(false); renderProjects();
}
export function renameProject(v) {
  const p = activeProject(); if (!p || !v.trim()) return;
  p.name = v.trim();
  persist(); renderProjects();
}
export function delProject() {
  if (state.gsi.projects.length <= 1) return;
  const p = activeProject();
  if (!confirm(`Delete the "${p.name}" project and all its tasks? This cannot be undone.`)) return;
  state.gsi.projects = state.gsi.projects.filter(x => x.id !== p.id);
  state.gsi.activeProject = state.gsi.projects[0].id;
  persist(); renderProjects();
}
export function addNgdr() {
  const el = document.getElementById("newNgdr"); const v = el.value.trim(); if (!v) return;
  activeProject().tasks.push({ id: uid(), text: v, status: "todo", date: "" }); el.value = "";
  persist(); renderProjects();
}
export function editProjectTask(id, field, v) {
  const t = activeProject().tasks.find(x => x.id === id); if (!t) return;
  t[field] = v; persist(); if (field === "text") return; renderProjects();
}
export function setTaskStatus(id, v) {
  const t = activeProject().tasks.find(x => x.id === id);
  if (t) { t.status = v; persist(); renderProjects(); }
}
export function delProjectTask(id) {
  const p = activeProject();
  p.tasks = p.tasks.filter(x => x.id !== id);
  persist(); renderProjects();
}

/* ---------------- Daily work log ---------------- */
function renderLog() {
  const byDate = [...state.gsi.log].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("logList").innerHTML = byDate.map(e => `
    <div class="log-entry">
      <div class="log-date"><span>${fmtDate(e.date)}</span>
        <button class="del" style="opacity:.35" onclick="delLog('${e.id}')">✕</button></div>
      <div class="log-text">${esc(e.text)}</div>
    </div>`).join("") || `<p class="hint">Log one line per day — future-you will thank you at appraisal time.</p>`;
}
export function addLog() {
  const el = document.getElementById("newLog"); const v = el.value.trim(); if (!v) return;
  state.gsi.log.push({ id: uid(), date: todayKey(), text: v }); el.value = "";
  persist(); renderLog();
}
export function delLog(id) { state.gsi.log = state.gsi.log.filter(x => x.id !== id); persist(); renderLog(); }

/* ---------------- Meeting minutes (structured, click to expand) ---------------- */
function renderMeetings() {
  const meets = [...state.gsi.meetings].sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("meetingList").innerHTML = meets.map(m => `
    <div class="mm-card">
      <button class="mm-head" onclick="toggleMeetingOpen('${m.id}')">
        <span class="log-date">${fmtDate(m.date)}${m.time ? " · " + esc(m.time) : ""}</span>
        <span class="mm-title">${esc(m.title) || "Untitled meeting"}</span>
        <span class="mm-arw">${m.open ? "▼" : "▶"}</span>
      </button>
      ${m.open ? `
      <div class="mm-body">
        <table class="mm-summary">
          <tr><td>Date &amp; time</td><td>
            <input type="date" value="${esc(m.date)}" onchange="editMeeting('${m.id}','date',this.value)">
            <input type="text" placeholder="e.g. 11:00 AM" value="${esc(m.time||"")}" onchange="editMeeting('${m.id}','time',this.value)">
          </td></tr>
          <tr><td>Project name</td><td><input type="text" placeholder="Project name" value="${esc(m.title)}" onchange="editMeeting('${m.id}','title',this.value)"></td></tr>
          <tr><td>Project duration</td><td><input type="text" placeholder="e.g. 3 months" value="${esc(m.duration||"")}" onchange="editMeeting('${m.id}','duration',this.value)"></td></tr>
        </table>
        <div class="mm-section">
          <label>Agenda</label>
          <textarea placeholder="What this meeting covers…" oninput="editMeetingText('${m.id}','agenda',this.value);autoGrow(this)">${esc(m.agenda||"")}</textarea>
        </div>
        <div class="mm-section">
          <label>General &amp; roundtable updates</label>
          <textarea placeholder="Updates from each participant…" oninput="editMeetingText('${m.id}','updates',this.value);autoGrow(this)">${esc(m.updates||"")}</textarea>
        </div>
        <div class="mm-section">
          <label>Action items</label>
          <textarea placeholder="Who does what, by when…" oninput="editMeetingText('${m.id}','actionItems',this.value);autoGrow(this)">${esc(m.actionItems||"")}</textarea>
        </div>
        <div class="meeting-link-row">
          <input type="text" placeholder="Link (agenda doc, recording…)" value="${esc(m.link||"")}" onchange="editMeeting('${m.id}','link',this.value)">
          ${m.link ? `<a href="${esc(m.link.startsWith("http")?m.link:"https://"+m.link)}" target="_blank" rel="noopener" title="Open link">🔗</a>` : ""}
        </div>
        <button class="del" style="margin-top:8px" onclick="delMeeting('${m.id}')">Delete meeting</button>
      </div>` : ""}
    </div>`).join("") || `<p class="hint">Add a meeting to capture decisions and action points.</p>`;
  document.querySelectorAll("#meetingList .mm-section textarea").forEach(autoGrow);
}
export function addMeeting() {
  const el = document.getElementById("newMeeting"); const v = el.value.trim(); if (!v) return;
  state.gsi.meetings.push({ id: uid(), date: todayKey(), time: "", title: v, duration: "", agenda: "", updates: "", actionItems: "", link: "", open: true });
  el.value = "";
  persist(); renderMeetings();
}
export function toggleMeetingOpen(id) {
  const m = state.gsi.meetings.find(x => x.id === id); if (!m) return;
  m.open = !m.open;
  persist(false); renderMeetings();
}
export function editMeeting(id, field, v) {
  const m = state.gsi.meetings.find(x => x.id === id);
  if (m) { m[field] = v; persist(); renderMeetings(); }
}
let meetTimers = {};
export function editMeetingText(id, field, v) {
  const m = state.gsi.meetings.find(x => x.id === id); if (!m) return;
  m[field] = v;
  clearTimeout(meetTimers[id + field]);
  meetTimers[id + field] = setTimeout(() => persist(), 800);
}
export function delMeeting(id) {
  if (!confirm("Delete this meeting note?")) return;
  state.gsi.meetings = state.gsi.meetings.filter(x => x.id !== id);
  persist(); renderMeetings();
}

/* ---------------- GSI links, personal & work documents ---------------- */
function renderLinksAndDocs() {
  const g = state.gsi;
  document.getElementById("gsiLinks").innerHTML = g.links.map(l => `
    <div class="link-card">
      <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <button class="del" onclick="delGsiLink('${l.id}')">✕</button>
    </div>`).join("") || `<p class="hint">No links yet.</p>`;

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
export function addGsiLink() {
  const t = document.getElementById("gsiLinkTitle"), u = document.getElementById("gsiLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.gsi.links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delGsiLink(id) { state.gsi.links = state.gsi.links.filter(x => x.id !== id); persist(); rerender(); }
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

export function renderGsi() {
  renderProjects();
  renderLog();
  renderMeetings();
  renderLinksAndDocs();
}
