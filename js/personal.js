/* Personal Workspace: multi-project task tracker for personal-life
   projects (home renovation, family trips, fitness, whatever isn't
   GSI/work). This deliberately mirrors gsi.js's pattern function-for-
   function — projects, Board/List task views, Archive, a top-level
   links card, per-project documents, and a top-level documents card —
   since that's the "same page" this was cloned from, and reusing an
   already-proven pattern beats inventing a second one.

   Two things from the GSI Workspace page were NOT cloned: the Daily
   work log and Meeting minutes (with their rich-text/grammar-check
   editors). Those are office-workflow concepts specific to GSI's own
   page, not something a personal-life workspace needs — Notes below
   covers free-form writing instead. If that's wanted later, it's a
   contained addition on top of this, not a rethink of it.

   Kept entirely separate from state.gsi and from Overview's native
   tasks — a Personal Workspace task doesn't merge into Overview's
   board and can't be moved there via a project picker, the way GSI
   tasks now can (see changeTaskProject in tasks.js). That integration
   was purpose-built for GSI's tasks specifically; wiring a second,
   parallel project system into it would roughly double that surface
   area for a feature nobody's asked for yet. Easy to add later if so. */
import { state, uid, esc, persist, rerender, touch } from './state.js';
import { isComposerOpen, composerHtml, openComposer } from './composer.js';
import { toast, autoGrow } from './ui.js';
import { moveToTrash } from './trash.js';
import { markDragJustEnded, boardColHeadHtml, isColCollapsed } from './tasks.js';
import { syncTaskToGoogle } from './google-calendar.js';

// Personal Workspace tasks use the same field names as GSI project tasks
// (date, not dueDate; status, not done) — reuses the same bridging
// approach gsi.js's syncGsiTaskToGoogle uses, rather than a third copy
// of the sync endpoint for a third task shape.
function syncPwTaskToGoogle(t, action) {
  const shim = { text: t.text, dueDate: t.date, googleEventId: t.googleEventId };
  syncTaskToGoogle(shim, action).then(() => {
    if (shim.googleEventId !== t.googleEventId) { t.googleEventId = shim.googleEventId; persist(); }
  }).catch(() => {});
}

const PW_STATUSES = [
  ["todo", "⚪ To do"], ["progress", "🔵 In progress"], ["done", "🟢 Done"], ["blocked", "🔴 Blocked"]
];

/* ---------------- Projects ---------------- */
function activePwProject() {
  return state.personal.projects.find(p => p.id === state.personal.activeProject) || state.personal.projects[0];
}

/* ---- Workspace tabs — same .wb-tab component GSI's own tabs and the
   Brainstorming Board's tabs already use. ---- */
export function choosePersonalWorkspace(id) {
  switchPwProject(id);
}
function renderPwWorkspaceTabs() {
  const list = document.getElementById("pwTabsList");
  if (!list) return;
  const active = activePwProject();
  list.innerHTML = state.personal.projects.map(p => `
    <button class="wb-tab ${p.id === active.id ? "active" : ""}" onclick="choosePersonalWorkspace('${p.id}')">
      <span class="wb-tab-name">${esc(p.name)}</span>
    </button>`).join("");
}

export function findPwProjectTask(id) {
  for (const p of state.personal.projects) {
    const t = p.tasks.find(x => x.id === id);
    if (t) return { task: t, project: p };
  }
  return { task: null, project: null };
}
// Every Personal Workspace task, flattened with its project name
// attached — same shape as gsi.js's getAllGsiTasksFlat, kept for parity
// even though nothing merges it into Overview today (see file header).
export function getAllPwTasksFlat() {
  const out = [];
  state.personal.projects.forEach(p => {
    p.tasks.forEach(t => out.push(Object.assign({}, t, { projectId: p.id, projectName: p.name })));
  });
  return out;
}

function fmtPwDate(d) {
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

let pwSortMode = "default";
let pwTaskView = null; // "board" | "list" — lazily initialized from state.pwTaskViewPref on first render
export function setPwSortMode(mode) {
  pwSortMode = mode;
  renderPwProjects();
}

/* Restoring a recently-deleted project — same convenience as GSI's
   restoreLastDeletedProject. */
export function restorePwLastDeletedProject() {
  const entry = [...state.trash].reverse().find(x => x.type === "pwProject");
  if (!entry) return;
  state.personal.projects.push(entry.payload);
  state.personal.activeProject = entry.payload.id;
  state.trash = state.trash.filter(x => x.id !== entry.id);
  persist(); renderPwProjects();
  toast(`Restored "${entry.payload.name}"`);
}
function hasPwRecentlyDeletedProject() {
  return state.trash.some(x => x.type === "pwProject");
}

function sortPwTasks(open) {
  const byFlag = (a, b) => (!!b.flag) - (!!a.flag);
  const byDate = (a, b) => (a.date || "9999").localeCompare(b.date || "9999");
  const byAlpha = (a, b) => a.text.localeCompare(b.text);
  const statusOrder = { blocked: 0, progress: 1, todo: 2, done: 3 };
  const byStatus = (a, b) => statusOrder[a.status] - statusOrder[b.status];
  switch (pwSortMode) {
    case "date": return [...open].sort(byDate);
    case "priority": return [...open].sort(byFlag);
    case "status": return [...open].sort(byStatus);
    case "alphabetical": return [...open].sort(byAlpha);
    case "newest": return [...open].reverse();
    case "oldest": return [...open];
    default: return open;
  }
}

/* ---------------- List view card ---------------- */
function pwCardHtml(item) {
  const due = fmtPwDate(item.date);
  return `
    <div class="gsi-card ${item.status === "done" ? "done" : ""}" data-task-id="${item.id}">
      <button class="gsi-chk ${item.status === "done" ? "on" : ""}" onclick="setPwTaskStatus('${item.id}','${item.status === "done" ? "todo" : "done"}')" aria-label="Toggle done">
        <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
      <div class="gsi-card-main">
        <textarea class="gsi-title" rows="1" onchange="editPwProjectTask('${item.id}','text',this.value)" oninput="autoGrow(this)">${esc(item.text)}</textarea>
        <div class="gsi-link-row">
          ${item.link
            ? `<a href="${esc(item.link.startsWith("http")?item.link:"https://"+item.link)}" target="_blank" rel="noopener" class="gsi-link-display">🔗 ${esc(item.link.replace(/^https?:\/\//,""))}</a>
               <button class="gsi-link-edit-btn" onclick="togglePwTaskLinkEdit(event,'${item.id}')" title="Edit link">✎</button>`
            : `<button class="gsi-add-link" onclick="togglePwTaskLinkEdit(event,'${item.id}')">+ Add link</button>`}
          <input type="text" class="gsi-link-input" id="pw-link-edit-${item.id}" placeholder="Paste a link…" value="${esc(item.link||"")}"
            onchange="editPwProjectTask('${item.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
        </div>
        ${due ? `<div class="gsi-date-row ${due.cls}"><span class="date-popover-wrap">
            <button class="gsi-date-display" onclick="toggleDatePopover(event,'pw-date-${item.id}')">📅 ${due.text}</button>
            <input type="date" class="gsi-date-hidden-input" id="pw-date-${item.id}" value="${esc(item.date||"")}" onchange="editPwProjectTask('${item.id}','date',this.value)">
            <div class="date-popover" id="pop-pw-date-${item.id}">
              <button onclick="setQuickDate('pw-date-${item.id}','today')">Today</button>
              <button onclick="setQuickDate('pw-date-${item.id}','tomorrow')">Tomorrow</button>
              <button onclick="setQuickDate('pw-date-${item.id}','nextweek')">Next week</button>
              <button onclick="setQuickDate('pw-date-${item.id}','clear')">Clear date</button>
            </div>
          </span></div>`
          : `<div class="gsi-date-row"><span class="date-popover-wrap">
              <button class="gsi-add-date" onclick="toggleDatePopover(event,'pw-date-${item.id}')">📅 Add date</button>
              <input type="date" class="gsi-date-hidden-input" id="pw-date-${item.id}" value="" onchange="editPwProjectTask('${item.id}','date',this.value)">
              <div class="date-popover" id="pop-pw-date-${item.id}">
                <button onclick="setQuickDate('pw-date-${item.id}','today')">Today</button>
                <button onclick="setQuickDate('pw-date-${item.id}','tomorrow')">Tomorrow</button>
                <button onclick="setQuickDate('pw-date-${item.id}','nextweek')">Next week</button>
              </div>
            </span></div>`}
      </div>
      <div class="gsi-card-right">
        <button class="gsi-flag ${item.flag ? "on" : ""}" onclick="togglePwProjectTaskFlag('${item.id}')" title="${item.flag ? "Remove priority" : "Mark high priority"}">🚩</button>
        <select class="gsi-status-sel s-${item.status}" onchange="setPwTaskStatus('${item.id}',this.value)">
          ${PW_STATUSES.map(([v, l]) => `<option value="${v}" ${item.status === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
    </div>`;
}

/* ---------------- Board view — reuses the exact same .t-board-card
   CSS classes the main Tasks module and GSI Workspace's own board
   already use, for visual consistency. ---------------- */
function pwBoardCardHtml(item) {
  const due = fmtPwDate(item.date);
  return `
    <div class="t-board-card ${item.status === "done" ? "done" : ""}${item.flag ? " flagged" : ""}" data-task-id="${item.id}"
      onclick="openTaskCardDetail('${item.id}')" role="button" tabindex="0"
      onkeydown="if(event.key==='Enter'){event.preventDefault();openTaskCardDetail('${item.id}')}">
      <div class="t-board-card-top">
        <button class="t-chk ${item.status === "done" ? "on" : ""}" onclick="event.stopPropagation();setPwTaskStatus('${item.id}','${item.status === "done" ? "todo" : "done"}')" aria-label="Toggle done">
          <svg viewBox="0 0 24 24"><path d="M4 13l5 5 11-12"/></svg></button>
        <textarea class="gsi-board-card-title pw-board-card-title" rows="1" onclick="event.stopPropagation()"
          onchange="editPwProjectTask('${item.id}','text',this.value)" oninput="autoGrow(this)">${esc(item.text)}</textarea>
        <button class="t-board-card-flag ${item.flag ? "on" : ""}" aria-pressed="${!!item.flag}"
          onclick="event.stopPropagation();togglePwProjectTaskFlag('${item.id}')"
          title="${item.flag ? "Remove priority" : "Mark high priority"}">🚩</button>
      </div>
      <div class="t-board-card-meta">
        <span class="t-board-card-date ${due && due.cls === "gsi-overdue" ? "overdue" : ""}">
          <button class="${due ? "t-due-icon" : "t-add-date-btn"}" onclick="event.stopPropagation();openPwDatePicker('${item.id}')" title="Change due date">🗓${due ? "" : " Add date"}</button>
          <input type="date" class="t-due-hidden-input" id="pw-board-date-${item.id}" value="${esc(item.date||"")}"
            onclick="event.stopPropagation()" onchange="event.stopPropagation();editPwProjectTask('${item.id}','date',this.value)">
          ${due ? due.text : ""}</span>
        ${item.link
          ? `<a href="${esc(item.link.startsWith("http")?item.link:"https://"+item.link)}" target="_blank" rel="noopener" class="t-board-card-tag" style="text-decoration:none" onclick="event.stopPropagation()">🔗 Link</a>`
          : `<button class="t-add-link-btn" onclick="togglePwTaskLinkEdit(event,'${item.id}')">+ Link</button>`}
        <input type="text" class="t-link-input" id="pw-link-edit-${item.id}" placeholder="Paste a link…" value="${esc(item.link||"")}"
          onclick="event.stopPropagation()" onchange="editPwProjectTask('${item.id}','link',this.value)" onblur="this.style.display='none'" style="display:none">
      </div>
    </div>`;
}
function pwBoardColumnHtml(statusKey, label, tasks) {
  return `
    <div class="t-board-col ${isColCollapsed("personal", statusKey) ? "t-col-collapsed" : ""}" data-board-col="${statusKey}">
      ${boardColHeadHtml("personal", statusKey, label, tasks.length)}
      <div class="t-board-col-body">
        ${tasks.length ? tasks.map(pwBoardCardHtml).join("") : `<p class="hint" style="padding:10px 4px">Nothing here.</p>`}
      </div>
      ${isComposerOpen("personal", statusKey)
        ? composerHtml("personal", statusKey)
        : `<button class="t-board-col-add" onclick="quickAddPwTask('${statusKey}')" title="Add a task to ${esc(label)}">+ Add task</button>`}
    </div>`;
}
function renderPwBoardView(tasks) {
  const byStatus = k => tasks.filter(t => t.status === k);
  return `<div class="t-board">
    ${PW_STATUSES.map(([key, label]) => pwBoardColumnHtml(key, label.replace(/^\S+\s/, ""), byStatus(key))).join("")}
  </div>`;
}
export function setPwTaskView(v) {
  pwTaskView = v;
  state.pwTaskViewPref = v;
  persist(false);
  const switcher = document.getElementById("pwTaskViewSwitch");
  if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === v));
  renderPwProjects();
}
let pwBoardSortables = [];
function destroyPwBoardSortables() {
  pwBoardSortables.forEach(s => { try { s.destroy(); } catch (e) { /* already gone with its container */ } });
  pwBoardSortables = [];
}
function initPwBoardSorting() {
  destroyPwBoardSortables();
  if (pwTaskView !== "board" || pwSortMode !== "default" || typeof Sortable === "undefined") return;
  document.querySelectorAll("#pwTaskList .t-board-col-body").forEach(container => {
    pwBoardSortables.push(Sortable.create(container, {
      group: "pw-board",
      /* Only cards are draggable. Without this Sortable treats every child
         of the column body as an item — including the "+ Add task" button
         and, now, the open composer, which could be picked up and dropped
         into another column mid-typing. */
      draggable: ".t-board-card",
      /* Whole card is the drag target, matching GSI's board. filter lists
         the controls that must keep their own behaviour rather than
         starting a drag; preventOnFilter:false lets their click/change
         events through instead of swallowing them. */
      filter: "button, input, select, textarea, a, .t-chk, .composer",
      preventOnFilter: false,
      animation: 200,
      delay: 300, delayOnTouchOnly: true, touchStartThreshold: 5,
      ghostClass: "t-row-ghost", dragClass: "t-row-dragging", chosenClass: "t-row-chosen",
      scroll: true, scrollSensitivity: 90, scrollSpeed: 12,
      onEnd: (evt) => {
        markDragJustEnded(); // the click trailing a drop must not open the task
        const taskId = evt.item.dataset.taskId;
        const toStatus = evt.to.closest(".t-board-col")?.dataset.boardCol;
        if (taskId && toStatus) setPwTaskStatus(taskId, toStatus); // already persists, syncs, and re-renders
        else renderPwProjects();
      },
    }));
  });
}

function renderPwProjects() {
  if (pwTaskView === null) {
    pwTaskView = state.pwTaskViewPref || "board";
    const switcher = document.getElementById("pwTaskViewSwitch");
    if (switcher) switcher.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === pwTaskView));
  }
  const projects = state.personal.projects;
  const active = activePwProject();
  if (active && state.personal.activeProject !== active.id) state.personal.activeProject = active.id;

  renderPwWorkspaceTabs();
  const nameEl = document.getElementById("pwProjectName");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = active.name;
  const delBtn = document.getElementById("pwProjectDelBtn");
  if (delBtn) delBtn.style.display = projects.length > 1 ? "" : "none";
  const restoreBtn = document.getElementById("pwProjectRestoreBtn");
  if (restoreBtn) restoreBtn.style.display = hasPwRecentlyDeletedProject() ? "" : "none";
  const archiveBtn = document.getElementById("pwArchiveBtn");
  if (archiveBtn) {
    const n = (active.archivedTasks || []).length;
    archiveBtn.textContent = `📦 Archive${n ? ` (${n})` : ""}`;
  }

  // Completed tasks always sink to the bottom, same convention as GSI's own board.
  const open = sortPwTasks(active.tasks.filter(t => t.status !== "done"));
  const done = active.tasks.filter(t => t.status === "done");
  const ordered = [...open, ...done];

  const listEl = document.getElementById("pwTaskList");
  if (listEl) {
    if (pwTaskView === "board") {
      // `ordered`, not active.tasks — otherwise the sort dropdown silently
      // does nothing in Board view while working fine in List view.
      listEl.innerHTML = renderPwBoardView(ordered);
    } else {
      listEl.innerHTML = ordered.map(pwCardHtml).join("") || `<div class="gsi-empty"><p>No tasks yet in ${esc(active.name)}.</p><p class="hint">Add your first task below.</p></div>`;
    }
  }
  const dragHint = document.getElementById("pwBoardDragHint");
  if (dragHint) dragHint.style.display = (pwSortMode !== "default" && pwTaskView === "board") ? "" : "none";
  initPwBoardSorting();

  const openCount = active.tasks.filter(i => i.status !== "done").length;
  const countEl = document.getElementById("pwCount");
  if (countEl) countEl.textContent = active.tasks.length ? `${openCount} open` : "";
  /* Scoped to #page-personal so this doesn't reach across and re-measure
     GSI's cards, which share the .gsi-title class. Board titles here are
     textareas (editable in place), so unlike GSI's spans they do need the
     pass — go() in ui.js repeats it once this page becomes visible, since
     anything measured while the page was display:none reads back as 0. */
  const page = document.getElementById("page-personal");
  if (page) {
    page.querySelectorAll(".gsi-title").forEach(autoGrow);
    page.querySelectorAll(".pw-board-card-title").forEach(autoGrow);
  }
}
export function openPwDatePicker(id) {
  const input = document.getElementById(`pw-board-date-${id}`);
  if (!input) return;
  if (typeof input.showPicker === "function") {
    try { input.showPicker(); return; } catch (e) { /* falls through to the older fallback below */ }
  }
  input.focus();
  input.click();
}
export function togglePwTaskLinkEdit(evt, id) {
  evt.stopPropagation();
  const input = document.getElementById("pw-link-edit-" + id);
  if (!input) return;
  input.style.display = "inline-block";
  input.focus();
}

/* ---------------- Project management ---------------- */
export function addPwProject() {
  const name = prompt("Name this project (e.g. Home renovation, Fitness, Family trip):");
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), tasks: [], workDocs: [] };
  state.personal.projects.push(p);
  state.personal.activeProject = p.id;
  persist(); renderPwProjects();
}
export function switchPwProject(id) {
  state.personal.activeProject = id;
  persist(false); renderPwProjects();
  renderPwLinksAndDocs();
}
export function renamePwProject(v) {
  const p = activePwProject(); if (!p || !v.trim()) return;
  p.name = v.trim();
  persist(); renderPwProjects();
}
export function renamePwProjectDocsLabel(v) {
  const p = activePwProject(); if (!p) return;
  p.workDocsLabel = v.trim() || "Documents";
  persist();
}
export function delPwProject() {
  if (state.personal.projects.length <= 1) return;
  const p = activePwProject();
  if (!confirm(`Delete the "${p.name}" project and all its tasks? You can restore it from Trash within 30 days.`)) return;
  moveToTrash("pwProject", p);
  state.personal.projects = state.personal.projects.filter(x => x.id !== p.id);
  state.personal.activeProject = state.personal.projects[0].id;
  persist(); renderPwProjects();
}

/* ---------------- Tasks ---------------- */
/* ---------- exposed to the shared task detail modal ---------- */

/* The modal's Project row needs a list to choose from. Personal
   workspaces only — a personal task must never be movable into a GSI
   project, because the two trees are separate on purpose and the sync,
   trash and health-check paths all assume a task stays in its own tree. */
export function getPwProjectList() {
  return (state.personal?.projects || []).map(p => ({ id: p.id, name: p.name }));
}

/* Moves a task between personal workspaces. Splices out of the old
   project's array and pushes to the new one — the task object itself is
   carried across untouched, so its id, description, subtasks and labels
   survive the move. */
/* Mirrors gsi.js's addProjectTaskRaw / pluckProjectTask so a task can be
   moved between the native Overview list and a personal workspace without
   the caller reaching into state.personal itself. */
export function addPwProjectTaskRaw(projectId, task) {
  const p = (state.personal?.projects || []).find(x => x.id === projectId);
  if (!p) return false;
  p.tasks = p.tasks || [];
  p.tasks.push(task);
  persist(); rerender();
  return true;
}
export function pluckPwProjectTask(taskId) {
  const { task: t, project: p } = findPwProjectTask(taskId);
  if (!t || !p) return null;
  p.tasks = p.tasks.filter(x => x.id !== taskId);
  return t;
}

export function changePwTaskProject(taskId, newProjectId) {
  const projects = state.personal?.projects || [];
  const from = projects.find(p => (p.tasks || []).some(t => t.id === taskId));
  const to = projects.find(p => p.id === newProjectId);
  if (!from || !to || from.id === to.id) return false;
  const i = from.tasks.findIndex(t => t.id === taskId);
  const [task] = from.tasks.splice(i, 1);
  to.tasks = to.tasks || [];
  to.tasks.push(task);
  persist(); rerender();
  toast(`Moved to "${to.name}"`);
  return true;
}

export function addPwTask() {
  const el = document.getElementById("newPwTask"); const v = el.value.trim(); if (!v) return;
  activePwProject().tasks.push({ id: uid(), text: v, status: "todo", date: "", link: "", flag: false, googleEventId: null }); el.value = "";
  persist(); rerender();
}
/* Was a native prompt(): one line of plain text, no date, no link, no
   priority, and a dialog that looks like a browser security warning.
   Now the same inline composer the GSI board uses. */
export function quickAddPwTask(statusKey) {
  openComposer("personal", statusKey);
}
export function editPwProjectTask(id, field, v) {
  const { task: t } = findPwProjectTask(id); if (!t) return;
  t[field] = v; touch(t); persist(); if (field === "text") { if (t.status !== "done") syncPwTaskToGoogle(t, t.googleEventId ? "update" : "create"); return; }
  rerender();
  if (field === "date" && t.status !== "done") {
    if (!v && t.googleEventId) syncPwTaskToGoogle(t, "delete");
    else if (v) syncPwTaskToGoogle(t, t.googleEventId ? "update" : "create");
  }
}
export function setPwTaskStatus(id, v) {
  const { task: t } = findPwProjectTask(id);
  if (t) {
    const wasDone = t.status === "done";
    t.status = v; touch(t); persist(); rerender();
    if (v === "done" && !wasDone) syncPwTaskToGoogle(t, "delete");
    else if (v !== "done" && wasDone) syncPwTaskToGoogle(t, "create");
  }
}
export function delPwProjectTask(id) {
  const { task: t, project: p } = findPwProjectTask(id); if (!t) return;
  moveToTrash("pwProjectTask", t, { projectId: p.id });
  p.tasks = p.tasks.filter(x => x.id !== id);
  persist(); rerender();
  syncPwTaskToGoogle(t, "delete");
}
export function togglePwProjectTaskFlag(id) {
  const { task: t } = findPwProjectTask(id);
  if (t) { t.flag = !t.flag; persist(); rerender(); }
}

/* ---------------- Archive ---------------- */
export function archivePwCompletedTasks() {
  const p = activePwProject();
  const completed = p.tasks.filter(t => t.status === "done");
  if (!completed.length) { toast("No completed tasks to archive"); return; }
  p.archivedTasks = p.archivedTasks || [];
  p.archivedTasks.unshift(...completed);
  p.tasks = p.tasks.filter(t => t.status !== "done");
  persist(); renderPwProjects();
  toast(`Archived ${completed.length} task${completed.length===1?"":"s"}`);
}
export function archivePwTaskEntry(projectId, taskId) {
  const p = (state.personal.projects || []).find(x => x.id === projectId);
  if (!p) return;
  const idx = p.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  const [task] = p.tasks.splice(idx, 1);
  p.archivedTasks = p.archivedTasks || [];
  p.archivedTasks.unshift(task);
  persist(); rerender();
  toast(`Archived "${task.text}"`);
}
export function openPwArchiveView() {
  const modal = document.getElementById("pwArchiveModalBg");
  if (!modal) return;
  modal.classList.add("open");
  renderPwArchiveList();
}
export function closePwArchiveView() {
  const modal = document.getElementById("pwArchiveModalBg");
  if (modal) modal.classList.remove("open");
}
function renderPwArchiveList() {
  const p = activePwProject();
  const archived = p.archivedTasks || [];
  const box = document.getElementById("pwArchiveList");
  if (!box) return;
  box.innerHTML = archived.map(t => `
    <div class="gsi-archive-row">
      <span class="gsi-archive-text">${esc(t.text)}</span>
      <div class="gsi-archive-actions">
        <button class="gsi-archive-restore" onclick="restorePwArchivedTask('${t.id}')">↺ Restore</button>
        <button class="gsi-archive-remove" onclick="removePwFromArchive('${t.id}')" title="Remove permanently">✕</button>
      </div>
    </div>`).join("") || `<p class="hint" style="padding:12px 0">Nothing archived yet — completed tasks you archive will appear here.</p>`;
}
export function restorePwArchivedTask(id) {
  const p = activePwProject();
  const archived = p.archivedTasks || [];
  const t = archived.find(x => x.id === id);
  if (!t) return;
  p.archivedTasks = archived.filter(x => x.id !== id);
  p.tasks.push(t);
  persist(); renderPwProjects(); renderPwArchiveList();
  toast("Restored to task list");
}
export function removePwFromArchive(id) {
  const p = activePwProject();
  const archived = p.archivedTasks || [];
  const t = archived.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`Permanently remove "${t.text}" from the archive? This cannot be undone.`)) return;
  p.archivedTasks = archived.filter(x => x.id !== id);
  persist(); renderPwArchiveList();
}

/* ---------------- Links, top-level docs, per-project docs ----------------
   Same shared docTabHtml-style component gsi.js's three doc lists use —
   see docTabHtml there for why (.link-card doesn't exist as a class
   anymore, this is the current one). */
let openPwDocEditId = null; // shared across all three lists here — only one popover open at a time
function pwDocTabHtml(d, nameField, urlField, editFn, delFn) {
  const name = d[nameField] || "";
  const url = d[urlField] || "";
  const fullUrl = url.startsWith("http") ? url : "https://" + url;
  return `
    <div class="link-row" data-doc-id="${d.id}">
      <a href="${esc(fullUrl)}" target="_blank" rel="noopener" class="link-row-title" onclick="linkClickPulse(this)">${esc(name)}</a>
      <button class="link-edit-btn" onclick="togglePwDocEdit('${d.id}')" title="Edit">✎</button>
      <button class="del link-del-btn" onclick="${delFn}('${d.id}')" title="Delete">✕</button>
      <div class="link-edit-panel ${openPwDocEditId === d.id ? "open" : ""}" id="pwDocEdit-${d.id}">
        <div class="link-edit-panel-inner">
          <input type="text" value="${esc(name)}" placeholder="Name" onchange="${editFn}('${d.id}','${nameField}',this.value)">
          <input type="text" value="${esc(url)}" placeholder="https://…" onchange="${editFn}('${d.id}','${urlField}',this.value)">
        </div>
      </div>
    </div>`;
}
export function togglePwDocEdit(id) {
  openPwDocEditId = openPwDocEditId === id ? null : id;
  renderPwLinksAndDocs();
  document.querySelectorAll(".card.has-open-popover").forEach(c => c.classList.remove("has-open-popover"));
  if (openPwDocEditId) {
    const panel = document.getElementById(`pwDocEdit-${openPwDocEditId}`);
    panel?.closest(".card")?.classList.add("has-open-popover"); // backdrop-filter gives every .card its own stacking context — see gsi.js's toggleDocEdit
    panel?.querySelector("input")?.focus();
  }
}
document.addEventListener("pointerdown", evt => {
  if (!openPwDocEditId) return;
  if (evt.target.closest(".link-edit-panel") || evt.target.closest(".link-edit-btn")) return;
  togglePwDocEdit(openPwDocEditId);
});
function renderPwLinksAndDocs() {
  const g = state.personal;
  const p = activePwProject();
  const labelEl = document.getElementById("pwProjectDocsLabel");
  if (labelEl && document.activeElement !== labelEl) labelEl.value = p.workDocsLabel || "Documents";
  const gl = document.getElementById("pwLinks");
  if (gl) gl.innerHTML = g.links.map(l => pwDocTabHtml(l, "title", "url", "editPwLink", "delPwLink")).join("") || `<p class="hint">No links yet.</p>`;
  const pd = document.getElementById("pwDocs");
  if (pd) pd.innerHTML = (g.docs || []).map(d => pwDocTabHtml(d, "name", "url", "editPwDoc", "delPwDoc")).join("") || `<p class="hint">No documents yet.</p>`;
  const wd = document.getElementById("pwProjectDocs");
  if (wd) wd.innerHTML = (activePwProject().workDocs || []).map(d => pwDocTabHtml(d, "name", "url", "editPwProjectDoc", "delPwProjectDoc")).join("") || `<p class="hint">No documents yet.</p>`;
}
export function undoPwLastDeleted(type) {
  const entry = state.trash.find(x => x.type === type);
  if (!entry) return;
  if (type === "pwLink") state.personal.links.unshift(entry.payload);
  else if (type === "pwDoc") { state.personal.docs = state.personal.docs || []; state.personal.docs.unshift(entry.payload); }
  else if (type === "pwProjectDoc") {
    const p = state.personal.projects.find(x => x.id === entry.meta?.projectId) || activePwProject();
    p.workDocs = p.workDocs || [];
    p.workDocs.unshift(entry.payload);
  }
  else return;
  state.trash = state.trash.filter(x => x.id !== entry.id);
  persist(); rerender();
  toast(`Restored "${entry.payload.title || entry.payload.name}"`);
}
function editPwUrlField(field, value) {
  if (field !== "url") return value.trim ? value.trim() : value;
  value = value.trim();
  return value && !/^https?:\/\//i.test(value) ? "https://" + value : value;
}
export function editPwLink(id, field, value) {
  const l = state.personal.links.find(x => x.id === id); if (!l) return;
  l[field] = editPwUrlField(field, value); persist(); rerender();
}
export function editPwDoc(id, field, value) {
  const d = (state.personal.docs || []).find(x => x.id === id); if (!d) return;
  d[field] = editPwUrlField(field, value); persist(); rerender();
}
export function editPwProjectDoc(id, field, value) {
  const d = (activePwProject().workDocs || []).find(x => x.id === id); if (!d) return;
  d[field] = editPwUrlField(field, value); persist(); rerender();
}
export function addPwLink() {
  const t = document.getElementById("pwLinkTitle"), u = document.getElementById("pwLinkUrl");
  if (!t.value.trim() || !u.value.trim()) return toast("Title and URL are required");
  let url = u.value.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  state.personal.links.push({ id: uid(), title: t.value.trim(), url });
  t.value = u.value = "";
  persist(); rerender();
}
export function delPwLink(id) {
  const l = state.personal.links.find(x => x.id === id);
  if (!l) return;
  moveToTrash("pwLink", l);
  state.personal.links = state.personal.links.filter(x => x.id !== id); persist(); rerender();
  toast(`Deleted "${l.title}"`, "Undo", "undoPwLastDeleted('pwLink')");
}
export function addPwDoc() {
  const n = document.getElementById("pwDocName"), u = document.getElementById("pwDocUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and link are required");
  state.personal.docs = state.personal.docs || [];
  state.personal.docs.push({ id: uid(), name: n.value.trim(), url: u.value.trim() });
  n.value = u.value = "";
  persist(); rerender();
}
export function delPwDoc(id) {
  const d = (state.personal.docs || []).find(x => x.id === id);
  if (!d) return;
  moveToTrash("pwDoc", d);
  state.personal.docs = (state.personal.docs || []).filter(x => x.id !== id);
  persist(); rerender();
  toast(`Deleted "${d.name}"`, "Undo", "undoPwLastDeleted('pwDoc')");
}
export function addPwProjectDoc() {
  const n = document.getElementById("pwProjectDocName"), u = document.getElementById("pwProjectDocUrl");
  if (!n.value.trim() || !u.value.trim()) return toast("Name and link are required");
  const p = activePwProject();
  p.workDocs = p.workDocs || [];
  p.workDocs.push({ id: uid(), name: n.value.trim(), url: u.value.trim() });
  n.value = u.value = "";
  persist(); rerender();
}
export function delPwProjectDoc(id) {
  const p = activePwProject();
  const d = (p.workDocs || []).find(x => x.id === id);
  if (!d) return;
  moveToTrash("pwProjectDoc", d, { projectId: p.id });
  p.workDocs = (p.workDocs || []).filter(x => x.id !== id);
  persist(); rerender();
  toast(`Deleted "${d.name}"`, "Undo", "undoPwLastDeleted('pwProjectDoc')");
}

export function renderPersonalWorkspace() {
  renderPwProjects();
  renderPwLinksAndDocs();
}
