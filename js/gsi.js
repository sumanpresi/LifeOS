/* GSI Workspace: multi-project task tracker, daily work log, structured
   meeting minutes, GSI links, personal & work documents. */
import { state, uid, esc, persist, rerender, todayKey } from './state.js';
import { toast, autoGrow } from './ui.js';
import { moveToTrash } from './trash.js';
import { checkGrammar } from './text-tools.js';
import { mountRichEditor, unmountRichEditor, getRichEditor } from './rich-text.js';


/* Formatting: Quill's own built-in toolbar (see rich-text.js) now handles
   bold/italic/lists/etc. directly on the rendered content — no separate
   markdown-insertion toolbar needed. */

const STATUSES = [
  ["todo", "⚪ To do"], ["progress", "🔵 In progress"], ["done", "🟢 Done"], ["blocked", "🔴 Blocked"]
];
const fmtDate = k => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

/* ---------------- Projects (replaces the old single NGDR list) ---------------- */
function activeProject() {
  return state.gsi.projects.find(p => p.id === state.gsi.activeProject) || state.gsi.projects[0];
}

/* ---- Workspace dropdown: UI-only wrapper around the existing project
   switcher. switchProject()/addProject() are unchanged — this only
   changes how they're presented and triggered. ---- */
export function toggleWorkspaceDropdown() {
  const panel = document.getElementById("wsDropdownPanel");
  const btn = document.querySelector("#wsDropdown .ws-dropdown-btn");
  if (!panel) return;
  const opening = !panel.classList.contains("open");
  panel.classList.toggle("open", opening);
  if (btn) btn.classList.toggle("open", opening);
  if (opening) {
    const search = document.getElementById("wsSearchInput");
    if (search) { search.value = ""; setTimeout(() => search.focus(), 0); }
    renderWorkspaceOptions("");
  }
}
export function filterWorkspaceOptions(query) { renderWorkspaceOptions(query); }
function renderWorkspaceOptions(query) {
  const box = document.getElementById("wsOptions");
  if (!box) return;
  const q = (query || "").trim().toLowerCase();
  const active = activeProject();
  const matches = state.gsi.projects.filter(p => !q || p.name.toLowerCase().includes(q));
  box.innerHTML = matches.map(p => `
    <button class="ws-option ${p.id === active.id ? "selected" : ""}" onclick="chooseWorkspace('${p.id}')">${esc(p.name)}</button>`
  ).join("") || `<p class="hint" style="padding:8px 10px">No workspaces match "${esc(query)}".</p>`;
}
export function chooseWorkspace(id) {
  switchProject(id); // existing function, unchanged
  closeWorkspaceDropdown();
}
export function addWorkspaceFromDropdown() {
  addProject(); // existing function, unchanged — creates via the same prompt() flow as before
  closeWorkspaceDropdown();
}
function closeWorkspaceDropdown() {
  const panel = document.getElementById("wsDropdownPanel");
  const btn = document.querySelector("#wsDropdown .ws-dropdown-btn");
  if (panel) panel.classList.remove("open");
  if (btn) btn.classList.remove("open");
}
document.addEventListener("click", (e) => {
  const dropdown = document.getElementById("wsDropdown");
  const panel = document.getElementById("wsDropdownPanel");
  if (dropdown && panel && panel.classList.contains("open") && !dropdown.contains(e.target)) {
    closeWorkspaceDropdown();
  }
});
/* Finds a project task by id across EVERY project, not just the active
   one — needed because these tasks are now also shown (and editable) from
   Overview's unified task list, where a task could belong to any project. */
export function findProjectTask(id) {
  for (const p of state.gsi.projects) {
    const t = p.tasks.find(x => x.id === id);
    if (t) return { task: t, project: p };
  }
  return { task: null, project: null };
}
/* Every GSI project task, flattened into one list with its project name
   attached — this is what Overview's "Work"/"All" task view merges in
   alongside its own native tasks. */
export function getAllGsiTasksFlat() {
  const out = [];
  state.gsi.projects.forEach(p => {
    p.tasks.forEach(t => out.push(Object.assign({}, t, { projectId: p.id, projectName: p.name })));
  });
  return out;
}

function fmtGsiDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(y, m - 1, day);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((dt - today) / 86400000);
  const label = dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  if (diffDays < 0) return { text: label, cls: "gsi-overdue" };
  if (diffDays === 0) return { text: "Today", cls: "gsi-today" };
  return { text: label, cls: "gsi-future" };
}

let gsiSortMode = "default";
export function setGsiSortMode(mode) {
  gsiSortMode = mode;
  renderProjects();
}

/* Archive is deliberately separate from Trash: Trash is for mistakes —
   items you meant to delete, kept temporarily in case you didn't.
   Archive is the opposite intent — completed tasks you want OUT of your
   active list but never intended to delete, kept indefinitely, with
   full selective restore. Stored per-project as p.archivedTasks. */
export function archiveCompletedTasks() {
  const p = activeProject();
  const completed = p.tasks.filter(t => t.status === "done");
  if (!completed.length) { toast("No completed tasks to archive"); return; }
  p.archivedTasks = p.archivedTasks || [];
  p.archivedTasks.unshift(...completed);
  p.tasks = p.tasks.filter(t => t.status !== "done");
  persist(); renderProjects();
  toast(`Archived ${completed.length} task${completed.length===1?"":"s"}`);
}
// Archives one specific task from one specific project — by id, not by
// "the active project," since this is also called from the Overview
// page's unified task list, where there's no such thing as an active
// GSI project. archiveCompletedTasks() above only ever handled bulk.
export function archiveGsiTaskEntry(projectId, taskId) {
  const p = (state.gsi.projects || []).find(x => x.id === projectId);
  if (!p) return;
  const idx = p.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const [task] = p.tasks.splice(idx, 1);
  p.archivedTasks = p.archivedTasks || [];
  p.archivedTasks.unshift(task);
  persist(); rerender();
  toast(`Archived "${task.text}"`);
}
export function openArchiveView() {
  const modal = document.getElementById("gsiArchiveModalBg");
  if (!modal) return;
  modal.classList.add("open");
  renderArchiveList();
}
export function closeArchiveView() {
  const modal = document.getElementById("gsiArchiveModalBg");
  if (modal) modal.classList.remove("open");
}
function renderArchiveList() {
  const p = activeProject();
  const archived = p.archivedTasks || [];
  const box = document.getElementById("gsiArchiveList");
  if (!box) return;
  box.innerHTML = archived.map(t => `
    <div class="gsi-archive-row">
      <span class="gsi-archive-text">${esc(t.text)}</span>
      <div class="gsi-archive-actions">
        <button class="gsi-archive-restore" onclick="restoreArchivedTask('${t.id}')">↺ Restore</button>
        <button class="gsi-archive-remove" onclick="removeFromArchive('${t.id}')" title="Remove permanently">✕</button>
      </div>
    </div>`).join("") || `<p class="hint" style="padding:12px 0">Nothing archived yet — completed tasks you archive will appear here.</p>`;
}
export function restoreArchivedTask(id) {
  const p = activeProject();
  const archived = p.archivedTasks || [];
  const t = archived.find(x => x.id === id);
  if (!t) return;
  p.archivedTasks = archived.filter(x => x.id !== id);
  p.tasks.push(t);
  persist(); renderProjects(); renderArchiveList();
  toast("Restored to task list");
}
export function removeFromArchive(id) {
  const p = activeProject();
  const archived = p.archivedTasks || [];
  const t = archived.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`Permanently remove "${t.text}" from the archive? This cannot be undone.`)) return;
  p.archivedTasks = archived.filter(x => x.id !== id);
  persist(); renderArchiveList();
}

/* Project delete already goes through Trash (see delProject below), so
   restoring one just needs a convenient, visible entry point — this
   shows a "Restore last deleted project" action right beside Delete
   whenever a recently-deleted project is sitting in Trash. */
export function restoreLastDeletedProject() {
  const entry = [...state.trash].reverse().find(x => x.type === "gsiProject");
  if (!entry) return;
  state.gsi.projects.push(entry.payload);
  state.gsi.activeProject = entry.payload.id;
  state.trash = state.trash.filter(x => x.id !== entry.id);
  persist(); renderProjects();
  toast(`Restored "${entry.payload.name}"`);
}
function hasRecentlyDeletedProject() {
  return state.trash.some(x => x.type === "gsiProject");
}

function sortGsiTasks(open) {
  const byFlag = (a, b) => (!!b.flag) - (!!a.flag);
  const byDate = (a, b) => (a.date || "9999") .localeCompare(b.date || "9999");
  const byAlpha = (a, b) => a.text.localeCompare(b.text);
  const statusOrder = { blocked: 0, progress: 1, todo: 2, done: 3 };
  const byStatus = (a, b) => statusOrder[a.status] - statusOrder[b.status];
  switch (gsiSortMode) {
    case "date": return [...open].sort(byDate);
    case "priority": return [...open].sort(byFlag);
    case "status": return [...open].sort(byStatus);
    case "alphabetical": return [...open].sort(byAlpha);
    case "newest": return [...open].reverse();
    case "oldest": return [...open];
    default: return open; // "default" — insertion order, as before
  }
}

function renderProjects() {
  const projects = state.gsi.projects;
  const active = activeProject();
  if (active && state.gsi.activeProject !== active.id) state.gsi.activeProject = active.id;

  const wsValue = document.getElementById("wsDropdownValue");
  if (wsValue) wsValue.textContent = active.name;
  renderWorkspaceOptions("");
  const nameEl = document.getElementById("projectName");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = active.name;
  const delBtn = document.getElementById("projectDelBtn");
  if (delBtn) delBtn.style.display = projects.length > 1 ? "" : "none";
  const restoreBtn = document.getElementById("projectRestoreBtn");
  if (restoreBtn) restoreBtn.style.display = hasRecentlyDeletedProject() ? "" : "none";
  const archiveBtn = document.getElementById("gsiArchiveBtn");
  if (archiveBtn) {
    const n = (active.archivedTasks || []).length;
    archiveBtn.textContent = `📦 Archive${n ? ` (${n})` : ""}`;
  }

  /* Completed tasks always sink to the bottom, sorted separately from
     the chosen sort mode (matches Microsoft To Do / Todoist convention:
     sort controls apply to your active work, not the completed pile). */
  const open = sortGsiTasks(active.tasks.filter(t => t.status !== "done"));
  const done = active.tasks.filter(t => t.status === "done");
  const ordered = [...open, ...done];

  document.getElementById("ngdrList").innerHTML = ordered.map(item => {
    const due = fmtGsiDate(item.date);
    return `
    <div class="gsi-card ${item.status === "done" ? "done" : ""}">
      <button class="gsi-chk ${item.status === "done" ? "on" : ""}" onclick="setTaskStatus('${item.id}','${item.status === "done" ? "todo" : "done"}')" aria-label="Toggle done">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="gsi-card-main">
        <textarea class="gsi-title" rows="1" onchange="editProjectTask('${item.id}','text',this.value)" oninput="autoGrow(this)">${esc(item.text)}</textarea>
        <div class="gsi-link-row">
          ${item.link
            ? `<a href="${esc(item.link.startsWith("http")?item.link:"https://"+item.link)}" target="_blank" rel="noopener" class="gsi-link-display">🔗 ${esc(item.link.replace(/^https?:\/\//,""))}</a>
               <button class="gsi-link-edit-btn" onclick="toggleGsiLinkEdit(event,'${item.id}')" title="Edit link">✎</button>`
            : `<button class="gsi-add-link" onclick="toggleGsiLinkEdit(event,'${item.id}')">+ Add link</button>`}
          <input type="text" class="gsi-link-input" id="gsi-link-edit-${item.id}" placeholder="Paste a link…" value="${esc(item.link||"")}"
            onchange="editProjectTask('${item.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
        </div>
        ${due ? `<div class="gsi-date-row ${due.cls}"><span class="date-popover-wrap">
            <button class="gsi-date-display" onclick="toggleDatePopover(event,'gsi-date-${item.id}')">📅 ${due.text}</button>
            <input type="date" class="gsi-date-hidden-input" id="gsi-date-${item.id}" value="${esc(item.date||"")}" onchange="editProjectTask('${item.id}','date',this.value)">
            <div class="date-popover" id="pop-gsi-date-${item.id}">
              <button onclick="setQuickDate('gsi-date-${item.id}','today')">Today</button>
              <button onclick="setQuickDate('gsi-date-${item.id}','tomorrow')">Tomorrow</button>
              <button onclick="setQuickDate('gsi-date-${item.id}','nextweek')">Next week</button>
              <button onclick="setQuickDate('gsi-date-${item.id}','clear')">Clear date</button>
            </div>
          </span></div>`
          : `<div class="gsi-date-row"><span class="date-popover-wrap">
              <button class="gsi-add-date" onclick="toggleDatePopover(event,'gsi-date-${item.id}')">📅 Add date</button>
              <input type="date" class="gsi-date-hidden-input" id="gsi-date-${item.id}" value="" onchange="editProjectTask('${item.id}','date',this.value)">
              <div class="date-popover" id="pop-gsi-date-${item.id}">
                <button onclick="setQuickDate('gsi-date-${item.id}','today')">Today</button>
                <button onclick="setQuickDate('gsi-date-${item.id}','tomorrow')">Tomorrow</button>
                <button onclick="setQuickDate('gsi-date-${item.id}','nextweek')">Next week</button>
              </div>
            </span></div>`}
      </div>
      <div class="gsi-card-right">
        <button class="gsi-flag ${item.flag ? "on" : ""}" onclick="toggleProjectTaskFlag('${item.id}')" title="${item.flag ? "Remove priority" : "Mark high priority"}">🚩</button>
        <select class="gsi-status-sel s-${item.status}" onchange="setTaskStatus('${item.id}',this.value)">
          ${STATUSES.map(([v, l]) => `<option value="${v}" ${item.status === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
    </div>`;
  }).join("") || `<div class="gsi-empty"><p>No tasks yet in ${esc(active.name)}.</p><p class="hint">Add your first task below.</p></div>`;

  const openCount = active.tasks.filter(i => i.status !== "done").length;
  document.getElementById("ngdrCount").textContent = active.tasks.length ? `${openCount} open` : "";
  // Newly-rendered textareas start at their default single-row height —
  // they don't auto-size until something measures and sets height
  // explicitly, so do that pass right after render (same pattern used
  // for Reference Library's phrase fields). If this render happened
  // while the Work·GSI page itself was hidden (e.g. during initial app
  // boot, before navigating here), this measurement will be wrong —
  // go() in ui.js re-runs this once the page actually becomes visible.
  document.querySelectorAll(".gsi-title").forEach(autoGrow);
}
export function toggleGsiLinkEdit(evt, id) {
  evt.stopPropagation();
  const input = document.getElementById("gsi-link-edit-" + id);
  if (!input) return;
  input.style.display = "inline-block";
  input.focus();
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
  if (!confirm(`Delete the "${p.name}" project and all its tasks? You can restore it from Trash within 30 days.`)) return;
  moveToTrash("gsiProject", p);
  state.gsi.projects = state.gsi.projects.filter(x => x.id !== p.id);
  state.gsi.activeProject = state.gsi.projects[0].id;
  persist(); renderProjects();
}
export function addNgdr() {
  const el = document.getElementById("newNgdr"); const v = el.value.trim(); if (!v) return;
  activeProject().tasks.push({ id: uid(), text: v, status: "todo", date: "", link: "", flag: false }); el.value = "";
  persist(); rerender();
}
export function editProjectTask(id, field, v) {
  const { task: t } = findProjectTask(id); if (!t) return;
  t[field] = v; persist(); if (field === "text") return; rerender();
}
export function setTaskStatus(id, v) {
  const { task: t } = findProjectTask(id);
  if (t) { t.status = v; persist(); rerender(); }
}
export function delProjectTask(id) {
  const { task: t, project: p } = findProjectTask(id); if (!t) return;
  moveToTrash("gsiProjectTask", t, { projectId: p.id });
  p.tasks = p.tasks.filter(x => x.id !== id);
  persist(); rerender();
}
export function toggleProjectTaskFlag(id) {
  const { task: t } = findProjectTask(id);
  if (t) { t.flag = !t.flag; persist(); rerender(); }
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
export function delLog(id) {
  const l = state.gsi.log.find(x => x.id === id);
  if (l) moveToTrash("log", l);
  state.gsi.log = state.gsi.log.filter(x => x.id !== id); persist(); renderLog();
}

/* ---------------- Meeting minutes (structured, click to expand) ---------------- */
function meetingBodyHtml(m) {
  return `
    <table class="mm-summary">
      <tr><td>Date &amp; time</td><td>
        <input type="date" value="${esc(m.date)}" onchange="editMeeting('${m.id}','date',this.value)">
        <input type="text" placeholder="e.g. 11:00 AM" value="${esc(m.time||"")}" onchange="editMeeting('${m.id}','time',this.value)">
      </td></tr>
      <tr><td>Project name</td><td><input type="text" placeholder="Project name" value="${esc(m.title)}" onchange="editMeeting('${m.id}','title',this.value)"></td></tr>
      <tr><td>Project duration</td><td><input type="text" placeholder="e.g. 3 months" value="${esc(m.duration||"")}" onchange="editMeeting('${m.id}','duration',this.value)"></td></tr>
    </table>
    <div class="mm-section">
      <label>Agenda
        <button class="expand-btn mm-expand-btn" onclick="expandView('mm-agenda-wrap-${m.id}','Agenda — ${esc(m.title)}')" title="View large">
          <svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </label>
      <div id="mm-agenda-wrap-${m.id}">
        <div id="mm-agenda-${m.id}" class="mm-rich-editor"></div>
        <div class="mm-grammar-row"><button class="mm-grammar-btn" id="gbtn-mm-agenda-${m.id}" onclick="runGrammarCheck('mm-agenda-${m.id}')">✓ Grammar check</button></div>
        <div class="grammar-results" id="grammar-mm-agenda-${m.id}"></div>
      </div>
    </div>
    <div class="mm-section">
      <label>General &amp; roundtable updates
        <button class="expand-btn mm-expand-btn" onclick="expandView('mm-updates-wrap-${m.id}','Updates — ${esc(m.title)}')" title="View large">
          <svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </label>
      <div id="mm-updates-wrap-${m.id}">
        <div id="mm-updates-${m.id}" class="mm-rich-editor"></div>
        <div class="mm-grammar-row"><button class="mm-grammar-btn" id="gbtn-mm-updates-${m.id}" onclick="runGrammarCheck('mm-updates-${m.id}')">✓ Grammar check</button></div>
        <div class="grammar-results" id="grammar-mm-updates-${m.id}"></div>
      </div>
    </div>
    <div class="mm-section">
      <label>Action items
        <button class="expand-btn mm-expand-btn" onclick="expandView('mm-actionItems-wrap-${m.id}','Action items — ${esc(m.title)}')" title="View large">
          <svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </label>
      <div id="mm-actionItems-wrap-${m.id}">
        <div id="mm-actionItems-${m.id}" class="mm-rich-editor"></div>
        <div class="mm-grammar-row"><button class="mm-grammar-btn" id="gbtn-mm-actionItems-${m.id}" onclick="runGrammarCheck('mm-actionItems-${m.id}')">✓ Grammar check</button></div>
        <div class="grammar-results" id="grammar-mm-actionItems-${m.id}"></div>
      </div>
    </div>
    <div class="meeting-link-row">
      <input type="text" placeholder="Link (agenda doc, recording…)" value="${esc(m.link||"")}" onchange="editMeeting('${m.id}','link',this.value)">
      ${m.link ? `<a href="${esc(m.link.startsWith("http")?m.link:"https://"+m.link)}" target="_blank" rel="noopener" title="Open link">🔗</a>` : ""}
    </div>
    <button class="del" style="margin-top:8px" onclick="delMeeting('${m.id}')">Delete meeting</button>`;
}

function mountMeetingEditors(m) {
  ["agenda", "updates", "actionItems"].forEach(field => {
    mountRichEditor("mm-" + field + "-" + m.id, () => m[field] || "", html => {
      m[field] = html;
      persist(); // rich-text.js already debounces text-change before calling us
    });
  });
}
function unmountMeetingEditors(m) {
  ["agenda", "updates", "actionItems"].forEach(field => unmountRichEditor("mm-" + field + "-" + m.id));
}

function renderMeetings() {
  const meets = [...state.gsi.meetings].sort((a, b) => b.date.localeCompare(a.date));
  meets.forEach(m => { if (m.open) unmountMeetingEditors(m); }); // about to rebuild their containers
  document.getElementById("meetingList").innerHTML = meets.map(m => `
    <div class="mm-card">
      <button class="mm-head" onclick="toggleMeetingOpen('${m.id}')">
        <span class="log-date">${fmtDate(m.date)}${m.time ? " · " + esc(m.time) : ""}</span>
        <span class="mm-title">${esc(m.title) || "Untitled meeting"}</span>
        <span class="mm-arw">${m.open ? "▼" : "▶"}</span>
      </button>
      <div class="mm-body" id="mmBody-${m.id}">${m.open ? meetingBodyHtml(m) : ""}</div>
    </div>`).join("") || `<p class="hint">Add a meeting to capture decisions and action points.</p>`;
  meets.forEach(m => { if (m.open) mountMeetingEditors(m); });
}

let grammarCache = {}; // richEditorId -> last-checked text, so Apply buttons use fresh offsets
export async function runGrammarCheck(richId) {
  const quill = getRichEditor(richId);
  const resultsEl = document.getElementById("grammar-" + richId);
  const btn = document.getElementById("gbtn-" + richId);
  if (!quill || !resultsEl) return;
  const text = quill.getText();
  if (!text.trim()) { toast("Nothing to check yet"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
  const matches = await checkGrammar(text);
  if (btn) { btn.disabled = false; btn.textContent = "✓ Grammar check"; }
  if (matches === null) { toast("Grammar check is temporarily unavailable — try again shortly"); return; }
  grammarCache[richId] = text;
  if (matches.length === 0) {
    resultsEl.innerHTML = `<p class="hint" style="margin:6px 0 0">No issues found. <a href="https://languagetool.org" target="_blank" rel="noopener">LanguageTool</a></p>`;
    return;
  }
  resultsEl.innerHTML = `<div class="grammar-list">` +
    matches.map((m, i) => `
      <div class="grammar-item">
        <span class="grammar-msg">${esc(m.message)}${m.original ? ` — "<b>${esc(m.original)}</b>"` : ""}</span>
        ${m.replacements.length ? m.replacements.map(r =>
          `<button class="grammar-fix-btn" onclick="applyGrammarFix('${richId}',${i},'${esc(r).replace(/'/g, "\\'")}')">→ ${esc(r)}</button>`).join("") : ""}
      </div>`).join("") +
    `</div><p class="hint" style="margin:8px 0 0">${matches.length} issue${matches.length===1?"":"s"} found — <a href="https://languagetool.org" target="_blank" rel="noopener">LanguageTool</a></p>`;
  resultsEl.dataset.matches = JSON.stringify(matches);
}
export function applyGrammarFix(richId, matchIndex, replacement) {
  const quill = getRichEditor(richId);
  const resultsEl = document.getElementById("grammar-" + richId);
  if (!quill || !resultsEl || !resultsEl.dataset.matches) return;
  if (quill.getText() !== grammarCache[richId]) { toast("Text changed since the last check — checking again"); runGrammarCheck(richId); return; }
  const matches = JSON.parse(resultsEl.dataset.matches);
  const m = matches[matchIndex]; if (!m) return;
  quill.deleteText(m.offset, m.length);
  quill.insertText(m.offset, replacement);
  runGrammarCheck(richId); // fresh offsets for any remaining issues
}
export function addMeeting() {
  const el = document.getElementById("newMeeting"); const v = el.value.trim(); if (!v) return;
  state.gsi.meetings.push({ id: uid(), date: todayKey(), time: "", title: v, duration: "", agenda: "", updates: "", actionItems: "", link: "", open: true });
  el.value = "";
  persist(); renderMeetings();
}
export function toggleMeetingOpen(id) {
  const m = state.gsi.meetings.find(x => x.id === id); if (!m) return;
  const wasOpen = m.open;
  m.open = !m.open;
  persist(false);

  const meets = [...state.gsi.meetings].sort((a, b) => b.date.localeCompare(a.date));
  const idx = meets.findIndex(x => x.id === id);
  const cards = document.querySelectorAll("#meetingList .mm-card");
  const card = cards[idx];
  if (!card) { renderMeetings(); return; } // structure drifted somehow — safe fallback
  const arw = card.querySelector(".mm-arw");
  const bodyEl = document.getElementById("mmBody-" + id);
  if (arw) arw.textContent = m.open ? "▼" : "▶";
  if (wasOpen) unmountMeetingEditors(m);
  if (bodyEl) bodyEl.innerHTML = m.open ? meetingBodyHtml(m) : "";
  if (m.open) mountMeetingEditors(m);
}
export function editMeeting(id, field, v) {
  const m = state.gsi.meetings.find(x => x.id === id);
  if (!m) return;
  m[field] = v;
  persist();
  if (field === "title" || field === "date" || field === "time") {
    // Update just the collapsed header, not the whole list — a full
    // re-render here would tear down this meeting's live rich editors.
    const meets = [...state.gsi.meetings].sort((a, b) => b.date.localeCompare(a.date));
    const idx = meets.findIndex(x => x.id === id);
    const card = document.querySelectorAll("#meetingList .mm-card")[idx];
    if (card) {
      const titleEl = card.querySelector(".mm-title");
      const dateEl = card.querySelector(".log-date");
      if (titleEl) titleEl.textContent = m.title || "Untitled meeting";
      if (dateEl) dateEl.textContent = fmtDate(m.date) + (m.time ? " · " + m.time : "");
    }
  }
}
export function delMeeting(id) {
  if (!confirm("Delete this meeting note?")) return;
  const m = state.gsi.meetings.find(x => x.id === id);
  if (m) { moveToTrash("meeting", m); if (m.open) unmountMeetingEditors(m); }
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
export function delGsiLink(id) {
  const l = state.gsi.links.find(x => x.id === id);
  if (l) moveToTrash("gsiLink", l);
  state.gsi.links = state.gsi.links.filter(x => x.id !== id); persist(); rerender();
}
export function addPersonalDoc() {
  const n = document.getElementById("personalDocName"), u = document.getElementById("personalDocUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and link are required");
  state.gsi.personalDocs = state.gsi.personalDocs || [];
  state.gsi.personalDocs.push({ id: uid(), name: n.value.trim(), url: u.value.trim() });
  n.value = u.value = "";
  persist(); rerender();
}
export function delPersonalDoc(id) {
  const d = (state.gsi.personalDocs || []).find(x => x.id === id);
  if (d) moveToTrash("personalDoc", d);
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
  const d = (state.gsi.workDocs || []).find(x => x.id === id);
  if (d) moveToTrash("workDoc", d);
  state.gsi.workDocs = (state.gsi.workDocs || []).filter(x => x.id !== id);
  persist(); rerender();
}

export function renderGsi() {
  renderProjects();
  renderLog();
  renderMeetings();
  renderLinksAndDocs();
}
